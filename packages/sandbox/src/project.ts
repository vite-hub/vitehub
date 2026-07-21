import { createHash } from 'node:crypto'
import { glob, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, matchesGlob, relative, resolve } from 'node:path'
import type { SandboxProjectOptions } from './module-types'

export type SandboxPackageManager = 'bun' | 'npm' | 'pnpm' | 'yarn'

export interface SandboxProjectFile {
  contents: string
  encoding: 'base64'
  mode?: number
}

export interface SandboxProject {
  digest: string
  files: Record<string, SandboxProjectFile>
  install: {
    args: string[]
    command: SandboxPackageManager
    cwd: string
  }
  packagePath: string
}

type PackageManifest = {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  name?: string
  optionalDependencies?: Record<string, string>
  packageManager?: unknown
  peerDependencies?: Record<string, string>
  vitehub?: unknown
}

const lockfiles: Array<{ file: string, manager: SandboxPackageManager }> = [
  { file: 'pnpm-lock.yaml', manager: 'pnpm' },
  { file: 'package-lock.json', manager: 'npm' },
  { file: 'yarn.lock', manager: 'yarn' },
  { file: 'bun.lock', manager: 'bun' },
]

const projectFileExcludes = ['node_modules/**', '.git/**', '**/.env', '**/.env.*', '**/.npmrc', 'bun.lockb']

function isInside(root: string, path: string) {
  const next = relative(root, path)
  return next === '' || (!next.startsWith('..') && !next.startsWith('/'))
}

async function isFile(path: string, root: string) {
  const file = await stat(path).then(value => value.isFile(), () => false)
  if (!file)
    return false
  const target = await realpath(path)
  if (!isInside(root, target))
    throw new Error(`[vitehub] Sandbox project file escapes its scan root: ${path}`)
  return true
}

function ancestors(start: string, root: string) {
  const paths: string[] = []
  let current = start
  while (isInside(root, current)) {
    paths.push(current)
    if (current === root)
      break
    const parent = dirname(current)
    if (parent === current)
      break
    current = parent
  }
  return paths
}

function packageManagerFromField(value: unknown): SandboxPackageManager | undefined {
  if (typeof value !== 'string')
    return undefined
  const name = value.split('@', 1)[0]
  return name === 'pnpm' || name === 'npm' || name === 'yarn' || name === 'bun'
    ? name
    : undefined
}

function packageManagerMajor(value: unknown) {
  if (typeof value !== 'string') return undefined
  const version = value.slice(value.indexOf('@') + 1)
  const major = Number.parseInt(version, 10)
  return Number.isFinite(major) ? major : undefined
}

function installArgs(manager: SandboxPackageManager, hasLockfile: boolean, declaredMajor?: number) {
  if (manager === 'npm')
    return hasLockfile ? ['ci'] : ['install']
  if (manager === 'yarn')
    return hasLockfile
      ? ['install', declaredMajor === 1 ? '--frozen-lockfile' : '--immutable']
      : ['install']
  return hasLockfile ? ['install', '--frozen-lockfile'] : ['install']
}

function parseManifest(source: string, path: string): PackageManifest {
  try {
    return JSON.parse(source) as PackageManifest
  }
  catch (error) {
    throw new Error(`[vitehub] Sandbox package manifest is invalid JSON: ${path}`, { cause: error })
  }
}

function parseSandboxProjectOptions(manifest: PackageManifest, path: string): SandboxProjectOptions | undefined {
  if (typeof manifest.vitehub === 'undefined')
    return undefined
  if (!manifest.vitehub || typeof manifest.vitehub !== 'object' || Array.isArray(manifest.vitehub)) {
    throw new TypeError(`[vitehub] Sandbox package manifest "${path}" field "vitehub" must be an object.`)
  }

  const metadata = manifest.vitehub as Record<string, unknown>
  const unsupported = Object.keys(metadata).filter(key => key !== 'timeout')
  if (unsupported.length) {
    throw new TypeError(
      `[vitehub] Sandbox package manifest "${path}" field "vitehub" supports only "timeout". Unsupported keys: ${unsupported.join(', ')}.`,
    )
  }
  if (typeof metadata.timeout === 'undefined')
    return undefined
  if (typeof metadata.timeout !== 'number' || !Number.isFinite(metadata.timeout) || metadata.timeout <= 0) {
    throw new TypeError(
      `[vitehub] Sandbox package manifest "${path}" field "vitehub.timeout" must be a positive finite number of milliseconds.`,
    )
  }
  return { timeout: metadata.timeout }
}

function parsePnpmWorkspacePackages(source: string) {
  const patterns: string[] = []
  let packagesIndent: number | undefined
  for (const line of source.split(/\r?\n/)) {
    if (packagesIndent === undefined) {
      const match = /^(\s*)packages\s*:\s*(?:#.*)?$/.exec(line)
      if (match) packagesIndent = match[1].length
      continue
    }
    if (!line.trim() || /^\s*#/.test(line)) continue
    const indent = /^\s*/.exec(line)?.[0].length || 0
    if (indent <= packagesIndent) break
    const item = /^\s*-\s*(.+?)\s*$/.exec(line)?.[1]
    if (!item) continue
    const value = item.replace(/\s+#.*$/, '').trim().replace(/^(['"])(.*)\1$/, '$2')
    if (value) patterns.push(value.replaceAll('\\', '/').replace(/\/$/, ''))
  }
  return patterns
}

function isWorkspacePackage(path: string, patterns: readonly string[]) {
  const included = patterns.filter(pattern => !pattern.startsWith('!')).some(pattern => matchesGlob(path, pattern))
  return included && !patterns.filter(pattern => pattern.startsWith('!')).some(pattern => matchesGlob(path, pattern.slice(1)))
}

async function findPnpmWorkspaceRoot(packageRoot: string, root: string) {
  for (const directory of ancestors(packageRoot, root)) {
    const file = resolve(directory, 'pnpm-workspace.yaml')
    if (!await isFile(file, root)) continue
    const source = await readFile(file, 'utf8')
    const packagePath = relative(directory, packageRoot).replaceAll('\\', '/') || '.'
    if (directory === packageRoot || isWorkspacePackage(packagePath, parsePnpmWorkspacePackages(source)))
      return { directory, file, source }
  }
}

async function addProjectFile(files: Record<string, SandboxProjectFile>, installRoot: string, path: string, scanRoot: string) {
  if (!await isFile(path, scanRoot)) return
  const mode = (await stat(path)).mode & 0o777
  files[relative(installRoot, path).replaceAll('\\', '/')] = {
    contents: (await readFile(path)).toString('base64'),
    encoding: 'base64',
    ...(mode & 0o111 ? { mode } : {}),
  }
}

function workspaceDependencyNames(manifest: PackageManifest) {
  const sections = [manifest.dependencies, manifest.devDependencies, manifest.optionalDependencies, manifest.peerDependencies]
  return [...new Set(sections.flatMap(section => Object.entries(section || {}))
    .filter(([, specifier]) => specifier.startsWith('workspace:'))
    .map(([name]) => name))]
}

async function addPnpmWorkspaceDependencies(
  files: Record<string, SandboxProjectFile>,
  workspaceRoot: string,
  scanRoot: string,
  patterns: readonly string[],
  selectedManifest: PackageManifest,
) {
  const packages = new Map<string, { manifest: PackageManifest, root: string }>()
  for (const pattern of patterns.filter(pattern => !pattern.startsWith('!'))) {
    for await (const match of glob(`${pattern}/package.json`, { cwd: workspaceRoot, exclude: ['**/node_modules/**', '**/.git/**'] })) {
      const manifestPath = resolve(workspaceRoot, match)
      if (!await isFile(manifestPath, scanRoot)) continue
      const packagePath = relative(workspaceRoot, dirname(manifestPath)).replaceAll('\\', '/') || '.'
      if (!isWorkspacePackage(packagePath, patterns)) continue
      const manifest = parseManifest(await readFile(manifestPath, 'utf8'), manifestPath)
      if (manifest.name) packages.set(manifest.name, { manifest, root: dirname(manifestPath) })
    }
  }

  const pending = workspaceDependencyNames(selectedManifest)
  const included = new Set<string>()
  while (pending.length) {
    const name = pending.shift()!
    if (included.has(name)) continue
    const dependency = packages.get(name)
    if (!dependency)
      throw new Error(`[vitehub] Sandbox package references missing pnpm workspace dependency "${name}".`)
    included.add(name)
    pending.push(...workspaceDependencyNames(dependency.manifest))
    for await (const match of glob('**/*', { cwd: dependency.root, exclude: projectFileExcludes }))
      await addProjectFile(files, workspaceRoot, resolve(dependency.root, match), scanRoot)
  }
}

export async function resolveSandboxProject(definitionFile: string, scanRoot: string): Promise<SandboxProject> {
  const root = await realpath(resolve(scanRoot))
  const definition = await realpath(resolve(definitionFile))
  if (!isInside(root, definition))
    throw new Error(`[vitehub] Sandbox Definition is outside its scan root: ${definitionFile}`)

  const packageRoot = await firstDirectoryWithFile(ancestors(dirname(definition), root), 'package.json', root)
  if (!packageRoot) {
    throw new Error(
      `[vitehub] Sandbox Definition "${definitionFile}" requires a package.json between its directory and "${root}".`,
    )
  }

  const manifestPath = resolve(packageRoot, 'package.json')
  const manifestSource = await readFile(manifestPath, 'utf8')
  const manifest = parseManifest(manifestSource, manifestPath)
  const declaredManager = packageManagerFromField(manifest.packageManager)
  const declaredMajor = packageManagerMajor(manifest.packageManager)
  const workspace = declaredManager && declaredManager !== 'pnpm'
    ? undefined
    : await findPnpmWorkspaceRoot(packageRoot, root)
  const installRoot = workspace?.directory || packageRoot
  const packageLock = await findLockfile([installRoot], root, workspace ? 'pnpm' : declaredManager)
  const manager = declaredManager || packageLock?.manager || (workspace ? 'pnpm' : 'npm')
  const lock = packageLock?.manager === manager ? packageLock : undefined
  const lockfileMajor = manager === 'yarn' && lock && declaredMajor === undefined
    ? (await readFile(lock.path, 'utf8')).includes('__metadata:') ? 2 : 1
    : undefined

  const files: Record<string, SandboxProjectFile> = {}
  for await (const match of glob('**/*', { cwd: packageRoot, exclude: projectFileExcludes }))
    await addProjectFile(files, installRoot, resolve(packageRoot, match), root)
  if (installRoot !== packageRoot)
    await addProjectFile(files, installRoot, resolve(installRoot, 'package.json'), root)
  if (workspace) {
    await addProjectFile(files, installRoot, workspace.file, root)
    await addPnpmWorkspaceDependencies(files, installRoot, root, parsePnpmWorkspacePackages(workspace.source), manifest)
  }
  if (lock) await addProjectFile(files, installRoot, lock.path, root)

  const packagePath = relative(installRoot, packageRoot).replaceAll('\\', '/') || '.'
  const identity = JSON.stringify({ files, manager, packagePath })
  return {
    digest: createHash('sha256').update(identity).digest('hex'),
    files,
    install: {
      args: installArgs(manager, Boolean(lock), declaredManager === manager ? declaredMajor : lockfileMajor),
      command: manager,
      cwd: '.',
    },
    packagePath,
  }
}

export async function resolveSandboxProjectOptions(
  definitionFile: string,
  scanRoot: string,
): Promise<SandboxProjectOptions | undefined> {
  const root = await realpath(resolve(scanRoot))
  const definition = await realpath(resolve(definitionFile))
  if (!isInside(root, definition))
    throw new Error(`[vitehub] Sandbox Definition is outside its scan root: ${definitionFile}`)

  const packageRoot = await firstDirectoryWithFile(ancestors(dirname(definition), root), 'package.json', root)
  if (!packageRoot) {
    throw new Error(
      `[vitehub] Sandbox Definition "${definitionFile}" requires a package.json between its directory and "${root}".`,
    )
  }

  const manifestPath = resolve(packageRoot, 'package.json')
  const manifest = parseManifest(await readFile(manifestPath, 'utf8'), manifestPath)
  return parseSandboxProjectOptions(manifest, manifestPath)
}

async function firstDirectoryWithFile(directories: string[], file: string, root: string) {
  for (const directory of directories) {
    if (await isFile(resolve(directory, file), root))
      return directory
  }
}

async function findLockfile(
  directories: string[],
  root: string,
  manager?: SandboxPackageManager,
): Promise<{ directory: string, manager: SandboxPackageManager, path: string } | undefined> {
  const candidates = manager ? lockfiles.filter(lock => lock.manager === manager) : lockfiles
  for (const directory of directories) {
    for (const candidate of candidates) {
      const path = resolve(directory, candidate.file)
      if (await isFile(path, root))
        return { directory, manager: candidate.manager, path }
    }
  }
}
