/**
 * Pure decisions for scripts/claude-review-gate.mjs. They mirror claude-code-action's
 * `checkHumanActor`: only a `User` account may trigger a review, and an actor the Users API
 * cannot resolve (404) is a GitHub App such as `Copilot`. Any other lookup result is unknown,
 * so the gate retries and then fails rather than reporting a skip it cannot justify.
 */

/** Classify one Users API lookup: `{ status, body }` on a response, `{ error }` when none came. */
export function classifyActor(result) {
  if (result === null || typeof result !== 'object' || 'error' in result) return 'unknown'
  if (result.status === 404) return 'app'
  if (result.status !== 200) return 'unknown'
  const type =
    result.body !== null && typeof result.body === 'object' ? result.body.type : undefined
  if (type === 'User') return 'human'
  if (type === 'Bot' || type === 'Organization') return 'non-human'
  return 'unknown'
}

/** What the job should do: review, skip with a reason, or fail because identity is unknown. */
export function decide(hasApiKey, actorClass) {
  if (!hasApiKey) return { action: 'skip', reason: 'no-key' }
  if (actorClass === 'human') return { action: 'review' }
  if (actorClass === 'non-human' || actorClass === 'app') {
    return { action: 'skip', reason: 'non-human' }
  }
  return { action: 'fail' }
}
