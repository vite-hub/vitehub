import { githubBotLogin, runGitHub } from './github.ts'

export const queuedLabel = 'Agent: Queued'
export const workingLabel = 'Agent: Working'
export const queuedLabelColor = 'd0d7de'
export const workingLabelColor = '54aeff'

const lifecycleMarker = '<!-- vitehub-babysitter-status -->'
const retiredLabels = ['ready-for-agent', 'in-agent-run'] as const

type GitHubResult = { stdout: string }
export type GitHubRunner = (args: string[], options?: { repository?: string }) => Promise<GitHubResult>

export type PullRequestLifecycle = {
  commentId: number
  commentUrl?: string
  sessionUrl: string
}

export async function ensureLifecycleLabels(repository: string, run: GitHubRunner = runGitHub) {
  await Promise.all([
    ensureLabel(repository, queuedLabel, queuedLabelColor, 'Waiting for a Babysitter owner.', run),
    ensureLabel(repository, workingLabel, workingLabelColor, 'Babysitter is working on this pull request.', run),
  ])
}

export async function markPullRequestQueued(repository: string, number: number, run: GitHubRunner = runGitHub) {
  await replaceLifecycleLabel(repository, number, queuedLabel, run)
}

export async function startPullRequestLifecycle(
  repository: string,
  number: number,
  invocationId: string,
  run: GitHubRunner = runGitHub,
): Promise<PullRequestLifecycle> {
  await replaceLifecycleLabel(repository, number, workingLabel, run)
  const sessionUrl = babysitterSessionUrl(invocationId)
  const body = `${lifecycleMarker}\n[View the Babysitter session](${sessionUrl})\n\nBabysitter is working on the latest pull request state.`
  const existing = await findLifecycleComment(repository, number, run)
  const comment = existing
    ? await updateComment(repository, existing.id, body, run)
    : await createComment(repository, number, body, run)
  await run([
    'api',
    '--method', 'POST',
    '-H', 'Accept: application/vnd.github+json',
    `repos/${repository}/issues/${number}/reactions`,
    '-f', 'content=eyes',
  ], { repository })
  return {
    commentId: comment.id,
    ...(comment.html_url ? { commentUrl: comment.html_url } : {}),
    sessionUrl,
  }
}

export async function finishPullRequestLifecycle(
  repository: string,
  number: number,
  lifecycle: PullRequestLifecycle | undefined,
  result: { error?: unknown, text?: string },
  run: GitHubRunner = runGitHub,
) {
  await clearLifecycleLabels(repository, number, run)
  if (!lifecycle) return
  const summary = conciseResult(result)
  const body = `${lifecycleMarker}\n[View the Babysitter session](${lifecycle.sessionUrl})\n\n${summary}`
  await updateComment(repository, lifecycle.commentId, body, run)
}

export function agentResultText(value: unknown, observations?: readonly unknown[]) {
  if (observations) {
    for (const observation of observations.toReversed()) {
      if (!observation || typeof observation !== 'object') continue
      const record = observation as Record<string, unknown>
      if (record.name !== 'agent.message.delta' || !record.attributes || typeof record.attributes !== 'object') continue
      const attributes = record.attributes as Record<string, unknown>
      if (attributes['message.role'] !== 'assistant') continue
      const content = attributes['message.content']
      if (typeof content === 'string' && content.trim()) return content.trim()
    }
    return undefined
  }
  if (typeof value === 'string') return value.trim() || undefined
  if (!value || typeof value !== 'object') return undefined
  const text = (value as Record<string, unknown>).text
  return typeof text === 'string' ? text.trim() || undefined : undefined
}

export function babysitterSessionUrl(invocationId: string) {
  const base = (process.env.BABYSITTER_PUBLIC_URL || 'https://babysitter.vitehub.dev').replace(/\/+$/, '')
  return `${base}/?invocation=${encodeURIComponent(invocationId)}`
}

async function ensureLabel(repository: string, name: string, color: string, description: string, run: GitHubRunner) {
  await run(['label', 'create', name, '--repo', repository, '--color', color, '--description', description, '--force'], { repository })
}

async function replaceLifecycleLabel(repository: string, number: number, target: string, run: GitHubRunner) {
  const current = await pullRequestLabels(repository, number, run)
  if (!current.has(target)) {
    await run(['api', '--method', 'POST', `repos/${repository}/issues/${number}/labels`, '-f', `labels[]=${target}`], { repository })
  }
  for (const label of [queuedLabel, workingLabel, ...retiredLabels]) {
    if (label === target || !current.has(label)) continue
    await removeLabel(repository, number, label, run)
  }
}

async function clearLifecycleLabels(repository: string, number: number, run: GitHubRunner) {
  const current = await pullRequestLabels(repository, number, run)
  for (const label of [queuedLabel, workingLabel, ...retiredLabels]) {
    if (current.has(label)) await removeLabel(repository, number, label, run)
  }
}

async function pullRequestLabels(repository: string, number: number, run: GitHubRunner) {
  const result = await run(['api', `repos/${repository}/issues/${number}`, '--jq', '.labels[].name'], { repository })
  return new Set(result.stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean))
}

async function removeLabel(repository: string, number: number, label: string, run: GitHubRunner) {
  await run(['api', '--method', 'DELETE', `repos/${repository}/issues/${number}/labels/${encodeURIComponent(label)}`], { repository })
}

async function findLifecycleComment(repository: string, number: number, run: GitHubRunner) {
  const result = await run(['api', '--paginate', '--slurp', `repos/${repository}/issues/${number}/comments?per_page=100`], { repository })
  const parsed = JSON.parse(result.stdout) as unknown
  const comments = (Array.isArray(parsed) ? parsed.flat() : []) as Record<string, unknown>[]
  return comments.find((comment) => {
    const author = comment.user && typeof comment.user === 'object' ? (comment.user as Record<string, unknown>).login : undefined
    return author === githubBotLogin && typeof comment.body === 'string' && comment.body.includes(lifecycleMarker)
  }) as { body: string, html_url?: string, id: number } | undefined
}

async function createComment(repository: string, number: number, body: string, run: GitHubRunner) {
  const result = await run(['api', '--method', 'POST', `repos/${repository}/issues/${number}/comments`, '-f', `body=${body}`], { repository })
  return parseComment(result.stdout)
}

async function updateComment(repository: string, id: number, body: string, run: GitHubRunner) {
  const result = await run(['api', '--method', 'PATCH', `repos/${repository}/issues/comments/${id}`, '-f', `body=${body}`], { repository })
  return parseComment(result.stdout)
}

function parseComment(value: string) {
  const comment = JSON.parse(value) as Record<string, unknown>
  if (!Number.isSafeInteger(comment.id)) throw new Error('GitHub returned a comment without an id.')
  return {
    id: comment.id as number,
    ...(typeof comment.html_url === 'string' ? { html_url: comment.html_url } : {}),
  }
}

function conciseResult(result: { error?: unknown, text?: string }) {
  if (result.text?.trim()) return result.text.trim().slice(0, 12_000)
  const message = result.error instanceof Error ? result.error.message : typeof result.error === 'string' ? result.error : undefined
  return message ? `Babysitter stopped before producing a result: ${message}` : 'Babysitter finished without a final message.'
}
