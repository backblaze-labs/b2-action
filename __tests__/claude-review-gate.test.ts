import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

// @ts-expect-error scripts are dependency-free JavaScript, not typed modules.
const gate = (await import('../scripts/claude-review-gate-lib.mjs')) as {
  classifyActor: (result: unknown) => string
  decide: (hasApiKey: boolean, actorClass: string) => { action: string; reason?: string }
}

const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts/claude-review-gate.mjs')

describe('claude-review gate decisions', () => {
  it('classifies lookups the way claude-code-action does', () => {
    expect(gate.classifyActor({ status: 200, body: { type: 'User' } })).toBe('human')
    expect(gate.classifyActor({ status: 200, body: { type: 'Bot' } })).toBe('non-human')
    expect(gate.classifyActor({ status: 200, body: { type: 'Organization' } })).toBe('non-human')
    expect(gate.classifyActor({ status: 404, body: { message: 'Not Found' } })).toBe('app')
  })

  it('treats failures and malformed responses as unknown, never as a bot', () => {
    expect(gate.classifyActor({ error: 'getaddrinfo ENOTFOUND' })).toBe('unknown')
    for (const status of [401, 403, 429, 500, 502]) {
      expect(gate.classifyActor({ status, body: { message: 'x' } })).toBe('unknown')
    }
    expect(gate.classifyActor({ status: 200, body: null })).toBe('unknown')
    expect(gate.classifyActor({ status: 200, body: { type: 'Mannequin' } })).toBe('unknown')
    expect(gate.classifyActor({ status: 200, body: 'not an object' })).toBe('unknown')
  })

  it('reviews only with a key and a human, skips bots, and fails on unknown identity', () => {
    expect(gate.decide(true, 'human')).toEqual({ action: 'review' })
    expect(gate.decide(true, 'non-human')).toEqual({ action: 'skip', reason: 'non-human' })
    expect(gate.decide(true, 'app')).toEqual({ action: 'skip', reason: 'non-human' })
    expect(gate.decide(true, 'unknown')).toEqual({ action: 'fail' })
    expect(gate.decide(false, 'unknown')).toEqual({ action: 'skip', reason: 'no-key' })
  })
})

describe('claude-review gate script', () => {
  let server: Server | undefined
  let outDir: string | undefined

  afterEach(async () => {
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()))
    server = undefined
    if (outDir) rmSync(outDir, { recursive: true, force: true })
  })

  // Serve the scripted responses in order, repeating the last one; count requests.
  async function fakeApi(responses: Array<{ status: number; body: unknown }>) {
    const seen = { requests: 0 }
    server = createServer((_req, res) => {
      const next = responses[Math.min(seen.requests, responses.length - 1)]
      seen.requests++
      res.writeHead(next?.status ?? 500, { 'content-type': 'application/json' })
      res.end(typeof next?.body === 'string' ? next.body : JSON.stringify(next?.body ?? {}))
    })
    await new Promise<void>((done) => server?.listen(0, '127.0.0.1', () => done()))
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen }
  }

  function run(env: Record<string, string>) {
    outDir = mkdtempSync(join(tmpdir(), 'b2-review-gate-'))
    const outputFile = join(outDir, 'output')
    return new Promise<{ status: number | null; stdout: string; output: string }>((done) => {
      const child = spawn(process.execPath, [script], {
        env: {
          PATH: process.env.PATH ?? '',
          GITHUB_OUTPUT: outputFile,
          GATE_RETRY_DELAY_MS: '0',
          ACTOR: 'someone',
          ...env,
        },
      })
      let stdout = ''
      child.stdout.on('data', (chunk) => {
        stdout += chunk
      })
      child.on('close', (status) => {
        let output = ''
        try {
          output = readFileSync(outputFile, 'utf8')
        } catch {
          output = ''
        }
        done({ status, stdout, output })
      })
    })
  }

  it('reviews when a person triggered the run', async () => {
    const api = await fakeApi([{ status: 200, body: { type: 'User' } }])
    const result = await run({ HAS_API_KEY: 'true', GITHUB_API_URL: api.url })
    expect(result.status).toBe(0)
    expect(result.output).toBe('present=true\n')
  })

  it('skips with a notice for a bot or an app actor', async () => {
    const bot = await fakeApi([{ status: 200, body: { type: 'Bot' } }])
    const botResult = await run({ HAS_API_KEY: 'true', GITHUB_API_URL: bot.url })
    expect(botResult.status).toBe(0)
    expect(botResult.output).toBe('present=false\n')
    expect(botResult.stdout).toContain('::notice')
    await new Promise<void>((done) => server?.close(() => done()))

    const app = await fakeApi([{ status: 404, body: { message: 'Not Found' } }])
    const appResult = await run({ HAS_API_KEY: 'true', GITHUB_API_URL: app.url })
    expect(appResult.status).toBe(0)
    expect(appResult.output).toBe('present=false\n')
  })

  it('fails instead of skipping when the lookup keeps failing', async () => {
    const api = await fakeApi([{ status: 503, body: { message: 'unavailable' } }])
    const result = await run({
      HAS_API_KEY: 'true',
      GITHUB_API_URL: api.url,
      GATE_ATTEMPTS: '3',
    })
    expect(result.status).toBe(1)
    expect(result.output).toBe('')
    expect(result.stdout).toContain('::error')
    expect(api.seen.requests).toBe(3)
  })

  it('fails on an auth error or a malformed response', async () => {
    const auth = await fakeApi([{ status: 401, body: { message: 'Bad credentials' } }])
    expect((await run({ HAS_API_KEY: 'true', GITHUB_API_URL: auth.url })).status).toBe(1)
    await new Promise<void>((done) => server?.close(() => done()))

    const malformed = await fakeApi([{ status: 200, body: 'not json' }])
    expect((await run({ HAS_API_KEY: 'true', GITHUB_API_URL: malformed.url })).status).toBe(1)
  })

  it('recovers when a transient failure is followed by a good answer', async () => {
    const api = await fakeApi([
      { status: 502, body: { message: 'bad gateway' } },
      { status: 200, body: { type: 'User' } },
    ])
    const result = await run({ HAS_API_KEY: 'true', GITHUB_API_URL: api.url })
    expect(result.status).toBe(0)
    expect(result.output).toBe('present=true\n')
    expect(api.seen.requests).toBe(2)
  })

  it('skips without any lookup when the API key is missing', async () => {
    const api = await fakeApi([{ status: 200, body: { type: 'User' } }])
    const result = await run({ HAS_API_KEY: 'false', GITHUB_API_URL: api.url })
    expect(result.status).toBe(0)
    expect(result.output).toBe('present=false\n')
    expect(api.seen.requests).toBe(0)
  })

  it('reads only the HAS_API_KEY flag, never the key itself', async () => {
    const api = await fakeApi([{ status: 200, body: { type: 'User' } }])
    const result = await run({ ANTHROPIC_API_KEY: 'k', GITHUB_API_URL: api.url })
    expect(result.output).toBe('present=false\n')
    expect(api.seen.requests).toBe(0)
  })
})
