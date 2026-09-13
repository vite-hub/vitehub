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
  // Recycled directories must not retain refs or config from an earlier PR.
  // Capture the prior index so files deleted by the new tree can be removed while
  // leaving provider-generated and other untracked workspace output untouched.
  let previousTracked: string[] = []
  try {
    previousTracked = (await exec('git', ['ls-files', '-z'], { cwd: destination, env, signal: options.signal })).stdout
      .split('\0').filter(Boolean)
  } catch {
    // A plain target has no prior index.
  }
  await rm(join(destination, '.git'), { recursive: true, force: true })
  try {
    await cp(join(source, '.git'), join(destination, '.git'), { recursive: true })
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
    // Remove files tracked by the previous checkout but absent from the new tree.
    // Keep provider-generated instruction files intact.
    const tracked = (await exec('git', ['ls-files', '-z'], { cwd: source, env, signal: options.signal })).stdout
      .split('\0').filter(Boolean)
    const current = new Set(tracked)
    for (const file of previousTracked) {
      if (current.has(file) || file === 'AGENTS.md' || file === 'CLAUDE.md') continue
      await rm(join(destination, file), { recursive: true, force: true })
    }
    for (const file of tracked) {
      if (file === 'AGENTS.md' || file === 'CLAUDE.md') continue
      await cp(join(source, file), join(destination, file), { recursive: true })
    }
  }
  catch (error) {
    await rm(join(destination, '.git'), { recursive: true, force: true })
    throw error
  }
}
