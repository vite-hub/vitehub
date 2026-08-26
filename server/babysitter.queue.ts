import { createHash } from 'node:crypto'

export const defaultMaxOwners = '1'
const completionPolicyVersion = '2'
const parkDisposition = '<!-- babysitter:disposition:park -->'

export type PullRequest = {
  body: string
  comments: unknown
  headRefName: string
  headRefOid: string
  headRepository: { nameWithOwner: string } | null
  isDraft: boolean
  mergeStateStatus: string
  number: number
  reviewDecision: string | null
  reviews: unknown
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
) {
  const byRepository = await Promise.all(repositories.map(async (repository) => {
    try {
      return (await listPullRequests(repository)).map(pullRequest => ({ pullRequest, repository }))
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
    const fingerprint = pullRequestFingerprint(repository, pullRequest)
    const key = `babysitter/${repository}/pull-requests/${pullRequest.number}`
    return await readCompletion(key) === fingerprint
      ? undefined
      : { completionKey: key, fingerprint, pullRequest, repository }
  }))

  return jobs.filter((job): job is PullRequestJob => job !== undefined)
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

export function pullRequestFingerprint(repository: string, pullRequest: PullRequest) {
  return createHash('sha256')
    .update(completionPolicyVersion)
    .update(repository)
    .update(JSON.stringify(pullRequest))
    .digest('hex')
    .slice(0, 16)
}

export function completedPassFingerprint(repository: string, pullRequest: PullRequest, result: unknown) {
  return passResultText(result)?.split(/\r?\n/).includes(parkDisposition)
    ? successfulPassFingerprint(repository, pullRequest)
    : undefined
}

export function successfulPassFingerprint(repository: string, pullRequest: PullRequest) {
  return pullRequest.state === 'OPEN' ? pullRequestFingerprint(repository, pullRequest) : undefined
}

function passResultText(result: unknown) {
  if (typeof result === 'string') return result
  if (result && typeof result === 'object' && 'text' in result && typeof result.text === 'string') return result.text
}
