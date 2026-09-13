import { execFile } from 'node:child_process'
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import { prepareGitHubPullRequestWorkspace } from '../src/server/github-checkout.ts'

const exec = promisify(execFile)
const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
const git = async (cwd: string, ...args: string[]) => (await exec('git', args, { cwd })).stdout.trim()
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'vitehub-pr-git-'))
  roots.push(root)
  const source = join(root, 'source')
  const target = join(root, 'provider')
  await mkdir(source)
  await mkdir(target)
  await git(source, 'init', '-b', 'feature')
  await git(source, 'config', 'user.name', 'Test')
  await git(source, 'config', 'user.email', 'test@example.com')
  await git(source, 'remote', 'add', 'origin', 'https://github.com/acme/base.git')
  await git(source, 'remote', 'set-url', '--push', 'origin', 'https://github.com/contributor/fork.git')
  await writeFile(join(source, 'file.txt'), 'before\n')
  await git(source, 'add', '.')
  await git(source, 'commit', '-m', 'base')
  await cp(join(source, 'file.txt'), join(target, 'file.txt'))
  return { root, source, target, head: await git(source, 'rev-parse', 'HEAD') }
}

it.each(['--local', '--worktree'] as const)('strips explicit Git passwords from %s configuration', async (scope) => {
  const { source, target } = await fixture()
  if (scope === '--worktree') await git(source, 'config', 'extensions.worktreeConfig', 'true')
  const passwords = ['sendemail.smtpPass', 'sendemail.work.smtpPass', 'imap.pass']
  for (const key of passwords) {
    await git(source, 'config', scope, key, 'host-password-secret')
  }
  await prepareGitHubPullRequestWorkspace(source, target)
  for (const key of passwords) {
    await expect(git(target, 'config', scope, '--get', key)).rejects.toThrow()
    expect(await git(source, 'config', scope, '--get', key)).toBe('host-password-secret')
  }
  const configFile = scope === '--local' ? 'config' : 'config.worktree'
  expect(await readFile(join(target, '.git', configFile), 'utf8')).not.toContain('host-password-secret')
})

