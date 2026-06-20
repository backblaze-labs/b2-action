import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SCRIPT_PATH = 'scripts/full-lockfile-audit.mjs'
const HEARTBEAT_SCRIPT_PATH = 'scripts/full-lockfile-audit-heartbeat.mjs'

describe('full-lockfile audit script', () => {
  it('fails fast on a deterministic advisory finding', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'b2-audit-advisory-'))
    try {
      const fixture = join(tempDir, 'advisory.mjs')
      const counter = join(tempDir, 'count.txt')
      const output = join(tempDir, 'audit-output.txt')
      const githubOutput = join(tempDir, 'github-output.txt')
      await writeFixture(fixture, counter, {
        exitStatus: 1,
        stdout:
          'high severity vulnerability in build-tool from https://registry.npmjs.org/build-tool\n',
      })

      const result = runAuditFixture(fixture, output, githubOutput)

      expect(result.status).toBe(1)
      expect(await readFile(counter, 'utf8')).toBe('1')
      expect(await readFile(output, 'utf8')).toContain('high severity vulnerability')
      expect(await readFile(githubOutput, 'utf8')).toContain('failure_kind=dependency')
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('retries transport failures and classifies them as infrastructure', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'b2-audit-network-'))
    try {
      const fixture = join(tempDir, 'network.mjs')
      const counter = join(tempDir, 'count.txt')
      const output = join(tempDir, 'audit-output.txt')
      const githubOutput = join(tempDir, 'github-output.txt')
      await writeFixture(fixture, counter, {
        exitStatus: 1,
        stdout: 'ERR_PNPM_FETCH_FAIL request to npm failed\n',
      })

      const result = runAuditFixture(fixture, output, githubOutput)

      expect(result.status).toBe(1)
      expect(await readFile(counter, 'utf8')).toBe('2')
      expect(await readFile(githubOutput, 'utf8')).toContain('failure_kind=infrastructure')
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('falls back to safe numeric defaults for invalid env values', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'b2-audit-env-'))
    try {
      const fixture = join(tempDir, 'network.mjs')
      const counter = join(tempDir, 'count.txt')
      const output = join(tempDir, 'audit-output.txt')
      const githubOutput = join(tempDir, 'github-output.txt')
      await writeFixture(fixture, counter, {
        exitStatus: 1,
        stdout: 'ERR_PNPM_FETCH_FAIL request to npm failed\n',
      })

      const result = runAuditFixture(fixture, output, githubOutput, {
        AUDIT_ATTEMPTS: 'not-a-number',
        AUDIT_ATTEMPT_TIMEOUT_SECONDS: '-1',
      })

      expect(result.status).toBe(1)
      expect(await readFile(counter, 'utf8')).toBe('3')
      expect(await readFile(githubOutput, 'utf8')).toContain('attempts=3')
      expect(await readFile(githubOutput, 'utf8')).toContain('failure_kind=infrastructure')
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})

describe('full-lockfile audit heartbeat script', () => {
  it('stays silent while there is no run history yet', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'b2-audit-heartbeat-cold-'))
    try {
      const runs = join(tempDir, 'runs.json')
      const githubOutput = join(tempDir, 'github-output.txt')
      await writeFile(runs, '[]')

      const result = spawnSync(process.execPath, [HEARTBEAT_SCRIPT_PATH, runs], {
        encoding: 'utf8',
        env: { ...process.env, GITHUB_OUTPUT: githubOutput },
      })

      expect(result.status).toBe(0)
      expect(result.stdout).toContain('cold-start grace')
      expect(await readFile(githubOutput, 'utf8')).toContain('heartbeat_status=cold-start')
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('fails after an observed audit run becomes stale', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'b2-audit-heartbeat-stale-'))
    try {
      const runs = join(tempDir, 'runs.json')
      const githubOutput = join(tempDir, 'github-output.txt')
      await writeFile(
        runs,
        JSON.stringify([
          {
            conclusion: 'success',
            createdAt: '2026-06-01T00:00:00Z',
            event: 'schedule',
            status: 'completed',
            url: 'https://github.com/backblaze-labs/b2-action/actions/runs/1',
          },
        ]),
      )

      const result = spawnSync(process.execPath, [HEARTBEAT_SCRIPT_PATH, runs], {
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_OUTPUT: githubOutput,
          HEARTBEAT_NOW: '2026-06-19T00:00:00Z',
        },
      })

      expect(result.status).toBe(1)
      expect(result.stdout).toContain('Latest audit is stale')
      expect(await readFile(githubOutput, 'utf8')).toContain('heartbeat_status=stale')
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('falls back to a safe heartbeat window for invalid env values', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'b2-audit-heartbeat-env-'))
    try {
      const runs = join(tempDir, 'runs.json')
      const githubOutput = join(tempDir, 'github-output.txt')
      await writeFile(
        runs,
        JSON.stringify([
          {
            conclusion: 'success',
            createdAt: '2026-06-12T00:00:00Z',
            event: 'schedule',
            status: 'completed',
            url: 'https://github.com/backblaze-labs/b2-action/actions/runs/2',
          },
        ]),
      )

      const result = spawnSync(process.execPath, [HEARTBEAT_SCRIPT_PATH, runs], {
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_OUTPUT: githubOutput,
          HEARTBEAT_NOW: '2026-06-19T00:00:00Z',
          HEARTBEAT_WINDOW_DAYS: 'not-a-number',
        },
      })

      expect(result.status).toBe(0)
      expect(result.stdout).toContain('Latest audit is recent')
      expect(await readFile(githubOutput, 'utf8')).toContain('heartbeat_status=healthy')
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})

function runAuditFixture(
  fixture: string,
  output: string,
  githubOutput: string,
  env: Record<string, string> = {},
) {
  return spawnSync(process.execPath, [SCRIPT_PATH], {
    encoding: 'utf8',
    env: {
      ...process.env,
      AUDIT_ATTEMPTS: '2',
      AUDIT_ATTEMPT_TIMEOUT_SECONDS: '2',
      AUDIT_OUTPUT: output,
      AUDIT_RETRY_BACKOFF_SECONDS: '0',
      GITHUB_OUTPUT: githubOutput,
      PNPM_AUDIT_ARGS: JSON.stringify([fixture]),
      PNPM_AUDIT_COMMAND: process.execPath,
      ...env,
    },
  })
}

async function writeFixture(
  path: string,
  counter: string,
  options: { exitStatus: number; stdout: string },
) {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(
    path,
    [
      "import { readFileSync, writeFileSync } from 'node:fs'",
      `const counter = ${JSON.stringify(counter)}`,
      'let count = 0',
      "try { count = Number(readFileSync(counter, 'utf8')) } catch {}",
      'writeFileSync(counter, String(count + 1))',
      `process.stdout.write(${JSON.stringify(options.stdout)})`,
      `process.exit(${options.exitStatus})`,
    ].join('\n'),
  )
}
