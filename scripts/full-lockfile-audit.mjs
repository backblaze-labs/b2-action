#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { appendFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const retryablePattern =
  /\b(?:ERR_PNPM_(?:FETCH|META_FETCH)_FAIL|EAI_AGAIN|ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED)\b|fetch failed|network timeout|socket hang up/i

function defaultPnpmCommand() {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
}

export function isEntrypoint(importMetaUrl, argvPath) {
  return argvPath !== undefined && fileURLToPath(importMetaUrl) === resolve(argvPath)
}

export function isRetryableAuditFailure(status, output) {
  return status === 124 || retryablePattern.test(output)
}

export function classifyAuditFailure(status, output) {
  if (status === 0) {
    return 'none'
  }
  return isRetryableAuditFailure(status, output) ? 'infrastructure' : 'dependency'
}

async function runCommand(command, args, timeoutMs) {
  let output = ''
  let timedOut = false

  const child = spawn(command, args, {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGTERM')
    setTimeout(() => child.kill('SIGKILL'), 5_000).unref()
  }, timeoutMs)

  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    output += chunk
  })
  child.stderr.on('data', (chunk) => {
    output += chunk
  })

  const status = await new Promise((resolve, reject) => {
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(timedOut ? 124 : (code ?? 1))
    })
  })

  return { output, status }
}

function parseJsonArrayEnv(name, fallback) {
  const value = process.env[name]
  if (!value) {
    return fallback
  }
  const parsed = JSON.parse(value)
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new TypeError(`${name} must be a JSON string array`)
  }
  return parsed
}

function parseNumericEnv(name, fallback, { integer = false, min = 0 } = {}) {
  const value = process.env[name]
  if (!value) {
    return fallback
  }

  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    return fallback
  }

  const normalized = integer ? Math.floor(parsed) : parsed
  return normalized >= min ? normalized : fallback
}

async function writeGitHubOutput(values) {
  const outputPath = process.env.GITHUB_OUTPUT
  if (!outputPath) {
    return
  }

  await appendFile(
    outputPath,
    `${Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n')}\n`,
  )
}

export async function runAudit({
  attemptTimeoutMs = parseNumericEnv('AUDIT_ATTEMPT_TIMEOUT_SECONDS', 120, {
    min: 1,
  }) * 1_000,
  attempts = parseNumericEnv('AUDIT_ATTEMPTS', 3, { integer: true, min: 1 }),
  auditLevel = process.env.AUDIT_LEVEL ?? 'high',
  backoffSeconds = parseNumericEnv('AUDIT_RETRY_BACKOFF_SECONDS', 15),
  command = process.env.PNPM_AUDIT_COMMAND ?? defaultPnpmCommand(),
  args = parseJsonArrayEnv('PNPM_AUDIT_ARGS', ['audit', '--audit-level', auditLevel]),
  outputPath = process.env.AUDIT_OUTPUT ?? 'audit-output.txt',
} = {}) {
  let status = 1
  let output = ''
  let failureKind = 'dependency'
  let attemptsRun = 0

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    attemptsRun = attempt
    const result = await runCommand(command, args, attemptTimeoutMs)
    status = result.status
    output = result.output

    if (status === 124) {
      output += `\npnpm audit timed out after ${attemptTimeoutMs / 1_000}s on attempt ${attempt}\n`
    }

    await writeFile(outputPath, output)

    if (status === 0) {
      failureKind = 'none'
      break
    }

    if (!isRetryableAuditFailure(status, output)) {
      failureKind = 'dependency'
      break
    }

    failureKind = 'infrastructure'
    if (attempt < attempts && backoffSeconds > 0) {
      await new Promise((resolve) => setTimeout(resolve, attempt * backoffSeconds * 1_000))
    }
  }

  await writeGitHubOutput({
    attempts: String(attemptsRun),
    failure_kind: failureKind,
    status: String(status),
  })

  process.stdout.write(output)
  return { attempts: attemptsRun, failureKind, output, status }
}

if (isEntrypoint(import.meta.url, process.argv[1])) {
  try {
    const result = await runAudit()
    process.exitCode = result.status
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    await writeGitHubOutput({ failure_kind: 'infrastructure', status: '1' })
    process.exitCode = 1
  }
}
