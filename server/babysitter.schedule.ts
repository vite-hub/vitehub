import { createMessage, resolveAgentInspectionMetadata, runScheduledAgent } from 'vite-hub/agent'
import { kv } from 'vite-hub/kv'
import { useServerEnv } from '#vitehub/env/server'
import { createBabysitterAgent } from './agents/babysitter/agent.ts'
import blocker from './agents/babysitter/blocker.md?raw'
import renderPrompt from './agents/babysitter/prompt.template.md'
import promptTemplate from './agents/babysitter/prompt.template.md?raw'
import { readWorkspacePaths, withPullRequestCheckout } from './babysitter.checkout.ts'
import { ensureGitHubGraphQLBudget, githubToken, isGitHubRateLimitError, runGitHub } from './github.ts'
import {
  agentResultText,
  ensureLifecycleLabels,
  finishPullRequestLifecycle,
  markPullRequestQueued,
  type PullRequestLifecycle,
  queuedLabel,
  queuedLabelColor,
  startPullRequestLifecycle,
  workingLabel,
  workingLabelColor,
} from './babysitter.github-lifecycle.ts'
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
  prioritizePullRequestJobs,
  resolveMaxOwners,
  resolveRepositories,
  selectPullRequestJobs,
} from './babysitter.queue.ts'
import { sessionAgentConfiguration } from './session-agent.ts'
import { type SessionTimelineEvent, useSessionSnapshotStore } from './session-snapshots.ts'
import { invocations } from './invocations.ts'

const policyFingerprint = createPolicyFingerprint(promptTemplate, blocker, completionPolicyVersion)
const githubLifecycleGroup = 'github-lifecycle'
const pullRequestFields = 'baseRefName,body,headRefName,headRefOid,headRepository,isDraft,labels,mergeStateStatus,number,reviewDecision,state,statusCheckRollup,title,updatedAt,url'
const runningJobs = new Set<string>()
const runningBatches = new Set<Promise<void>>()

export function babysitterWorkload() {
  return { running: runningJobs.size }
}

export async function waitForBabysitterOwners() {
  await Promise.all([...runningBatches])
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
  const eligible = discovered
    .filter(job => !runningJobs.has(jobKey(job.repository, job.pullRequest.number)))
  const jobs = (ownerLimit > 1 ? prioritizePullRequestJobs(eligible) : eligible)
    .slice(0, availableOwnerSlots)
  const batchStartedAt = Date.now()
  const queuedAt = new Map<string, string>()

  logOperationalEvent('babysitter.batch.started', {
    jobs: jobs.length,
    maxOwners: ownerLimit,
    reason,
    repositories,
    scheduleId: schedule.runId || schedule.id,
  })
  for (const queuedRepository of new Set(jobs.map(job => job.repository))) {
    try {
      await ensureLifecycleLabels(queuedRepository)
    }
    catch (error) {
      logOperationalError('babysitter.github-labels.failed', error, { repository: queuedRepository })
    }
  }
  for (const job of jobs) {
    runningJobs.add(jobKey(job.repository, job.pullRequest.number))
    const timestamp = new Date().toISOString()
    try {
      await markPullRequestQueued(job.repository, job.pullRequest.number)
      queuedAt.set(jobKey(job.repository, job.pullRequest.number), timestamp)
    }
    catch (error) {
      logOperationalError('babysitter.github-queue-status.failed', error, {
        pullRequest: job.pullRequest.number,
        repository: job.repository,
      })
    }
  }
  const batch = Promise.all(jobs.map(async job => {
    const { pullRequest, repository } = job
    const runId = `${schedule.runId || schedule.id}:${repository}:pr-${pullRequest.number}:${job.fingerprint}`
    const owner = { pullRequest: pullRequest.number, repository, runId }
    const startedAt = Date.now()
    let outcome = 'completed'
    let failure: unknown
    let lifecycle: PullRequestLifecycle | undefined
    let resultText: string | undefined
    logOperationalEvent('babysitter.owner.started', {
      head: pullRequest.headRefOid,
      maxOwners: ownerLimit,
      workItems: runningJobs.size,
      ...owner,
    })
    createSessionSnapshot({
      invocationId: runId,
      pullRequest: pullRequest.number,
      repository,
      revision: pullRequest.headRefOid,
      sourceRepository: pullRequest.headRepository?.nameWithOwner,
    }, owner)
    recordSessionEvent(runId, {
      detail: `${repository} · PR #${pullRequest.number}`,
      name: 'babysitter.pull-request.selected',
      timestamp: new Date().toISOString(),
      title: 'Pull request selected',
    }, owner)
    try {
      const token = await githubToken({ refresh: true, repository })
      recordSessionEvent(runId, {
        detail: `GitHub access for ${repository}`,
        name: 'babysitter.github.authenticated',
        timestamp: new Date().toISOString(),
        title: 'GitHub access ready',
      }, owner)
      await withPullRequestCheckout(repository, pullRequest, token, async checkout => {
        const paths = await readWorkspacePaths(checkout)
        setSessionPaths(runId, paths, owner)
        recordSessionEvent(runId, {
          detail: `${paths.length} files at ${pullRequest.headRefOid.slice(0, 7)}`,
          inspector: 'workspace',
          name: 'babysitter.workspace.materialized',
          timestamp: new Date().toISOString(),
          title: 'Workspace materialized',
        }, owner)
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
        let agentConfiguration: ReturnType<typeof sessionAgentConfiguration> | undefined
        try {
          const inspection = await resolveAgentInspectionMetadata(agent, { resolveSources: false })
          agentConfiguration = sessionAgentConfiguration(inspection)
          setSessionAgent(runId, agentConfiguration, owner)
        }
        catch (error) {
          logOperationalError('babysitter.session-agent.failed', error, owner)
        }
        recordSessionEvent(runId, {
          detail: 'Babysitter instructions, Capabilities, tools, and Workspace',
          inspector: 'agent',
          name: 'babysitter.agent.prepared',
          timestamp: new Date().toISOString(),
          title: 'Agent prepared',
        }, owner)
        const prompt = await renderPrompt({ blocker, context })
        recordSessionEvent(runId, {
          detail: 'Pull request context rendered for the Agent Invocation',
          name: 'babysitter.prompt.rendered',
          timestamp: new Date().toISOString(),
          title: 'Prompt prepared',
        }, owner)
        const queuedTimestamp = queuedAt.get(jobKey(repository, pullRequest.number))
        if (queuedTimestamp) {
          recordSessionEvent(runId, {
            detail: queuedLabel,
            group: githubLifecycleGroup,
            kind: 'action',
            label: { color: queuedLabelColor, name: queuedLabel, operation: 'added' },
            name: 'babysitter.github.label.queued',
            phase: 'before',
            timestamp: queuedTimestamp,
            title: `Added ${queuedLabel}`,
          }, owner)
        }
        try {
          lifecycle = await startPullRequestLifecycle(repository, pullRequest.number, runId)
          recordSessionEvent(runId, {
            detail: workingLabel,
            group: githubLifecycleGroup,
            kind: 'action',
            label: { color: workingLabelColor, name: workingLabel, operation: 'added' },
            name: 'babysitter.github.label.working',
            phase: 'before',
            timestamp: new Date().toISOString(),
            title: `Added ${workingLabel}`,
          }, owner)
          recordSessionEvent(runId, {
            delivery: { intent: 'started', kind: 'status' },
            detail: 'Linked the pull request to this Babysitter session',
            group: githubLifecycleGroup,
            kind: 'delivery',
            name: 'babysitter.github.status.started',
            phase: 'before',
            timestamp: new Date().toISOString(),
            title: 'Working status posted',
          }, owner)
          recordSessionEvent(runId, {
            delivery: { intent: 'started', kind: 'reaction' },
            detail: 'GitHub pull request',
            group: githubLifecycleGroup,
            kind: 'delivery',
            name: 'babysitter.github.reaction.started',
            phase: 'before',
            timestamp: new Date().toISOString(),
            title: 'Reacted with eyes',
          }, owner)
        }
        catch (error) {
          logOperationalError('babysitter.github-lifecycle-start.failed', error, owner)
        }
        const result = await runScheduledAgent(agent, {
          ...schedule,
          runId,
        }, {
          run: {
            annotations: {
              'github.head': pullRequest.headRefOid,
              'github.pullRequest': pullRequest.number,
              'github.repository': repository,
              'github.title': pullRequest.title,
              'github.url': pullRequest.url,
              ...(agentConfiguration?.driver?.model?.id ? { 'agent.model.id': agentConfiguration.driver.model.id } : {}),
              ...(agentConfiguration?.driver?.model?.provider ? { 'agent.model.provider': agentConfiguration.driver.model.provider } : {}),
            },
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
      try {
        await finishPullRequestLifecycle(repository, pullRequest.number, lifecycle, { error: failure, text: resultText })
        recordSessionEvent(runId, {
          detail: `${queuedLabel} and ${workingLabel}`,
          group: githubLifecycleGroup,
          kind: 'action',
          ...(lifecycle ? { label: { color: workingLabelColor, name: workingLabel, operation: 'removed' as const } } : {}),
          name: 'babysitter.github.labels.cleared',
          phase: 'after',
          timestamp: new Date().toISOString(),
          title: 'Cleared Agent lifecycle labels',
        }, owner)
        if (lifecycle) {
          recordSessionEvent(runId, {
            delivery: { intent: outcome, kind: 'update' },
            detail: resultText ? 'Posted the Agent final result to the existing GitHub comment' : 'Updated the existing GitHub comment with the session outcome',
            group: githubLifecycleGroup,
            kind: 'delivery',
            name: 'babysitter.github.status.finished',
            phase: 'after',
            timestamp: new Date().toISOString(),
            title: 'GitHub result posted',
          }, owner)
        }
      }
      catch (error) {
        logOperationalError('babysitter.github-lifecycle-finish.failed', error, owner)
      }
      runningJobs.delete(jobKey(repository, pullRequest.number))
      logOperationalEvent('babysitter.owner.finished', {
        durationMs: Date.now() - startedAt,
        outcome,
        ...owner,
      })
    }
  })).then(() => {}).finally(() => {
    logOperationalEvent('babysitter.batch.finished', {
      durationMs: Date.now() - batchStartedAt,
      jobs: jobs.length,
      maxOwners: ownerLimit,
      repositories,
      scheduleId: schedule.runId || schedule.id,
    })
  }).catch(error => logOperationalError('babysitter.batch.failed', error, { scheduleId: schedule.runId }))
  runningBatches.add(batch)
  void batch.finally(() => runningBatches.delete(batch))
}

function jobKey(repository: string, number: number) {
  return `${repository}#${number}`
}

function createSessionSnapshot(
  input: Parameters<ReturnType<typeof useSessionSnapshotStore>['create']>[0],
  owner: { pullRequest: number, repository: string, runId: string },
) {
  try {
    useSessionSnapshotStore().create(input)
  }
  catch (error) {
    logOperationalError('babysitter.session-snapshot.failed', error, owner)
  }
}

function recordSessionEvent(
  runId: string,
  event: SessionTimelineEvent,
  owner: { pullRequest: number, repository: string, runId: string },
) {
  try {
    useSessionSnapshotStore().record(runId, event)
  }
  catch (error) {
    logOperationalError('babysitter.session-event.failed', error, { event: event.name, ...owner })
  }
}

function setSessionPaths(
  runId: string,
  paths: readonly string[],
  owner: { pullRequest: number, repository: string, runId: string },
) {
  try {
    useSessionSnapshotStore().setPaths(runId, paths)
  }
  catch (error) {
    logOperationalError('babysitter.session-workspace.failed', error, owner)
  }
}

function setSessionAgent(
  runId: string,
  configuration: ReturnType<typeof sessionAgentConfiguration>,
  owner: { pullRequest: number, repository: string, runId: string },
) {
  try {
    useSessionSnapshotStore().setAgent(runId, configuration)
  }
  catch (error) {
    logOperationalError('babysitter.session-agent-store.failed', error, owner)
  }
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
