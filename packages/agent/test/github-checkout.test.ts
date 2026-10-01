import { execFile } from 'node:child_process'
import { access, cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import { createGitHubHost, prepareGitHubPullRequestWorkspace } from '../src/server/github.ts'

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

it('fetches the fork branch instead of stale PR refs and pushes provider repairs with a head lease', async () => {
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

}, 30_000)

it('reuses a pooled checkout, keeps ignored files, and resets the rest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vitehub-checkout-pool-'))
  roots.push(root)
  const base = join(root, 'base.git')
  const source = join(root, 'source')
  const pool = join(root, 'checkouts')
  await mkdir(source)
  await git(root, 'init', '--bare', base)
  await git(source, 'init', '-b', 'main')
  await git(source, 'config', 'user.name', 'Test')
  await git(source, 'config', 'user.email', 'test@example.com')
  await writeFile(join(source, '.gitignore'), 'node_modules\n')
  await writeFile(join(source, 'file'), 'base')
  await git(source, 'add', '.')
  await git(source, 'commit', '-m', 'base')
  await git(source, 'push', base, 'HEAD:refs/heads/main')
  await git(root, '--git-dir', base, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  const commit = async (branch: string) => {
    await git(source, 'checkout', '-b', branch, 'main')
    await writeFile(join(source, 'file'), branch)
    await git(source, 'commit', '-am', branch)
    await git(source, 'push', base, `HEAD:refs/heads/${branch}`)
    return await git(source, 'rev-parse', 'HEAD')
  }
  const oneSha = await commit('one')
  const twoSha = await commit('two')
  const config = join(root, 'gitconfig')
  await writeFile(config, '')
  await git(root, 'config', '--file', config, `url.file://${base}.insteadOf`, 'https://github.com/base--owner/repo--name.git')
  vi.stubEnv('GIT_CONFIG_GLOBAL', config)
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  vi.stubEnv('GIT_ALLOW_PROTOCOL', 'file')
  const options = {
    checkouts: { root: pool },
    credentials: () => ({ token: 'test-token', rateLimitKey: 'offline-test' }),
    identity: { login: 'Test', email: 'test@example.com' },
  }
  const host = createGitHubHost(options)

  let firstPath = ''
  await host.withPullRequestCheckout({ repository: 'base--owner/repo--name', number: 1, headSha: oneSha, headRepository: 'base--owner/repo--name', headRef: 'one' }, async ({ path }) => {
    firstPath = path
    expect(await git(path, 'rev-parse', 'HEAD')).toBe(oneSha)
    await mkdir(join(path, 'node_modules'), { recursive: true })
    await writeFile(join(path, 'node_modules/marker'), 'warm')
    await writeFile(join(path, 'file'), 'dirty')
    await writeFile(join(path, 'untracked'), 'x')
    await mkdir(join(path, '.git/hooks'), { recursive: true })
    await writeFile(join(path, '.git/hooks/post-checkout'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    await git(path, 'config', 'core.fsmonitor', 'false')
    await mkdir(join(path, '.vitehub'), { recursive: true })
    await writeFile(`${path}.meta.json`, '{}')
  })
  await access(firstPath)

  // A restarted process adopts the checkout that the previous process left in the pool.
  const restarted = createGitHubHost(options)
  await restarted.withPullRequestCheckout({ repository: 'base--owner/repo--name', number: 1, headSha: twoSha, headRepository: 'base--owner/repo--name', headRef: 'two' }, async ({ path }) => {
    expect(path).toBe(firstPath)
    expect(await git(path, 'rev-parse', 'HEAD')).toBe(twoSha)
    expect(await git(path, 'branch', '--show-current')).toBe('two')
    expect(await readFile(join(path, 'file'), 'utf8')).toBe('two')
    expect(await readFile(join(path, 'node_modules/marker'), 'utf8')).toBe('warm')
    await expect(access(join(path, 'untracked'))).rejects.toThrow()
    await expect(access(join(path, '.git/hooks/post-checkout'))).rejects.toThrow()
    await expect(access(join(path, '.vitehub'))).rejects.toThrow()
    await expect(access(`${path}.meta.json`)).rejects.toThrow()
    await expect(git(path, 'config', 'core.fsmonitor')).rejects.toThrow()
    expect(await git(path, 'config', 'remote.origin.pushurl')).toBe('https://github.com/base--owner/repo--name.git')
  })
  let secondPath = ''
  await restarted.withPullRequestCheckout({ repository: 'base--owner/repo--name', number: 2, headSha: oneSha }, async ({ path }) => {
    secondPath = path
    expect(path).not.toBe(firstPath)
    expect(await git(path, 'rev-parse', 'HEAD')).toBe(oneSha)
    await expect(access(join(path, 'node_modules/marker'))).rejects.toThrow()
    expect(await git(path, 'config', 'remote.origin.pushurl')).toMatch(/^disabled:/)
    await expect(git(path, 'config', 'remote.origin.push')).rejects.toThrow()
  })

  // A checkout without a verified head leaves the pool.
  await expect(restarted.withPullRequestCheckout({ repository: 'base--owner/repo--name', number: 2, headSha: twoSha, headRepository: 'base--owner/repo--name', headRef: 'one' }, async () => {
    throw new Error('must not run')
  })).rejects.toThrow('head changed')
  await expect(access(secondPath)).rejects.toThrow()
  expect(await readdir(pool)).toHaveLength(1)
}, 30_000)

it('rejects an empty checkout pool root', () => {
  expect(() => createGitHubHost({ checkouts: { root: ' ' }, credentials: () => ({ token: 'test-token' }) })).toThrow('checkouts.root must be a directory path')
})
