import { execFile } from 'node:child_process'
import { cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
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

it('keeps omitted files and generated instructions out of plain workspace repairs', async () => {
  const { source, target, head } = await fixture()
  await writeFile(join(source, 'omitted.txt'), 'preserve me\n')
  await git(source, 'add', '.')
  await git(source, 'commit', '-m', 'unmaterialized file')
  const expected = await git(source, 'rev-parse', 'HEAD')
  await writeFile(join(target, 'AGENTS.md'), 'generated instructions\n')
  await writeFile(join(target, 'generated[1].txt'), 'generated\n')
  await prepareGitHubPullRequestWorkspace(source, target)
  expect(await git(target, 'status', '--porcelain')).toBe('')
  expect(await git(target, 'diff', '--cached', '--name-only')).toBe('')
  await writeFile(join(target, 'file.txt'), 'repair\n')
  await git(target, 'add', '-A')
  await git(target, 'commit', '-m', 'repair')
  expect(await git(target, 'rev-parse', 'HEAD^')).toBe(expected)
  expect(await git(target, 'diff', 'HEAD^', 'HEAD', '--name-only')).toBe('file.txt')
  expect(await git(target, 'show', 'HEAD:omitted.txt')).toBe('preserve me')
  expect(await git(target, 'show', `${head}:file.txt`)).toBe('before')
})
