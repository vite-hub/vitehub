import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { PullRequest } from './babysitter.queue.ts'

type RunCommand = (file: string, args: string[], options?: { cwd?: string, env?: NodeJS.ProcessEnv }) => Promise<{ stdout: string }>

type CheckoutOperations = {
  makeTemporaryDirectory: (prefix: string) => Promise<string>
  remove: (path: string, options: { force: boolean, recursive: boolean }) => Promise<void>
  runCommand: RunCommand
}

const operations: CheckoutOperations = {
  makeTemporaryDirectory: mkdtemp,
  remove: rm,
  runCommand: promisify(execFile) as RunCommand,
}

export function createCheckoutGitEnvironment(checkout: string) {
  return {
    GIT_DIR: join(checkout, '.git'),
    GIT_WORK_TREE: '.',
  }
}

export async function readWorkspacePaths(checkout: string, runCommand: RunCommand = operations.runCommand) {
  const result = await runCommand('git', ['-C', checkout, 'ls-tree', '-r', '--name-only', '-z', 'HEAD'])
  return result.stdout.split('\0').filter(Boolean)
}

export async function withPullRequestCheckout<T>(
  repository: string,
  pullRequest: PullRequest,
  githubToken: string,
  runOwner: (checkout: string) => Promise<T>,
  checkoutOperations: CheckoutOperations = operations,
) {
  const checkout = await checkoutOperations.makeTemporaryDirectory(join(tmpdir(), `babysitter-${repository.replace('/', '-')}-pr-${pullRequest.number}-`))
  try {
    const env = { ...process.env, GH_TOKEN: githubToken }
    await checkoutOperations.runCommand('gh', ['repo', 'clone', repository, checkout, '--', '--filter=blob:none', '--no-checkout'], { env })
    await checkoutOperations.runCommand('gh', ['pr', 'checkout', String(pullRequest.number), '--repo', repository, '--detach'], { cwd: checkout, env })
    await checkoutOperations.runCommand('git', ['-C', checkout, 'remote', 'set-url', 'origin', `https://github.com/${repository}.git`])
    const pushUrl = pullRequest.headRepository
      ? `https://github.com/${pullRequest.headRepository.nameWithOwner}.git`
      : 'disabled://pull-request-head-repository-unavailable'
    await checkoutOperations.runCommand('git', ['-C', checkout, 'remote', 'set-url', '--push', 'origin', pushUrl])
    const fetched = (await checkoutOperations.runCommand('git', ['-C', checkout, 'rev-parse', 'HEAD'])).stdout.trim()
    if (fetched !== pullRequest.headRefOid) throw new Error(`PR head changed from ${pullRequest.headRefOid} to ${fetched}`)
    return await runOwner(checkout)
  }
  finally {
    await checkoutOperations.remove(checkout, { force: true, recursive: true })
  }
}
