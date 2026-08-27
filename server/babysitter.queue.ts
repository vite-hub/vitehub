import { createHash } from 'node:crypto'

export const defaultMaxOwners = '1'
export const completionPolicyVersion = 'stable-actionable-repository-checks-owner-state-v3'
const parkDisposition = '<!-- babysitter:disposition:park -->'
const lifecycleLabels = new Set(['Agent: Queued', 'Agent: Working'])

export type PullRequestFeedback = {
  comments: { count: number, latestId: string | null }
  reviews: { count: number, latestId: string | null }
}

export type PullRequest = {
  baseRefName: string
  body: string
  comments: unknown
  feedback?: PullRequestFeedback
  headRefName: string
  headRefOid: string
  headRepository: { nameWithOwner: string } | null
  isDraft: boolean
  labels?: unknown
  mergeStateStatus: string
  number: number
  reviewDecision: string | null
  reviews: unknown
  requiredStatusCheckRollup?: unknown
  state: string
  statusCheckRollup: unknown
  title: string
  updatedAt: string
  url: string
}

export type PullRequestJob = {
  completionKey: string
  fingerprint: string
  pullRequest: PullRequest
  repository: string
}

export function resolveRepositories(repositories: string, repository: string) {
  const configured = repositories.trim() || repository
  const resolved = [...new Set(configured.split(/[\s,]+/).filter(Boolean).map(value => value.toLowerCase()))]
  if (resolved.length === 0) throw new Error('At least one Babysitter repository is required.')
  for (const value of resolved) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) throw new Error(`Invalid GitHub repository: ${value}`)
  }
  return resolved
}

export function resolveMaxOwners(value: string) {
  const maxOwners = Number(value)
  if (!Number.isInteger(maxOwners) || maxOwners < 1) throw new Error(`Invalid Babysitter owner limit: ${value}`)
  return maxOwners
}

export async function selectPullRequestJobs(
  repositories: string[],
  listPullRequests: (repository: string) => Promise<PullRequest[]>,
  readCompletion: (key: string) => Promise<string | null>,
  policyFingerprint: string,
) {
  const byRepository = await Promise.all(repositories.map(async (repository) => {
    try {
      const pullRequests = await listPullRequests(repository)
      return pullRequests
        .filter(pullRequest => !hasOpenStackParent(pullRequest, pullRequests))
        .map(pullRequest => ({ pullRequest, repository }))
    }
    catch (error) {
      console.error(new Error(`Failed to list pull requests for ${repository}.`, { cause: error }))
      return []
    }
  }))
  const candidates = Array.from({ length: Math.max(0, ...byRepository.map(pullRequests => pullRequests.length)) }, (_, index) =>
    byRepository.flatMap(pullRequests => pullRequests[index] || []),
  ).flat()

  const jobs = await Promise.all(candidates.map(async ({ pullRequest, repository }) => {
    const fingerprint = pullRequestFingerprint(repository, pullRequest, policyFingerprint)
    const key = `babysitter/${repository}/pull-requests/${pullRequest.number}`
    const completionFingerprint = successfulPassFingerprint(repository, pullRequest, policyFingerprint)
    const completed = completionFingerprint ? await readCompletion(key) : null
    const previousCompletionFingerprint = completionFingerprint
      ? pullRequestFingerprint(repository, { ...pullRequest, statusCheckRollup: pullRequestCheckState(pullRequest.statusCheckRollup) }, policyFingerprint)
      : undefined
    return completionFingerprint && (completed === completionFingerprint || completed === previousCompletionFingerprint || completed === fingerprint)
      ? undefined
      : { completionKey: key, fingerprint, pullRequest, repository }
  }))

  return jobs
    .filter((job): job is PullRequestJob => job !== undefined)
    .sort(comparePullRequestJobs)
}

function comparePullRequestJobs(left: PullRequestJob, right: PullRequestJob) {
  const leftUpdatedAt = Date.parse(left.pullRequest.updatedAt)
  const rightUpdatedAt = Date.parse(right.pullRequest.updatedAt)
  const leftTime = Number.isNaN(leftUpdatedAt) ? Number.POSITIVE_INFINITY : leftUpdatedAt
  const rightTime = Number.isNaN(rightUpdatedAt) ? Number.POSITIVE_INFINITY : rightUpdatedAt
  if (leftTime !== rightTime) return leftTime - rightTime
  if (left.repository !== right.repository) return left.repository < right.repository ? -1 : 1
  return left.pullRequest.number - right.pullRequest.number
}

function hasOpenStackParent(pullRequest: PullRequest, pullRequests: PullRequest[]) {
  return pullRequests.some(parent => parent.number !== pullRequest.number
    && parent.state === 'OPEN'
    && parent.headRefName === pullRequest.baseRefName)
}

export async function runPullRequestJobs(
  jobs: PullRequestJob[],
  maxOwners: number,
  run: (job: PullRequestJob) => Promise<void>,
) {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(maxOwners, jobs.length) }, async () => {
    while (next < jobs.length) await run(jobs[next++]!)
  }))
}

export function createPolicyFingerprint(...policy: string[]) {
  return createHash('sha256').update(JSON.stringify(policy)).digest('hex').slice(0, 16)
}

export function pullRequestFingerprint(repository: string, pullRequest: PullRequest, policyFingerprint: string) {
  return fingerprintPullRequestState(repository, pullRequest, policyFingerprint)
}

export function successfulPassFingerprint(
  repository: string,
  pullRequest: PullRequest,
  policyFingerprint: string,
  observedPullRequest: PullRequest = pullRequest,
) {
  if (pullRequest.state !== 'OPEN') return undefined
  const completedPullRequest = observedPullRequest.headRefOid === pullRequest.headRefOid
    ? observedPullRequest
    : pullRequest
  const visibleCheckState = pullRequestCheckState(completedPullRequest.statusCheckRollup)
  const requiredCheckState = completedPullRequest.requiredStatusCheckRollup === undefined
    ? undefined
    : pullRequestCheckState(completedPullRequest.requiredStatusCheckRollup, 'passed')
  const repositoryCheckState = pullRequestRepositoryCheckState(repository, completedPullRequest.statusCheckRollup)
  const checkState = requiredCheckState === undefined
    ? visibleCheckState
    : {
        repository: repositoryCheckState,
        required: requiredCheckState,
        visibleFailure: visibleCheckState === 'failed',
      }
  const completionState: Record<string, unknown> = {
    ...completedPullRequest,
    comments: completedPullRequest.feedback?.comments ?? feedbackCollectionState(completedPullRequest.comments),
    labels: stableLabels(completedPullRequest.labels),
    requiredStatusCheckRollup: checkState,
    reviews: completedPullRequest.feedback?.reviews ?? feedbackCollectionState(completedPullRequest.reviews),
    statusCheckRollup: checkState,
  }
  delete completionState.feedback
  delete completionState.updatedAt
  return fingerprintPullRequestState(repository, completionState, policyFingerprint)
}

function stableLabels(labels: unknown) {
  if (!Array.isArray(labels)) return labels
  return labels.filter(label => !label || typeof label !== 'object'
    || !lifecycleLabels.has(String((label as Record<string, unknown>).name)))
}

export function completedPassFingerprint(
  repository: string,
  pullRequest: PullRequest,
  policyFingerprint: string,
  result: unknown,
  observedPullRequest: PullRequest = pullRequest,
) {
  return passResultText(result)?.split(/\r?\n/).includes(parkDisposition)
    ? successfulPassFingerprint(repository, pullRequest, policyFingerprint, observedPullRequest)
    : undefined
}

function passResultText(result: unknown) {
  if (typeof result === 'string') return result
  if (result && typeof result === 'object' && 'text' in result && typeof result.text === 'string') return result.text
}

function feedbackCollectionState(value: unknown) {
  if (!Array.isArray(value)) return value
  const latest = value.at(-1)
  return {
    count: value.length,
    latestId: latest && typeof latest === 'object'
      ? String((latest as Record<string, unknown>).id ?? (latest as Record<string, unknown>).url ?? '') || null
      : null,
  }
}

function fingerprintPullRequestState(repository: string, state: unknown, policyFingerprint: string) {
  return createHash('sha256').update(policyFingerprint).update(repository).update(JSON.stringify(state)).digest('hex').slice(0, 16)
}

export function pullRequestCheckState(statusCheckRollup: unknown, empty: 'passed' | 'pending' = 'pending'): 'failed' | 'passed' | 'pending' {
  if (!Array.isArray(statusCheckRollup) || statusCheckRollup.length === 0) return empty
  const failedConclusions = new Set(['ACTION_REQUIRED', 'CANCELLED', 'FAILURE', 'STALE', 'STARTUP_FAILURE', 'TIMED_OUT'])
  let pending = false
  for (const value of statusCheckRollup) {
    if (!value || typeof value !== 'object') {
      pending = true
      continue
    }
    const { bucket, conclusion, state, status } = value as Record<string, unknown>
    if (bucket === 'fail' || bucket === 'cancel') return 'failed'
    if (bucket === 'pending') {
      pending = true
      continue
    }
    if (bucket === 'pass' || bucket === 'skipping') continue
    if (state === 'ERROR' || state === 'FAILURE' || status === 'COMPLETED' && typeof conclusion === 'string' && failedConclusions.has(conclusion)) return 'failed'
    if (status === 'COMPLETED') {
      if (typeof conclusion !== 'string' || !conclusion) pending = true
    }
    else if (status !== undefined || state !== 'SUCCESS') pending = true
  }
  return pending ? 'pending' : 'passed'
}

function pullRequestRepositoryCheckState(repository: string, statusCheckRollup: unknown) {
  if (!Array.isArray(statusCheckRollup)) return pullRequestCheckState(statusCheckRollup)
  return pullRequestCheckState(statusCheckRollup.filter(check => isRepositoryCheck(repository, check)), 'passed')
}

function isRepositoryCheck(repository: string, value: unknown) {
  if (!value || typeof value !== 'object') return true
  const { detailsUrl, workflow, workflowName } = value as Record<string, unknown>
  if ((typeof workflowName === 'string' && workflowName) || (typeof workflow === 'string' && workflow)) return true
  if (typeof detailsUrl !== 'string' || !detailsUrl) return true
  try {
    const url = new URL(detailsUrl)
    return url.hostname === 'github.com' && url.pathname.startsWith(`/${repository}/actions/`)
  }
  catch {
    return true
  }
}

export function parseRequiredChecks(stdout: string, stderr: string): unknown[] | undefined {
  if (stdout.trim()) {
    try {
      const checks: unknown = JSON.parse(stdout)
      return Array.isArray(checks) ? checks : undefined
    }
    catch {
      return undefined
    }
  }
  const message = stderr.trim()
  return /^no (?:required )?checks reported on the '.+' branch$/.test(message) ? [] : undefined
}
