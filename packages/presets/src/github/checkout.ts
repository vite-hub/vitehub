import { execFile } from 'node:child_process'
import { appendFile, cp, lstat, mkdtemp, readdir, realpath, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import { recordProviderCheckout } from '@vite-hub/agent'

const exec = promisify(execFile)

type Git = (cwd: string, args: string[]) => Promise<string>

/** Credentials belong to the host. Never carry saved clone authentication into a worker. */
async function sanitizeProviderGitConfig(git: Git, destination: string): Promise<void> {
  const sensitive = (key: string) => /^credential\.|^include(?:if)?(?:[.:].*)?\.path$|^core\.(?:askpass|sshcommand|hookspath|worktree)$|^sendemail\.(?:.*\.)?smtppass$|^imap\.pass$|^gitcvs\.dbpass$|^http\..*extraheader$|^http\.extraheader$|^http\.(?:.*\.)?(?:proxy|cookiefile|sslkey(?:type|passwordprotected)?|sslcert(?:type|passwordprotected)?|proxysslkey|proxysslcert|proxysslcertpasswordprotected)$/i.test(key) || /^remote\..*\.proxy$/i.test(key)
  const sanitize = async (scope: '--local' | '--worktree') => {
    let config = ''
    try {
      config = await git(destination, ['config', scope, '--name-only', '--list'])
    } catch (error) {
      if (scope === '--local') throw error
      const message = error instanceof Error ? error.message : String(error)
      // Git reports this specific condition when worktree-scoped config is disabled;
      // there is no separate worktree file to inspect in that case. Any other
      // inspection failure must fail closed so credentials cannot leak.
      if (!/worktree.*config.*(?:not enabled|disabled)|extensions\.worktreeconfig/i.test(message)) throw error
    }
    for (const key of new Set(config.split('\n').filter(Boolean))) {
      let remove = sensitive(key)
      if (!remove && /^url\..+\.(?:insteadOf|pushInsteadOf)$/i.test(key)) {
        const base = key.slice(4, key.lastIndexOf('.'))
        if (URL.canParse(base)) {
          const baseUrl = new URL(base)
          remove = Boolean(baseUrl.username || baseUrl.password)
        }
        const values = await git(destination, ['config', scope, '--get-all', key]).catch(() => '')
        remove ||= values.split('\n').some(value => {
          if (!URL.canParse(value)) return false
          const url = new URL(value)
          return Boolean(url.username || url.password)
        })
      }
      if (remove) await git(destination, ['config', scope, '--unset-all', key])
    }
  }
  await sanitize('--local')
  // Authentication can also live in config.worktree when extensions.worktreeConfig is enabled.
  await sanitize('--worktree')
}

/** Resolves a prepared host clone and a provider workspace that neither contains the other. */
async function separateCheckouts(checkout: string, target: string): Promise<{ source: string, destination: string }> {
  const source = await realpath(checkout)
  const destination = await realpath(target)
  const overlaps = (left: string, right: string) => {
    const relation = relative(left, right)
    return !relation || (relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation))
  }
  if (overlaps(source, destination) || overlaps(destination, source)) {
    throw new Error('Provider workspace must be separate from prepared checkout.')
  }
  if (!(await lstat(join(source, '.git'))).isDirectory()) {
    throw new Error('Expected independent prepared Git clone.')
  }
  return { source, destination }
}

function assertRemotesWithoutCredentials(urls: Iterable<string>): void {
  for (const remote of urls) {
    if (URL.canParse(remote)) {
      const url = new URL(remote)
      if (url.username || url.password) throw new Error('Prepared checkout remotes must not contain credentials.')
    }
  }
}

function assertProviderCheckout(matches: boolean): void {
  if (!matches) throw new Error('Provider checkout head or remote mismatch.')
}

/** Restore PR checkout history in a separate materialized provider workspace. */
export async function prepareGitHubPullRequestWorkspace(checkout: string, target: string, options: { signal?: AbortSignal, restoreInstructions?: boolean } = {}): Promise<void> {
  options.signal?.throwIfAborted()
  const { source, destination } = await separateCheckouts(checkout, target)
  // Ignore a caller's Git binding so verification targets each directory's own index.
  const env = { ...process.env }
  delete env.GIT_DIR
  delete env.GIT_WORK_TREE
  delete env.GIT_INDEX_FILE
  delete env.GIT_COMMON_DIR
  delete env.GIT_OBJECT_DIRECTORY
  delete env.GIT_ALTERNATE_OBJECT_DIRECTORIES
  for (const key of Object.keys(env)) if (key.startsWith('GIT_CONFIG_')) delete env[key]
  env.GIT_CONFIG_GLOBAL = '/dev/null'
  env.GIT_CONFIG_NOSYSTEM = '1'
  const git = async (cwd: string, args: string[]) => (await exec('git', args, { cwd, env, signal: options.signal })).stdout.trim()
  // The host checkout already contains complete history; copying must not
  // require network access or credentials in the provider preparation flow.
  const expected = await git(source, ['rev-parse', 'HEAD'])
  const origin = await git(source, ['remote', 'get-url', '--all', 'origin'])
  const push = await git(source, ['remote', 'get-url', '--all', '--push', 'origin'])
  const remotes = await git(source, ['remote'])
  const remoteUrls = new Set<string>()
  for (const name of remotes.split('\n').filter(Boolean)) {
    for (const url of (await git(source, ['remote', 'get-url', '--all', name])).split('\n')) remoteUrls.add(url)
    for (const url of (await git(source, ['remote', 'get-url', '--all', '--push', name])).split('\n')) remoteUrls.add(url)
  }
  assertRemotesWithoutCredentials(remoteUrls)
  options.signal?.throwIfAborted()
  // Record materialized paths, but keep the repair index aligned with the PR head.
  const destinationGit = await lstat(join(destination, '.git')).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return undefined
  })
  if (destinationGit && !destinationGit.isDirectory()) {
    throw new Error('Provider workspace must use an independent Git directory.')
  }
  const baselineBackup = await mkdtemp(join(tmpdir(), 'vitehub-baseline-'))
  let replacingMetadata = false
  try {
    const metadata = join(baselineBackup, 'plain.git')
    await git(destination, ['init', '--bare', '--template=', '--object-format=sha1', metadata])
    const baseline = ['--git-dir', metadata, '--work-tree', destination]
    await git(destination, [...baseline, 'add', '--force', '--all', '--', '.'])
    const materializedPaths = new Set((await git(destination, [...baseline, 'ls-files', '-z'])).split('\0').filter(Boolean))
    // Recycled directories must not retain refs or config from an earlier PR.
    replacingMetadata = true
    await rm(join(destination, '.git'), { recursive: true, force: true })
    await cp(join(source, '.git'), join(destination, '.git'), { recursive: true })
    // Never retain alternate object stores that point back to host paths.
    await rm(join(destination, '.git', 'objects', 'info', 'alternates'), { force: true })
    // Host init templates may install executable hooks; never expose or run them
    // in the provider workspace, and ignore any configured hooks directory.
    await rm(join(destination, '.git', 'hooks'), { recursive: true, force: true })
    await git(destination, ['read-tree', expected])
    options.signal?.throwIfAborted()
    await sanitizeProviderGitConfig(git, destination)
    if (materializedPaths) {
      const trackedPaths = new Set((await git(destination, ['ls-files', '-z'])).split('\0').filter(Boolean))
      const instructions = (path: string) => /(?:^|\/)(?:AGENTS|CLAUDE)\.md$/.test(path)
      // Before provider instruction injection, restore the assigned source files
      // so skip-worktree materialization differences cannot block a base merge.
      const restore = (path: string) => options.restoreInstructions && instructions(path)
      const omitted = [...trackedPaths].filter(path => !restore(path) && (!materializedPaths.has(path) || instructions(path)))
      if (omitted.length) await git(destination, ['update-index', '--skip-worktree', '--', ...omitted])
      const selected = [...trackedPaths].filter(path => restore(path) || (materializedPaths.has(path) && !instructions(path)))
      if (selected.length) await git(destination, ['checkout-index', '--force', '--', ...selected])
      // Keep generated-only baseline files out of a provider's ordinary git add -A.
      const generated = [...materializedPaths].filter(path => !trackedPaths.has(path))
      if (generated.length) {
        const patterns = generated.map(path => `/${path.replace(/[\\*?[\] #!]/g, '\\$&')}`)
        await appendFile(join(destination, '.git', 'info', 'exclude'), `\n${patterns.join('\n')}\n`)
      }
    }
    assertProviderCheckout(await git(destination, ['rev-parse', 'HEAD']) === expected
      && await git(destination, ['remote', 'get-url', '--all', 'origin']) === origin
      && await git(destination, ['remote', 'get-url', '--all', '--push', 'origin']) === push)
    await recordProviderCheckout(destination, expected)
  }
  catch (error) {
    if (replacingMetadata) await rm(join(destination, '.git'), { recursive: true, force: true })
    throw error
  }
  finally {
    await rm(baselineBackup, { recursive: true, force: true })
  }
}

/** Why a persistent provider workspace was kept or emptied. */
export type GitHubWorkspaceReuse = 'warm' | 'cold' | 'dirty' | 'missing-metadata' | (string & {})

/**
 * Prepares a provider workspace that stays between passes on one PR. Its Git metadata is always a
 * fresh sanitized copy of the trusted host checkout, so nothing a pass left in `.git` survives
 * except the host install's package-manager home. With `reuse`, ignored files such as node_modules
 * and build caches stay when the tracked tree already matches the head. Otherwise the workspace is
 * emptied and checked out again, and the next install links from the kept package store.
 * `reason` names why the caller did not ask for reuse.
 */
export async function preparePersistentGitHubPullRequestWorkspace(
  checkout: string,
  target: string,
  options: { signal?: AbortSignal, reuse?: boolean, reason?: string } = {},
): Promise<{ reused: boolean, reason: GitHubWorkspaceReuse }> {
  options.signal?.throwIfAborted()
  const { source, destination } = await separateCheckouts(checkout, target)
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') || key === 'GH_TOKEN' || key === 'GITHUB_TOKEN') delete env[key]
  env.GIT_CONFIG_GLOBAL = '/dev/null'
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_TERMINAL_PROMPT = '0'
  const git: Git = async (cwd, args) => (await exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { cwd, env, signal: options.signal, maxBuffer: 64 * 1024 * 1024 })).stdout.trim()
  const remoteUrls = async (cwd: string) => {
    const urls: string[] = []
    for (const name of (await git(cwd, ['remote'])).split('\n').filter(Boolean)) {
      urls.push(`${name}=${await git(cwd, ['remote', 'get-url', '--all', name])}`, `${name}.push=${await git(cwd, ['remote', 'get-url', '--all', '--push', name])}`)
    }
    return urls
  }
  const expected = await git(source, ['rev-parse', 'HEAD'])
  const remotes = await remoteUrls(source)
  assertRemotesWithoutCredentials(remotes.flatMap(remote => remote.slice(remote.indexOf('=') + 1).split('\n')))
  const metadata = join(destination, '.git')
  const previous = `${destination}.previous-git`
  await rm(previous, { recursive: true, force: true })
  const existing = await lstat(metadata).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return undefined
  })
  let reason: GitHubWorkspaceReuse | undefined = !options.reuse ? options.reason ?? 'cold' : existing?.isDirectory() ? undefined : 'missing-metadata'
  const keep = async (name: string) => await rename(join(previous, name), join(metadata, name)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
  })
  if (existing) await rename(metadata, previous)
  try {
    await cp(join(source, '.git'), metadata, { recursive: true })
    await rm(join(metadata, 'objects', 'info', 'alternates'), { force: true })
    await rm(join(metadata, 'hooks'), { recursive: true, force: true })
    await sanitizeProviderGitConfig(git, destination)
    // The install HOME holds pnpm's content-addressed store, which a reset workspace links from again.
    await keep('vitehub-install-home')
    if (!reason) {
      // The install record describes the node_modules that stay.
      await keep('vitehub-install.json')
      if (await git(destination, ['status', '--porcelain', '--untracked-files=all'])) reason = 'dirty'
    }
    if (reason) {
      await rm(join(metadata, 'vitehub-install.json'), { force: true })
      const entries = (await readdir(destination)).filter(entry => entry !== '.git')
      await Promise.all(entries.map(entry => rm(join(destination, entry), { recursive: true, force: true, maxRetries: 3 })))
      await git(destination, ['reset', '--hard', '--quiet', expected])
    }
    assertProviderCheckout(await git(destination, ['rev-parse', 'HEAD']) === expected && JSON.stringify(await remoteUrls(destination)) === JSON.stringify(remotes))
    await recordProviderCheckout(destination, expected)
  }
  catch (error) {
    await rm(metadata, { recursive: true, force: true })
    throw error
  }
  finally {
    await rm(previous, { recursive: true, force: true })
  }
  return { reused: !reason, reason: reason ?? 'warm' }
}
