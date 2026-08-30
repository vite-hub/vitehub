import { agentInvocationId, createMessage, runScheduledAgent } from 'vite-hub/agent'
import { kv } from 'vite-hub/kv'
import { useServerEnv } from '#vitehub/env/server'
import { createBabysitterAgent } from './agents/babysitter/agent.ts'
import blocker from './agents/babysitter/blocker.md?raw'
import renderPrompt from './agents/babysitter/prompt.template.md'
import promptTemplate from './agents/babysitter/prompt.template.md?raw'
import { withPullRequestCheckout } from './babysitter.checkout.ts'
import { ensureGitHubGraphQLBudget, githubToken, isGitHubRateLimitError, runGitHub } from './github.ts'
import {
  logOperationalError,
  logOperationalEvent,
} from './babysitter.operations.ts'
import {
  completionPolicyVersion,
  completedPassFingerprint,
  createPolicyFingerprint,
  parseRequiredChecks,
  type PullRequest,
  type PullRequestFeedback,
  pullRequestCheckState,
  resolveMaxOwners,
  resolveRepositories,
  selectPullRequestJobs,
} from './babysitter.queue.ts'
import { invocations } from './invocations.ts'

const policyFingerprint = createPolicyFingerprint(promptTemplate, blocker, completionPolicyVersion)
const pullRequestFields = 'baseRefName,body,headRefName,headRefOid,headRepository,isDraft,labels,mergeStateStatus,number,reviewDecision,state,statusCheckRollup,title,updatedAt,url'
const runningJobs = new Set<string>()
let wakeReconciler = () => {}

export function setBabysitterReconcilerWake(wake: () => void) {
  wakeReconciler = wake
}

export function babysitterWorkload() {
  return { running: runningJobs.size }
}

export async function reconcileBabysitterWork(reason: string) {
  const startedAt = new Date()
  const schedule = {
    id: 'babysitter-demand',
    runId: `demand:${startedAt.toISOString()}`,
    scheduledAt: startedAt,
  }
  const { maxOwners, repositories: configuredRepositories, repository } = useServerEnv().babysitter
  const repositories = resolveRepositories(configuredRepositories, repository)
  const discovered = await selectPullRequestJobs(repositories, listPullRequests, readCompletion, policyFingerprint)
  const ownerLimit = resolveMaxOwners(maxOwners)
  const availableOwnerSlots = Math.max(0, ownerLimit - runningJobs.size)
  const jobs = discovered
    .filter(job => !runningJobs.has(jobKey(job.repository, job.pullRequest.number)))
    .slice(0, availableOwnerSlots)
  const batchStartedAt = Date.now()

  logOperationalEvent('babysitter.batch.started', {
    jobs: jobs.length,
    maxOwners: ownerLimit,
    reason,
    repositories,
    scheduleId: schedule.runId || schedule.id,
  })
  for (const job of jobs) {
    runningJobs.add(jobKey(job.repository, job.pullRequest.number))
  }
  void Promise.all(jobs.map(async job => {
    const { pullRequest, repository } = job
    const runId = `${schedule.runId || schedule.id}:${repository}:pr-${pullRequest.number}:${job.fingerprint}`
    const owner = { pullRequest: pullRequest.number, repository, runId }
    const startedAt = Date.now()
    let outcome = 'completed'
    let failure: unknown
    let resultText: string | undefined
    logOperationalEvent('babysitter.owner.started', {
      head: pullRequest.headRefOid,
      maxOwners: ownerLimit,
      workItems: runningJobs.size,
      ...owner,
    })
    try {
      const token = await githubToken({ refresh: true, repository })
      await withPullRequestCheckout(repository, pullRequest, token, async checkout => {
        const context = {
          pullRequestHead: pullRequest.headRefOid,
          pullRequestNumber: pullRequest.number,
          pullRequestRepository: repository,
          pullRequestSourceBranch: pullRequest.headRefName,
          pullRequestSourceRepository: pullRequest.headRepository?.nameWithOwner || '(unavailable)',
          pullRequestTitle: pullRequest.title,
          pullRequestUrl: pullRequest.url,
        }
        const agent = createBabysitterAgent(checkout, token)
        const prompt = await renderPrompt({ blocker, context })
        const result = await runScheduledAgent(agent, {
          ...schedule,
          runId,
        }, {
          run: {
            activity: {
              links: [{ label: 'Session', url: await babysitterSessionUrl(runId) }],
              target: { issue: pullRequest.number, repository },
            },
            annotations: {
              'github.head': pullRequest.headRefOid,
              'github.pullRequest': pullRequest.number,
              'github.repository': repository,
              'github.title': pullRequest.title,
              'github.url': pullRequest.url,
            },
            channelId: 'github',
            runId,
          },
        }, {
          abortSignal: AbortSignal.timeout(60 * 60 * 1000),
          context,
          messages: [createMessage({ role: 'user', text: prompt })],
        })
        try {
          const invocation = await invocations.getByRunId(runId, 'babysitter')
          resultText = agentResultText(result, invocation?.observations || [])
        }
        catch (error) {
          logOperationalError('babysitter.final-message.failed', error, owner)
        }
      })

      const current = await readPullRequest(repository, pullRequest.number)
      const fingerprint = completedPassFingerprint(repository, current, policyFingerprint, resultText, pullRequest)
      if (fingerprint) {
        const [error] = await kv.set(job.completionKey, fingerprint)
        if (error) throw error
      }
      else if (current.state === 'OPEN') {
        outcome = 'retry'
      }
    }
    catch (error) {
      if (isGitHubRateLimitError(error)) {
        outcome = 'deferred'
        logOperationalEvent('babysitter.owner.deferred', { reason: 'github-rate-limit', ...owner })
      }
      else {
        outcome = 'failed'
        failure = error
        logOperationalError('babysitter.owner.failed', error, owner)
      }
    }
    finally {
      runningJobs.delete(jobKey(repository, pullRequest.number))
      logOperationalEvent('babysitter.owner.finished', {
        durationMs: Date.now() - startedAt,
        outcome,
        ...owner,
      })
      wakeReconciler()
    }
  })).finally(() => {
    logOperationalEvent('babysitter.batch.finished', {
      durationMs: Date.now() - batchStartedAt,
      jobs: jobs.length,
      maxOwners: ownerLimit,
      repositories,
      scheduleId: schedule.runId || schedule.id,
    })
  }).catch(error => logOperationalError('babysitter.batch.failed', error, { scheduleId: schedule.runId }))
}

function jobKey(repository: string, number: number) {
  return `${repository}#${number}`
}

async function babysitterSessionUrl(runId: string) {
  const base = (process.env.BABYSITTER_PUBLIC_URL || 'https://babysitter.vitehub.dev').replace(/\/+$/, '')
  const invocationId = await agentInvocationId(runId, 'babysitter')
  return `${base}/_vitehub/agents/babysitter/invocations/${encodeURIComponent(invocationId)}`
}

function agentResultText(value: unknown, observations: readonly unknown[]) {
  for (const observation of observations.toReversed()) {
    if (!observation || typeof observation !== 'object') continue
    const record = observation as Record<string, unknown>
    if (record.name !== 'agent.message.delta' || !record.attributes || typeof record.attributes !== 'object') continue
    const attributes = record.attributes as Record<string, unknown>
    if (attributes['message.role'] !== 'assistant') continue
    const content = attributes['message.content']
    if (typeof content === 'string' && content.trim()) return content.trim()
  }
  if (typeof value === 'string') return value.trim() || undefined
  if (!value || typeof value !== 'object') return undefined
  const text = (value as Record<string, unknown>).text
  return typeof text === 'string' ? text.trim() || undefined : undefined
}

async function readCompletion(key: string) {
  const [error, value] = await kv.get<string>(key)
  if (error) throw error
  return value
}

async function listPullRequests(repository: string) {
  try {
    await ensureGitHubGraphQLBudget(repository)
  }
  catch (error) {
    if (isGitHubRateLimitError(error)) return []
    throw error
  }
  const [result, feedback] = await Promise.all([
    runGitHub(['pr', 'list', '--repo', repository, '--state', 'open', '--limit', '100', '--json', pullRequestFields], { repository }),
    readOpenPullRequestFeedback(repository),
  ])
  const pullRequests = JSON.parse(result.stdout) as PullRequest[]
  return await Promise.all(pullRequests.map(pullRequest => readRequiredCheckState(repository, {
    ...pullRequest,
    ...feedback.has(pullRequest.number) ? { feedback: feedback.get(pullRequest.number) } : {},
  })))
}

async function readPullRequest(repository: string, number: number) {
  await ensureGitHubGraphQLBudget(repository)
  const [result, feedback] = await Promise.all([
    runGitHub(['pr', 'view', String(number), '--repo', repository, '--json', pullRequestFields], { repository }),
    readPullRequestFeedback(repository, number),
  ])
  return await readRequiredCheckState(repository, {
    ...JSON.parse(result.stdout) as PullRequest,
    ...feedback ? { feedback } : {},
  })
}

async function readOpenPullRequestFeedback(repository: string) {
  const [owner, name] = repository.split('/') as [string, string]
  const query = 'query($owner:String!,$name:String!){repository(owner:$owner,name:$name){pullRequests(first:100,states:OPEN){nodes{number comments(last:1){totalCount nodes{id}} reviews(last:1){totalCount nodes{id}}}}}}'
  const result = await runGitHub(['api', 'graphql', '-f', `owner=${owner}`, '-f', `name=${name}`, '-f', `query=${query}`], { repository })
  const nodes = JSON.parse(result.stdout)?.data?.repository?.pullRequests?.nodes
  return new Map<number, PullRequestFeedback>((Array.isArray(nodes) ? nodes : []).flatMap((node: unknown) => {
    const parsed = parsePullRequestFeedbackNode(node)
    return parsed ? [[parsed.number, parsed.feedback]] : []
  }))
}

async function readPullRequestFeedback(repository: string, number: number) {
  const [owner, name] = repository.split('/') as [string, string]
  const query = 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){comments(last:1){totalCount nodes{id}} reviews(last:1){totalCount nodes{id}}}}}'
  const result = await runGitHub(['api', 'graphql', '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${number}`, '-f', `query=${query}`], { repository })
  return parseFeedback(JSON.parse(result.stdout)?.data?.repository?.pullRequest)
}

function parsePullRequestFeedbackNode(value: unknown) {
  if (!value || typeof value !== 'object' || typeof (value as Record<string, unknown>).number !== 'number') return undefined
  const feedback = parseFeedback(value)
  return feedback ? { feedback, number: (value as Record<string, unknown>).number as number } : undefined
}

function parseFeedback(value: unknown): PullRequestFeedback | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const comments = parseFeedbackConnection(record.comments)
  const reviews = parseFeedbackConnection(record.reviews)
  return comments && reviews ? { comments, reviews } : undefined
}

function parseFeedbackConnection(value: unknown) {
  if (!value || typeof value !== 'object') return undefined
  const { nodes, totalCount } = value as Record<string, unknown>
  if (!Number.isInteger(totalCount) || !Array.isArray(nodes)) return undefined
  const latest = nodes.at(-1)
  const latestId = latest && typeof latest === 'object' && typeof (latest as Record<string, unknown>).id === 'string'
    ? (latest as Record<string, unknown>).id as string
    : null
  return { count: totalCount as number, latestId }
}

async function readRequiredCheckState(repository: string, pullRequest: PullRequest) {
  if (pullRequestCheckState(pullRequest.statusCheckRollup) !== 'pending') return pullRequest
  const requiredStatusCheckRollup = await readRequiredChecks(repository, pullRequest.number)
  return requiredStatusCheckRollup === undefined ? pullRequest : { ...pullRequest, requiredStatusCheckRollup }
}

async function readRequiredChecks(repository: string, number: number) {
  const args = ['pr', 'checks', String(number), '--repo', repository, '--required', '--json', 'bucket,name,state,workflow']
  try {
    const result = await runGitHub(args, { repository })
    return parseRequiredChecks(result.stdout, result.stderr)
  }
  catch (error) {
    const result = error as Error & { stderr?: unknown, stdout?: unknown }
    const checks = parseRequiredChecks(
      typeof result.stdout === 'string' ? result.stdout : '',
      typeof result.stderr === 'string' ? result.stderr : '',
    )
    if (checks !== undefined) return checks
    console.error(new Error(`Failed to read required checks for ${repository}#${number}.`, { cause: error }))
    return undefined
  }
}
