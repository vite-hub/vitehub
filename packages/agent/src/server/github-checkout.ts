import { execFile } from 'node:child_process'
import { cp, lstat, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/** Restore PR checkout history in a separate materialized provider workspace. */
export async function prepareGitHubPullRequestWorkspace(checkout: string, target: string, options: { signal?: AbortSignal } = {}): Promise<void> {
  options.signal?.throwIfAborted()
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
  // Ignore a caller's Git binding so verification targets each directory's own index.
  const env = { ...process.env }
  delete env.GIT_DIR
  delete env.GIT_WORK_TREE
  delete env.GIT_INDEX_FILE
  delete env.GIT_COMMON_DIR
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
  for (const remote of remoteUrls) {
    if (URL.canParse(remote)) {
      const url = new URL(remote)
      if (url.username || url.password) throw new Error('Prepared checkout remotes must not contain credentials.')
    }
  }
  options.signal?.throwIfAborted()
  // Preserve the materialized workspace baseline while replacing its Git history.
  // The baseline index contains generated instructions and selected files; restoring
  // it after copying prevents out-of-scope paths from appearing deleted.
  const destinationGit = await lstat(join(destination, '.git')).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return undefined
  })
  if (destinationGit && !destinationGit.isDirectory()) {
    throw new Error('Provider workspace must use an independent Git directory.')
  }
  const baselineTree = destinationGit ? await git(destination, ['write-tree']) : undefined
  const baselineBackup = await mkdtemp(join(tmpdir(), 'vitehub-baseline-'))
  const baselineObjectsBackup = join(baselineBackup, 'objects')
  let replacingMetadata = false
  try {
    if (baselineTree) {
      await cp(join(destination, '.git', 'objects'), baselineObjectsBackup, { recursive: true })
    }
    // Recycled directories must not retain refs or config from an earlier PR.
    replacingMetadata = true
    await rm(join(destination, '.git'), { recursive: true, force: true })
    await cp(join(source, '.git'), join(destination, '.git'), { recursive: true })
    if (baselineTree) {
      await cp(baselineObjectsBackup, join(destination, '.git', 'objects'), { recursive: true })
      await git(destination, ['read-tree', baselineTree])
    }
    options.signal?.throwIfAborted()
    // Credentials belong to the host. Never carry saved clone authentication into a worker.
    const sensitive = (key: string) => /^credential\.|^include(?:if)?(?:[.:].*)?\.path$|^http\..*extraheader$|^http\.extraheader$|^http\.(?:.*\.)?(?:proxy|cookiefile|sslkey(?:type)?|sslcert(?:type|passwordprotected)?)$/i.test(key) || /^remote\..*\.proxy$/i.test(key)
    const sanitize = async (scope: '--local' | '--worktree') => {
      let config = ''
      try {
        config = await git(destination, ['config', scope, '--name-only', '--list'])
      } catch (error) {
        if (scope === '--local') throw error
      }
      for (const key of new Set(config.split('\n').filter(Boolean))) {
        let remove = sensitive(key)
        if (!remove && /^url\..+\.(?:insteadOf|pushInsteadOf)$/i.test(key)) {
          const values = await git(destination, ['config', scope, '--get-all', key]).catch(() => '')
          remove = values.split('\n').some(value => {
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
    if (await git(destination, ['rev-parse', 'HEAD']) !== expected
      || await git(destination, ['remote', 'get-url', '--all', 'origin']) !== origin
      || await git(destination, ['remote', 'get-url', '--all', '--push', 'origin']) !== push) {
      throw new Error('Provider checkout head or remote mismatch.')
    }
  }
  catch (error) {
    if (replacingMetadata) await rm(join(destination, '.git'), { recursive: true, force: true })
    throw error
  }
  finally {
    await rm(baselineBackup, { recursive: true, force: true })
  }
}
