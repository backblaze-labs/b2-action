#!/usr/bin/env node
import { appendFile, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const countedEvents = new Set(['push', 'schedule', 'workflow_dispatch'])

export function isEntrypoint(importMetaUrl, argvPath) {
  return argvPath !== undefined && fileURLToPath(importMetaUrl) === argvPath
}

export function classifyHeartbeat(runs, { now = new Date(), windowDays = 10 } = {}) {
  const candidates = runs
    .filter((run) => countedEvents.has(run.event))
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))

  const latest = candidates[0]
  if (!latest) {
    return { latest: undefined, status: 'cold-start' }
  }

  const threshold = now.getTime() - windowDays * 24 * 60 * 60 * 1_000
  const latestTime = Date.parse(latest.createdAt)
  return {
    latest,
    status: latestTime >= threshold ? 'healthy' : 'stale',
  }
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

function normalizeRun(run) {
  return {
    conclusion: run.conclusion ?? '',
    createdAt: run.createdAt ?? '',
    event: run.event ?? '',
    status: run.status ?? '',
    url: run.url ?? '',
  }
}

async function runHeartbeatCli() {
  const runsPath = process.argv[2]
  if (!runsPath) {
    throw new Error('usage: full-lockfile-audit-heartbeat.mjs <runs-json>')
  }

  const runs = JSON.parse(await readFile(runsPath, 'utf8')).map(normalizeRun)
  const windowDays = Number(process.env.HEARTBEAT_WINDOW_DAYS ?? 10)
  const now = process.env.HEARTBEAT_NOW ? new Date(process.env.HEARTBEAT_NOW) : new Date()
  const result = classifyHeartbeat(runs, { now, windowDays })
  const latest = result.latest

  await writeGitHubOutput({
    heartbeat_status: result.status,
    latest_conclusion: latest?.conclusion ?? '',
    latest_created: latest?.createdAt ?? '',
    latest_event: latest?.event ?? '',
    latest_status: latest?.status ?? '',
    latest_url: latest?.url ?? '',
  })

  if (!latest) {
    console.log(
      'No default-branch full-lockfile audit run history exists yet; heartbeat is in cold-start grace.',
    )
    return 0
  }

  const description = `${latest.createdAt} (${latest.event}/${latest.status}/${latest.conclusion}): ${latest.url}`
  if (result.status === 'healthy') {
    console.log(`Latest audit is recent: ${description}`)
    return 0
  }

  console.log(`Latest audit is stale: ${description}`)
  return 1
}

if (isEntrypoint(import.meta.url, process.argv[1])) {
  try {
    process.exitCode = await runHeartbeatCli()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
