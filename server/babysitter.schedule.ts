import { execFile } from 'node:child_process'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { runScheduledAgent } from 'vite-hub/agent'
import { kv } from 'vite-hub/kv'
import { defineSchedule } from 'vite-hub/schedule'
import { useServerEnv } from '#vitehub/env/server'
import babysitter from './agents/babysitter/agent.ts'
import blocker from './agents/babysitter/blocker.md?raw'
import renderPrompt from './agents/babysitter/prompt.template.md'
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
    const config = useServerEnv().babysitter
    const repositories = resolveRepositories(config.repositories, config.repository)
    const jobs = await selectPullRequestJobs(repositories, resolveMaxOwners(config.maxOwners), listPullRequests, key => kv.get<string>(key))

    await Promise.all(jobs.map(async job => {
      const { pullRequest, repository } = job
      try {
        const checkout = await prepareCheckout(repository, pullRequest)
        try {
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
        }
        finally {
          await rm(checkout, { force: true, recursive: true })
        }

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

async function prepareCheckout(repository: string, pullRequest: PullRequest) {
  const checkout = await mkdtemp(join(tmpdir(), `babysitter-${repository.replace('/', '-')}-pr-${pullRequest.number}-`))
  try {
    await exec('gh', ['repo', 'clone', repository, checkout, '--', '--filter=blob:none', '--no-checkout'])
    await exec('gh', ['pr', 'checkout', String(pullRequest.number), '--repo', repository, '--detach'], { cwd: checkout })
    await exec('git', ['-C', checkout, 'remote', 'set-url', 'origin', `https://github.com/${repository}.git`])
    const pushUrl = pullRequest.headRepository
      ? `https://github.com/${pullRequest.headRepository.nameWithOwner}.git`
      : 'disabled://pull-request-head-repository-unavailable'
    await exec('git', ['-C', checkout, 'remote', 'set-url', '--push', 'origin', pushUrl])
    const fetched = (await exec('git', ['-C', checkout, 'rev-parse', 'HEAD'])).stdout.trim()
    if (fetched !== pullRequest.headRefOid) throw new Error(`PR head changed from ${pullRequest.headRefOid} to ${fetched}`)
    const installArgs = ['pnpm', 'install', '--frozen-lockfile']
    if (!await access(join(checkout, 'pnpm-workspace.yaml')).then(() => true, () => false)) installArgs.push('--ignore-workspace')
    await exec('corepack', installArgs, { cwd: checkout })
    return checkout
  }
  catch (error) {
    await rm(checkout, { force: true, recursive: true })
    throw error
  }
}
