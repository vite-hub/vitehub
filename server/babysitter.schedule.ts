import { createMessage, runScheduledAgent } from 'vite-hub/agent'
import { kv } from 'vite-hub/kv'
import { defineSchedule } from 'vite-hub/schedule'
import { useServerEnv } from '#vitehub/env/server'
import { createBabysitterAgent } from './agents/babysitter/agent.ts'
import blocker from './agents/babysitter/blocker.md?raw'
import renderPrompt from './agents/babysitter/prompt.template.md'
import { withPullRequestCheckout } from './babysitter.checkout.ts'
import { githubToken, runGitHub } from './github.ts'
import {
  logOperationalError,
  logOperationalEvent,
} from './babysitter.operations.ts'
import {
  type PullRequest,
  completedPassFingerprint,
  resolveMaxOwners,
  resolveRepositories,
  runPullRequestJobs,
  selectPullRequestJobs,
} from './babysitter.queue.ts'

const pullRequestFields = 'body,comments,headRefName,headRefOid,headRepository,isDraft,mergeStateStatus,number,reviewDecision,reviews,state,statusCheckRollup,title,updatedAt,url'
export default defineSchedule({
  cron: '*/5 * * * *',
  async handler(schedule) {
    const {maxOwners, repositories: configuredRepositories, repository} = useServerEnv().babysitter
    const repositories = resolveRepositories(configuredRepositories, repository)
    const jobs = await selectPullRequestJobs(repositories, listPullRequests, readCompletion)
    const ownerLimit = resolveMaxOwners(maxOwners)
    let activeOwners = 0
    const batchStartedAt = Date.now()

    logOperationalEvent('babysitter.batch.started', {
      jobs: jobs.length,
      maxOwners: ownerLimit,
      repositories,
      scheduleId: schedule.runId || schedule.id,
    })
    try {
      await runPullRequestJobs(jobs, ownerLimit, async job => {
        const { pullRequest, repository } = job
        const runId = `${schedule.runId || schedule.id}:${repository}:pr-${pullRequest.number}:${job.fingerprint}`
        const owner = { pullRequest: pullRequest.number, repository, runId }
        const startedAt = Date.now()
        let outcome = 'completed'
        activeOwners += 1
        logOperationalEvent('babysitter.owner.started', {
          activeOwners,
          head: pullRequest.headRefOid,
          maxOwners: ownerLimit,
          ...owner,
        })
        try {
          const token = await githubToken({ refresh: true, repository })
          const passResult = await withPullRequestCheckout(repository, pullRequest, token, async checkout => {
            const context = {
              pullRequestHead: pullRequest.headRefOid,
              pullRequestNumber: pullRequest.number,
              pullRequestRepository: repository,
              pullRequestSourceBranch: pullRequest.headRefName,
              pullRequestSourceRepository: pullRequest.headRepository?.nameWithOwner || '(unavailable)',
              pullRequestTitle: pullRequest.title,
              pullRequestUrl: pullRequest.url,
            }
            return await runScheduledAgent(createBabysitterAgent(checkout, token), {
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
                },
                runId,
              },
            }, {
              abortSignal: AbortSignal.timeout(55 * 60 * 1000),
              context,
              messages: [createMessage({ role: 'user', text: await renderPrompt({ blocker, context }) })],
            })
          })

          const current = await readPullRequest(repository, pullRequest.number)
          const fingerprint = completedPassFingerprint(repository, current, passResult)
          if (fingerprint) {
            const [error] = await kv.set(job.completionKey, fingerprint)
            if (error) throw error
          }
          else if (current.state === 'OPEN') {
            outcome = 'retry'
          }
        }
        catch (error) {
          outcome = 'failed'
          logOperationalError('babysitter.owner.failed', error, owner)
        }
        finally {
          activeOwners -= 1
          logOperationalEvent('babysitter.owner.finished', {
            durationMs: Date.now() - startedAt,
            outcome,
            ...owner,
          })
        }
      })
    }
    finally {
      logOperationalEvent('babysitter.batch.finished', {
        durationMs: Date.now() - batchStartedAt,
        jobs: jobs.length,
        maxOwners: ownerLimit,
        repositories,
        scheduleId: schedule.runId || schedule.id,
      })
    }
  },
})

async function readCompletion(key: string) {
  const [error, value] = await kv.get<string>(key)
  if (error) throw error
  return value
}

async function listPullRequests(repository: string) {
  const result = await runGitHub(['pr', 'list', '--repo', repository, '--state', 'open', '--limit', '100', '--json', pullRequestFields], { repository })
  return JSON.parse(result.stdout) as PullRequest[]
}

async function readPullRequest(repository: string, number: number) {
  const result = await runGitHub(['pr', 'view', String(number), '--repo', repository, '--json', pullRequestFields], { repository })
  return JSON.parse(result.stdout) as PullRequest
}
