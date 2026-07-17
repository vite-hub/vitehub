import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { runScheduledAgent } from 'vite-hub/agent'
import { kv } from 'vite-hub/kv'
import { defineSchedule } from 'vite-hub/schedule'
import { useServerEnv } from '#vitehub/env/server'
import babysitter from './agents/babysitter/agent.ts'
import blocker from './agents/babysitter/blocker.md?raw'
import renderPrompt from './agents/babysitter/prompt.template.md'
import { withPullRequestCheckout } from './babysitter.checkout.ts'
import {
  type PullRequest,
  pullRequestFingerprint,
  resolveMaxOwners,
  resolveRepositories,
  selectPullRequestJobs,
} from './babysitter.queue.ts'

const exec = promisify(execFile)
const pullRequestFields = 'body,headRefName,headRefOid,headRepository,isDraft,mergeStateStatus,number,reviewDecision,state,statusCheckRollup,title,updatedAt,url'
const blockerPattern = /<!-- babysitter:blocker:v1 -->[\s\S]*?<!-- \/babysitter:blocker:v1 -->/

export default defineSchedule({
  cron: '*/5 * * * *',
  async handler(schedule) {
    const {maxOwners, repositories: configuredRepositories, repository} = useServerEnv().babysitter
    const repositories = resolveRepositories(configuredRepositories, repository)
    const jobs = await selectPullRequestJobs(repositories, resolveMaxOwners(maxOwners), listPullRequests, key => kv.get<string>(key))

    await Promise.all(jobs.map(async job => {
      const { pullRequest, repository } = job
      try {
        await withPullRequestCheckout(repository, pullRequest, async checkout => {
          const context = {
            pullRequestHead: pullRequest.headRefOid,
            pullRequestNumber: pullRequest.number,
            pullRequestRepository: repository,
            pullRequestSourceBranch: pullRequest.headRefName,
            pullRequestSourceRepository: pullRequest.headRepository?.nameWithOwner || '(unavailable)',
            pullRequestTitle: pullRequest.title,
            pullRequestUrl: pullRequest.url,
          }
          await runScheduledAgent(babysitter, {
            ...schedule,
            runId: `${schedule.runId || schedule.id}:${repository}:pr-${pullRequest.number}:${job.fingerprint}`,
          }, {}, {
            abortSignal: AbortSignal.timeout(60 * 60 * 1000),
            context,
            options: { checkout },
            prompt: await renderPrompt({ blocker, context }),
          })
        })

        const current = await readPullRequest(repository, pullRequest.number)
        if (current.state === 'OPEN' && blockerPattern.test(current.body)) {
          await kv.set(job.completionKey, pullRequestFingerprint(repository, current))
        }
      }
      catch (error) {
        console.error(new Error(`Babysitter failed for ${repository} PR #${pullRequest.number}.`, { cause: error }))
      }
    }))
  },
})

async function listPullRequests(repository: string) {
  const result = await exec('gh', ['pr', 'list', '--repo', repository, '--state', 'open', '--limit', '100', '--json', pullRequestFields])
  return JSON.parse(result.stdout) as PullRequest[]
}

async function readPullRequest(repository: string, number: number) {
  const result = await exec('gh', ['pr', 'view', String(number), '--repo', repository, '--json', pullRequestFields])
  return JSON.parse(result.stdout) as PullRequest
}
