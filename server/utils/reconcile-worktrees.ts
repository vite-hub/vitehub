import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { kv } from '@vite-hub/kv'
import { useServerEnv } from '#vitehub/env/server'

const exec = promisify(execFile)

type PullRequest = {
  body: string
  headRefName: string
  headRefOid: string
  isDraft: boolean
  mergeStateStatus: string
  number: number
  reviewDecision: string | null
  state: string
  statusCheckRollup: unknown
  title: string
  updatedAt: string
  url: string
}

const pullRequestFields = 'body,headRefName,headRefOid,isDraft,mergeStateStatus,number,reviewDecision,state,statusCheckRollup,title,updatedAt,url'

export async function reconcileWorktrees(activePullRequests = new Set<number>()) {
  const { repository, repositoryPath, worktreesPath } = useServerEnv().vitehub
  await mkdir(worktreesPath, { recursive: true })
  const pullRequests = JSON.parse((await exec('gh', `pr list --repo ${repository} --state open --limit 100 --json ${pullRequestFields}`.split(' '))).stdout) as PullRequest[]
  const openNumbers = new Set(pullRequests.map(pr => pr.number))

  // Only open PRs keep managed worktrees; closed PR state is safe to delete.
  for (const entry of await readdir(worktreesPath, { withFileTypes: true })) {
    const match = entry.isDirectory() ? /^pr-(\d+)$/.exec(entry.name) : null
    if (!match) continue
    const number = Number(match[1])
    if (openNumbers.has(number) || activePullRequests.has(number)) continue
    await exec('git', ['-C', repositoryPath, 'worktree', 'remove', '--force', join(worktreesPath, entry.name)])
    await kv.del(completionKey(repository, number))
  }

  const jobs = []
  for (const pr of pullRequests) {
    if (activePullRequests.has(pr.number)) continue
    const worktreePath = join(worktreesPath, `pr-${pr.number}`)

    await exec('git', ['-C', repositoryPath, 'fetch', 'origin', `pull/${pr.number}/head`])
    const currentHead = await exec('git', ['-C', worktreePath, 'rev-parse', 'HEAD'])
      .then(result => result.stdout.trim(), () => undefined)
    // Readiness evidence belongs to one exact head, so worktrees never merge revisions.
    if (currentHead !== pr.headRefOid) {
      if (currentHead) {
        await exec('git', ['-C', worktreePath, 'reset', '--hard', pr.headRefOid])
        await exec('git', ['-C', worktreePath, 'clean', '-fd'])
      }
      else {
        await exec('git', ['-C', repositoryPath, 'worktree', 'add', '--detach', worktreePath, pr.headRefOid])
      }
      await exec('corepack', ['pnpm', 'install', '--frozen-lockfile'], { cwd: worktreePath })
    }

    const fingerprint = pullRequestFingerprint(pr)
    const key = completionKey(repository, pr.number)
    // Avoid noisy reruns until the head or observed GitHub state changes.
    if (await kv.get(key) === fingerprint) continue
    jobs.push({
      completionKey: key,
      fingerprint,
      headRefName: pr.headRefName,
      headRefOid: pr.headRefOid,
      number: pr.number,
      repository,
      title: pr.title,
      url: pr.url,
      worktreePath,
    })
  }
  return jobs
}

export async function readPullRequest(repository: string, number: number) {
  return JSON.parse((await exec('gh', ['pr', 'view', String(number), '--repo', repository, '--json', pullRequestFields])).stdout) as PullRequest
}

export function pullRequestFingerprint(pullRequest: PullRequest) {
  return createHash('sha256').update(JSON.stringify(pullRequest)).digest('hex').slice(0, 16)
}

function completionKey(repository: string, number: number) {
  return `babysitter/${repository}/pull-requests/${number}`
}
