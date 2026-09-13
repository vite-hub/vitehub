import { execFile } from 'node:child_process'
import { cp, lstat, realpath, rm } from 'node:fs/promises'
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
  const origin = await git(source, ['remote', 'get-url', 'origin'])
  const push = await git(source, ['remote', 'get-url', '--push', 'origin'])
  for (const remote of [origin, push]) {
    if (URL.canParse(remote)) {
      const url = new URL(remote)
      if (url.username || url.password) throw new Error('Prepared checkout remotes must not contain credentials.')
    }
  }
  options.signal?.throwIfAborted()
  // Preserve the materialized workspace baseline while replacing its Git history.
  // The baseline index contains generated instructions and selected files; restoring
  // it after copying prevents out-of-scope paths from appearing deleted.
  const destinationGit = await lstat(join(destination, '.git')).catch(() => undefined)
  if (!destinationGit?.isDirectory()) {
    throw new Error('Provider workspace must use an independent Git directory.')
  }
  const baselineTree = await git(destination, ['write-tree']).catch(() => undefined)
  const baselineObjects = join(destination, '.git', 'objects')
  const baselineObjectsBackup = join(destination, '.git-baseline-objects')
  await rm(baselineObjectsBackup, { recursive: true, force: true })
  await cp(baselineObjects, baselineObjectsBackup, { recursive: true }).catch(() => undefined)
  // Recycled directories must not retain refs or config from an earlier PR.
  await rm(join(destination, '.git'), { recursive: true, force: true })
  try {
    await cp(join(source, '.git'), join(destination, '.git'), { recursive: true })
    if (await lstat(baselineObjectsBackup).catch(() => undefined)) {
      await cp(baselineObjectsBackup, join(destination, '.git', 'objects'), { recursive: true })
    }
    if (baselineTree) await git(destination, ['read-tree', baselineTree])
    options.signal?.throwIfAborted()
    // Credentials belong to the host. Never carry saved clone authentication into a worker.
    const config = await git(destination, ['config', '--local', '--name-only', '--list'])
    for (const key of new Set(config.split('\n').filter(key => /^credential\.|^http\..*extraheader$|^http\.extraheader$/i.test(key)))) {
      await git(destination, ['config', '--local', '--unset-all', key])
    }
    if (await git(destination, ['rev-parse', 'HEAD']) !== expected
      || await git(destination, ['remote', 'get-url', 'origin']) !== origin
      || await git(destination, ['remote', 'get-url', '--push', 'origin']) !== push) {
      throw new Error('Provider checkout head or remote mismatch.')
    }
  }
  catch (error) {
    await rm(join(destination, '.git'), { recursive: true, force: true })
    throw error
  }
  finally {
    await rm(baselineObjectsBackup, { recursive: true, force: true })
  }
}
