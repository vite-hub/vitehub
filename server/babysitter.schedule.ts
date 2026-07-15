import { runAgent } from '@vite-hub/agent'
import { kv } from '@vite-hub/kv'
import { renderMarkdownTemplate } from '@vite-hub/markdown-template'
import { defineSchedule } from '@vite-hub/schedule'
import babysitter from './agents/babysitter/agent.ts'
import blocker from './agents/babysitter/blocker.md?raw'
import promptTemplate from './agents/babysitter/prompt.md?raw'
import { pullRequestFingerprint, readPullRequest, reconcileWorktrees } from './utils/reconcile-worktrees.ts'

const activeOwners = new Map<number, Promise<void>>()

export default defineSchedule({
  cron: '*/5 * * * *',
  async handler(schedule) {
    for (const job of await reconcileWorktrees(new Set(activeOwners.keys()))) {
      if (activeOwners.has(job.number)) continue
      if (activeOwners.size >= 6) break

      let owner: Promise<void>
      owner = Promise.resolve()
        .then(async () => {
          const memo = new Map<string, unknown>()
          const context = {
            pullRequestHead: job.headRefOid,
            pullRequestNumber: job.number,
            pullRequestRepository: job.repository,
            pullRequestSourceBranch: job.headRefName,
            pullRequestTitle: job.title,
            pullRequestUrl: job.url,
          }
          await runAgent(babysitter, {
            memo(key, create) {
              if (!memo.has(key)) memo.set(key, create())
              return memo.get(key) as never
            },
            run: { runId: `${schedule.runId || schedule.id}:pr-${job.number}:${job.fingerprint}` },
            runtime: 'unknown',
            waitUntil() {},
          }, {
            abortSignal: AbortSignal.timeout(60 * 60 * 1000),
            context,
            options: { worktreePath: job.worktreePath },
            prompt: await renderMarkdownTemplate(promptTemplate, { data: { blocker, context } }),
          })
          const pullRequest = await readPullRequest(job.repository, job.number)
          if (pullRequest.state === 'OPEN' && /<!-- babysitter:blocker:v1 -->[\s\S]*?<!-- \/babysitter:blocker:v1 -->/.test(pullRequest.body)) {
            await kv.set(job.completionKey, pullRequestFingerprint(pullRequest))
          }
        })
        .catch(error => console.error(new Error(`Babysitter failed for PR #${job.number}.`, { cause: error })))
        .finally(() => {
          if (activeOwners.get(job.number) === owner) activeOwners.delete(job.number)
        })
      activeOwners.set(job.number, owner)
    }
    schedule.waitUntil(Promise.all(activeOwners.values()))
  },
})
