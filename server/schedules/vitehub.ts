import { type AgentRuntimeContext, runAgent } from '@vite-hub/agent'
import { kv } from '@vite-hub/kv'
import { defineSchedule } from '@vite-hub/schedule'
import babysitter from '../agents/babysitter/config.ts'
import instructions from '../agents/babysitter/instructions.md?raw'
import { createAgentOwnerPool } from '../utils/agent-owner-pool.ts'
import { pullRequestFingerprint, readPullRequest, reconcileWorktrees } from '../utils/reconcile-worktrees.ts'

const blockerMarkers = [
  '<!-- babysitter:blocker:v1 -->',
  '> [!WARNING]',
  '<!-- /babysitter:blocker:v1 -->',
]

type Job = Awaited<ReturnType<typeof reconcileWorktrees>>[number] & {
  runId: string
}

const owners = createAgentOwnerPool<Job>({
  onError(job, error) {
    console.error(new Error(`Babysitter failed for PR #${job.number}.`, { cause: error }))
  },
  async run(job) {
    const memo = new Map<string, unknown>()
    const agentContext: AgentRuntimeContext = {
      memo(key, create) {
        if (!memo.has(key)) memo.set(key, create())
        return memo.get(key) as never
      },
      run: { runId: job.runId },
      runtime: 'unknown',
      waitUntil() {},
    }
    const prompt = instructions
      .replaceAll('{{ context.pullRequestHead }}', job.headRefOid)
      .replaceAll('{{ context.pullRequestNumber }}', String(job.number))
      .replaceAll('{{ context.pullRequestRepository }}', job.repository)
      .replaceAll('{{ context.pullRequestSourceBranch }}', job.headRefName)
      .replaceAll('{{ context.pullRequestTitle }}', job.title)
      .replaceAll('{{ context.pullRequestUrl }}', job.url)
    await runAgent(babysitter, agentContext, {
      abortSignal: AbortSignal.timeout(60 * 60 * 1000),
      context: {
        pullRequestHead: job.headRefOid,
        pullRequestNumber: job.number,
        pullRequestRepository: job.repository,
        pullRequestSourceBranch: job.headRefName,
        pullRequestTitle: job.title,
        pullRequestUrl: job.url,
      },
      options: { worktreePath: job.worktreePath },
      prompt,
    })
    const pullRequest = await readPullRequest(job.repository, job.number)
    if (pullRequest.state === 'OPEN' && blockerMarkers.every(marker => pullRequest.body.includes(marker))) {
      await kv.set(job.completionKey, pullRequestFingerprint(pullRequest))
    }
  },
})

export default defineSchedule({
  cron: '*/5 * * * *',
  async handler(schedule) {
    const jobs = await reconcileWorktrees(owners.activePullRequests())
    owners.summon(jobs.map(job => ({
      ...job,
      runId: `${schedule.runId || schedule.id}:pr-${job.number}:${job.fingerprint}`,
    })))
    schedule.waitUntil(owners.settle())
  },
})
