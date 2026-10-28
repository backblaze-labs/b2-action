#!/usr/bin/env node
// Gate for the Claude review jobs (.github/workflows/claude-review.yml). Writes `present=true`
// to GITHUB_OUTPUT only when the ANTHROPIC_API_KEY secret is set and the triggering actor is a
// person. Skips with a notice for a missing key or a bot/app actor, and fails the job when the
// actor cannot be identified, so a lookup failure never passes as a successful skip.
// Env: ANTHROPIC_API_KEY, ACTOR, GH_TOKEN, NOTICE_TITLE, GITHUB_OUTPUT, and optionally
// GITHUB_API_URL, GATE_ATTEMPTS, GATE_RETRY_DELAY_MS (the last three are for tests).

import { appendFileSync } from 'node:fs'
import { classifyActor, decide } from './claude-review-gate-lib.mjs'

const actor = process.env.ACTOR ?? ''
const title = process.env.NOTICE_TITLE ?? 'Claude review skipped'
const api = (process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/$/, '')
const attempts = Math.max(1, Number.parseInt(process.env.GATE_ATTEMPTS ?? '3', 10) || 3)
const retryDelayMs = Math.max(
  0,
  Number.parseInt(process.env.GATE_RETRY_DELAY_MS ?? '5000', 10) || 0,
)

function output(present) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `present=${present}\n`)
}

async function lookup() {
  try {
    const response = await fetch(`${api}/users/${encodeURIComponent(actor)}`, {
      headers: {
        accept: 'application/vnd.github+json',
        ...(process.env.GH_TOKEN ? { authorization: `Bearer ${process.env.GH_TOKEN}` } : {}),
      },
    })
    let body = null
    try {
      body = await response.json()
    } catch {
      body = null
    }
    return { status: response.status, body }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

const hasApiKey = (process.env.ANTHROPIC_API_KEY ?? '') !== ''
let actorClass = 'unknown'
let last = null
if (hasApiKey) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    last = await lookup()
    actorClass = classifyActor(last)
    if (actorClass !== 'unknown') break
    if (attempt < attempts) await new Promise((done) => setTimeout(done, retryDelayMs * attempt))
  }
}

const decision = decide(hasApiKey, actorClass)
if (decision.action === 'review') {
  output('true')
} else if (decision.action === 'skip') {
  output('false')
  const why =
    decision.reason === 'no-key'
      ? 'Add the ANTHROPIC_API_KEY repository secret to enable this pass (see REVIEW.md).'
      : `Triggered by ${actor}, which is not a person; the review action only runs for human-triggered events.`
  console.log(`::notice title=${title}::${why}`)
} else {
  const detail =
    last && 'error' in last ? last.error : `HTTP ${last?.status ?? 'none'} from the Users API`
  console.log(
    `::error title=Claude review gate::Could not determine whether ${actor} is a person after ${attempts} attempts (${detail}). Re-run the job; a lookup failure is not treated as a skip.`,
  )
  process.exit(1)
}
