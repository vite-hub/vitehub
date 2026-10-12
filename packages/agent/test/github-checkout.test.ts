import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import { createGitHubHost, prepareGitHubPullRequestWorkspace } from '../src/server/github.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, lstat: vi.fn(original.lstat), readdir: vi.fn(original.readdir) }
})

const exec = promisify(execFile)
const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
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

it('preserves independent ancestry and source push destination, replacing stale metadata without credentials', async () => {
  const { source, target, head } = await fixture()
  await git(target, 'init')
  await git(target, 'config', 'stale.value', 'yes')
  await git(source, 'config', 'credential.helper', 'secret-helper')
  await git(source, 'config', 'http.https://github.com/.extraheader', 'Authorization: secret')
  await prepareGitHubPullRequestWorkspace(source, target)
  expect(await git(target, 'rev-parse', 'HEAD')).toBe(head)
  expect(await git(target, 'remote', 'get-url', 'origin')).toBe('https://github.com/acme/base.git')
  expect(await git(target, 'remote', 'get-url', '--push', 'origin')).toBe('https://github.com/contributor/fork.git')
  const config = await readFile(join(target, '.git/config'), 'utf8')
  expect(config).not.toMatch(/secret|stale/)
  await writeFile(join(target, 'file.txt'), 'repair\n')
  await git(target, 'add', '.')
  await git(target, 'commit', '-m', 'repair')
  expect(await git(target, 'rev-parse', 'HEAD^')).toBe(head)
  expect(await git(source, 'rev-parse', 'HEAD')).toBe(head)
  expect(await git(source, 'status', '--porcelain')).toBe('')
})

it('rejects shared directories, linked worktrees, and cancelled preparation', async () => {
  const { root, source, target } = await fixture()
  await expect(prepareGitHubPullRequestWorkspace(source, source)).rejects.toThrow('must be separate')
  await expect(prepareGitHubPullRequestWorkspace(source, root)).rejects.toThrow('must be separate')
  const linked = join(root, 'linked')
  await git(source, 'worktree', 'add', '--detach', linked)
  await expect(prepareGitHubPullRequestWorkspace(linked, target)).rejects.toThrow('independent prepared Git clone')
  await expect(prepareGitHubPullRequestWorkspace(source, target, { signal: AbortSignal.abort() })).rejects.toThrow()
})

it('supplies Git credentials without running the GitHub CLI', async () => {
  const { source } = await fixture()
  const host = createGitHubHost({ credentials: () => ({ token: 'test-token', rateLimitKey: 'test' }) })
  const { env } = await host.access()
  const result = await new Promise<string>((resolve, reject) => {
    const child = execFile('git', ['credential', 'fill'], { cwd: source, env: { ...process.env, ...env } }, (error, stdout) => error ? reject(error) : resolve(stdout))
    child.stdin!.end('protocol=https\nhost=github.com\n\n')
  })
  expect(result).toContain('username=x-access-token')
  expect(result).toContain('password=test-token')
})

it('records repair publication before post-push validation while retaining source head leases', async () => {
  const { root, source, target, head: staleHead } = await fixture()
  const fork = join(root, 'fork.git')
  await git(root, 'clone', '--bare', source, fork)
  await git(source, 'update-ref', 'refs/pull/123/head', staleHead)
  await writeFile(join(source, 'file.txt'), 'new head\n')
  await git(source, 'commit', '-am', 'new head')
  const headSha = await git(source, 'rev-parse', 'HEAD')
  await git(source, 'push', fork, 'feature')
  const bin = join(root, 'bin')
  await mkdir(bin)
  const realGit = (await exec('which', ['git'])).stdout.trim()
  await writeFile(join(bin, 'gh'), '#!/bin/sh\necho "gh must not run" >&2\nexit 1\n', { mode: 0o755 })
  // Run real Git against local repositories. Only the network URL boundary is replaced.
  await writeFile(join(bin, 'git'), `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const map = ${JSON.stringify({ 'https://github.com/acme/base.git': source, 'https://github.com/contributor/fork.git': fork })};
const args = process.argv.slice(2).map(arg => map[arg] || arg);
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
`, { mode: 0o755 })
  const globalConfig = join(root, 'global.gitconfig')
  const globalHooks = join(root, 'global-hooks')
  await mkdir(globalHooks)
  await writeFile(join(globalHooks, 'post-checkout'), '#!/bin/sh\nexit 99\n', { mode: 0o755 })
  await writeFile(globalConfig, `[core]\n hooksPath = ${globalHooks}\n`)
  vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig)
  vi.stubEnv('PATH', `${bin}:${process.env.PATH}`)
  const credentials = vi.fn(({ repository }: { repository?: string }) => ({ token: repository ?? 'default', rateLimitKey: repository ?? 'default' }))
  const host = createGitHubHost({ credentials })
  const pr = { repository: 'acme/base', headRepository: 'contributor/fork', headRef: 'feature', headSha, number: 123 }
  await host.withPullRequestCheckout(pr, async checkout => {
    expect(await git(checkout.path, 'rev-parse', 'HEAD')).toBe(headSha)
    await cp(join(checkout.path, 'file.txt'), join(target, 'file.txt'))
    await checkout.prepareWorkspace(target)
    await git(target, 'config', 'user.name', 'Test')
    await git(target, 'config', 'user.email', 'test@example.com')
    await writeFile(join(target, 'file.txt'), 'repair\n')
    await git(target, 'commit', '-am', 'repair')
    const repair = await git(target, 'rev-parse', 'HEAD')
    await git(target, 'remote', 'set-url', '--push', 'origin', 'disabled://worker-controlled')
    const hooks = join(root, 'worker-hooks')
    await mkdir(hooks)
    const hookMarker = join(root, 'hook-ran')
    await writeFile(join(hooks, 'pre-push'), `#!/bin/sh\ntouch '${hookMarker}'\n`, { mode: 0o755 })
    await git(target, 'config', 'core.hooksPath', hooks)
    // Custody can change while host credentials are being refreshed.
    let custody = true
    credentials.mockImplementationOnce(({ repository }) => {
      custody = false
      return { token: repository ?? 'default', rateLimitKey: repository ?? 'default' }
    })
    await expect(checkout.push(target, { beforePush: () => {
      if (!custody) throw new DOMException('Lease lost', 'AbortError')
    } })).rejects.toThrow('Lease lost')
    expect(await git(fork, 'rev-parse', 'feature')).toBe(headSha)
    const pushController = new AbortController()
    credentials.mockImplementationOnce(({ repository }) => {
      pushController.abort(new DOMException('Lease expired', 'AbortError'))
      return { token: repository ?? 'default', rateLimitKey: repository ?? 'default' }
    })
    await expect(checkout.push(target, { signal: pushController.signal })).rejects.toThrow('Lease expired')
    expect(await git(fork, 'rev-parse', 'feature')).toBe(headSha)
    let receipt: string | undefined
    const receiptController = new AbortController()
    await expect(checkout.push(target, {
      signal: receiptController.signal,
      beforePush: async () => {
        // The base fence belongs before publication; the remote still has the old head.
        expect(await git(fork, 'rev-parse', 'feature')).toBe(headSha)
      },
      afterPush: async head => {
        receipt = head
        expect(await git(fork, 'rev-parse', 'feature')).toBe(head)
        receiptController.abort(new DOMException('Lease expired after publication', 'AbortError'))
      },
    })).rejects.toThrow('Lease expired after publication')
    expect(receipt).toBe(repair)
    expect(await checkout.push(target)).toBe(repair)
    await expect(readFile(hookMarker)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await git(fork, 'rev-parse', 'feature')).toBe(repair)
    expect(await git(target, 'rev-parse', 'HEAD^')).toBe(headSha)
    await git(source, 'fetch', fork, 'feature')
    await git(source, 'reset', '--hard', 'FETCH_HEAD')
    await writeFile(join(source, 'file.txt'), 'external update\n')
    await git(source, 'commit', '-am', 'external update')
    await git(source, 'push', fork, 'feature')
    const external = await git(source, 'rev-parse', 'HEAD')
    // A second push cannot overwrite a branch changed by another actor.
    await writeFile(join(target, 'file.txt'), 'second repair\n')
    await git(target, 'commit', '-am', 'second repair')
    await expect(checkout.push(target)).rejects.toThrow()
    expect(await git(fork, 'rev-parse', 'feature')).toBe(external)
  })
  expect(credentials.mock.calls.some(([scope]) => scope.repository === 'contributor/fork')).toBe(true)
  await expect(host.withPullRequestCheckout(pr, async () => { throw new Error('must not run') })).rejects.toThrow('head changed')
  await expect(host.withPullRequestCheckout({ ...pr, headRef: '../invalid' }, async () => {})).rejects.toThrow()
  const baseHead = await git(source, 'rev-parse', 'HEAD')
  await host.withPullRequestCheckout({ ...pr, headRepository: pr.repository, headSha: baseHead }, async checkout => {
    expect(await git(checkout.path, 'rev-parse', 'HEAD')).toBe(baseHead)
  })
  await host.withPullRequestCheckout({ repository: pr.repository, number: 124, headSha: baseHead }, async checkout => {
    expect(await git(checkout.path, 'rev-parse', 'HEAD')).toBe(baseHead)
    await expect(git(checkout.path, 'symbolic-ref', 'HEAD')).rejects.toThrow()
    await expect(checkout.push()).rejects.toThrow('source repository and branch are required')
  })
  let replacement: string | undefined
  await host.withPullRequestCheckout({ repository: pr.repository, number: 125, headSha: baseHead }, async checkout => {
    const moved = `${checkout.path}-moved`
    replacement = checkout.path
    await rename(checkout.path, moved)
    await mkdir(checkout.path)
    await writeFile(join(checkout.path, 'replacement'), 'preserve\n')
  })
  expect(await readFile(join(replacement!, 'replacement'), 'utf8')).toBe('preserve\n')
  roots.push(replacement!, `${replacement!}-moved`)
  expect(await readdir(`${replacement!}-moved`)).toEqual([])

  // Swap the candidate after the parent receives its matching identity, but
  // before the worker resolves cwd. The replacement must stay at its path,
  // and rediscovery must still clean the moved checkout.
  const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  let raced = false
  let candidate = ''
  await host.withPullRequestCheckout({ repository: pr.repository, number: 127, headSha: baseHead }, async checkout => {
    candidate = checkout.path
    roots.push(candidate, `${candidate}-moved`)
    vi.mocked(fs.lstat).mockImplementation(async (path, options) => {
      const identity = await original.lstat(path, options)
      if (!raced && path === candidate) {
        raced = true
        await rename(candidate, `${candidate}-moved`)
        await mkdir(candidate)
        await writeFile(join(candidate, 'replacement'), 'preserve')
      }
      return identity
    })
  })
  expect(raced).toBe(true)
  expect(await readFile(join(candidate, 'replacement'), 'utf8')).toBe('preserve')
  expect(await readdir(`${candidate}-moved`)).toEqual([])
  vi.mocked(fs.lstat).mockImplementation(original.lstat)
  // Moving outside the discovery parent must preserve both callback outcomes.
  for (const fails of [false, true]) {
    const failure = new Error('callback failure')
    const moved = join(root, `outside-${fails}`)
    const result = host.withPullRequestCheckout({ repository: pr.repository, number: 128, headSha: baseHead }, async checkout => {
      await rename(checkout.path, moved)
      if (fails) throw failure
      return 'callback result'
    })
    if (fails) await expect(result).rejects.toBe(failure)
    else await expect(result).resolves.toBe('callback result')
    expect(await readFile(join(moved, 'file.txt'), 'utf8')).toBe('external update\n')
  }
  // A discovery error must not replace either callback outcome.
  for (const fails of [false, true]) {
    const failure = new Error('callback failure')
    const result = host.withPullRequestCheckout({ repository: pr.repository, number: 129, headSha: baseHead }, async checkout => {
      roots.push(checkout.path)
      vi.mocked(fs.readdir).mockRejectedValue(Object.assign(new Error('discovery failed'), { code: 'EACCES' }))
      if (fails) throw failure
      return 'callback result'
    })
    if (fails) await expect(result).rejects.toBe(failure)
    else await expect(result).resolves.toBe('callback result')
    vi.mocked(fs.readdir).mockImplementation(original.readdir)
  }
}, 30_000)
