import { access, copyFile, cp, mkdir, mkdtemp, readFile, realpath, rename, rm, stat } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

import { createDefaultVercelOutputRoot } from "./deployment-output.ts"

const runtimeExportConditions = new Set(["default", "import", "module", "node", "node-addons", "require"])
let nodeFileTracePromise: Promise<typeof import("@vercel/nft").nodeFileTrace> | undefined

export interface NodeRuntimePackage {
  includePeerDependencies?: boolean
  name: string
  optional?: boolean
  resolveFrom?: string
}

export type VercelFunctionRuntimePackage = NodeRuntimePackage

interface NodeRuntimePackagesOptions {
  outputNodeModules: string
  packages: NodeRuntimePackage[]
  rootDir: string
}

interface VercelFunctionRuntimePackagesOptions {
  outputRoot?: string
  packages: VercelFunctionRuntimePackage[]
  rootDir: string
  serverFunctionName?: string
  signal?: AbortSignal
}

export async function copyVercelFunctionRuntimePackages(options: VercelFunctionRuntimePackagesOptions): Promise<void> {
  if (!options.packages.length) return

  const outputRoot = options.outputRoot ?? createDefaultVercelOutputRoot(options.rootDir)
  const serverFunctionName = options.serverFunctionName ?? "__server.func"
  const serverDir = resolve(outputRoot, "functions", serverFunctionName)
  try {
    await access(serverDir)
  }
  catch (error) {
    // SAFETY: Node filesystem failures expose their stable error code through ErrnoException.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }

  const outputNodeModules = resolve(serverDir, "node_modules")
  const stagingRoot = await mkdtemp(resolve(serverDir, ".vitehub-runtime-packages-"))
  const stagedNodeModules = resolve(stagingRoot, "node_modules")
  const previousNodeModules = resolve(stagingRoot, "previous-node_modules")
  let movedPreviousOutput = false
  let installedReplacement = false

  try {
    try {
      await cp(outputNodeModules, stagedNodeModules, { recursive: true })
    }
    catch (error) {
      // SAFETY: Node filesystem failures expose their stable error code through ErrnoException.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    await mkdir(stagedNodeModules, { recursive: true })

    await copyNodeRuntimePackages({
      outputNodeModules: stagedNodeModules,
      packages: options.packages,
      rootDir: options.rootDir,
    })
    options.signal?.throwIfAborted()

    try {
      await rename(outputNodeModules, previousNodeModules)
      movedPreviousOutput = true
    }
    catch (error) {
      // SAFETY: Node filesystem failures expose their stable error code through ErrnoException.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }

    try {
      options.signal?.throwIfAborted()
      await rename(stagedNodeModules, outputNodeModules)
      installedReplacement = true
      options.signal?.throwIfAborted()
    }
    catch (error) {
      if (installedReplacement) await rm(outputNodeModules, { force: true, recursive: true })
      if (movedPreviousOutput) await rename(previousNodeModules, outputNodeModules)
      throw error
    }
  }
  finally {
    await rm(stagingRoot, { force: true, recursive: true })
  }
}

export async function copyNodeRuntimePackages(options: NodeRuntimePackagesOptions): Promise<void> {
  if (!options.packages.length) return

  const copied = new Set<string>()
  for (const runtimePackage of options.packages) {
    const resolveFrom = runtimePackage.resolveFrom ?? join(options.rootDir, "package.json")
    const resolver = createRequire(resolveFrom)
    await copyPackageToNodeModules(runtimePackage.name, resolver, dirname(resolveFrom), options.outputNodeModules, copied, runtimePackage)
  }
}

async function copyPackageToNodeModules(
  name: string,
  resolver: NodeJS.Require,
  fromDir: string,
  outputNodeModules: string,
  copied: Set<string>,
  options: NodeRuntimePackage = { name },
): Promise<void> {
  const packageJsonPath = await resolvePackageJson(name, resolver, fromDir)
  if (!packageJsonPath) {
    if (options.optional) return
    throw new Error(`Could not resolve package.json for ${name}.`)
  }

  const resolvedPackageJsonPath = await realpath(packageJsonPath)
  const packageDir = dirname(resolvedPackageJsonPath)
  const parsedPackageJson: unknown = JSON.parse(await readFile(resolvedPackageJsonPath, "utf8"))
  // SAFETY: parsePackageJson establishes the object boundary; package metadata fields are optional and consumed defensively below.
  const packageJson = parsePackageJson(parsedPackageJson, resolvedPackageJsonPath) as {
    dependencies?: Record<string, string>
    exports?: unknown
    main?: string
    module?: string
    name?: string
    peerDependencies?: Record<string, string>
    peerDependenciesMeta?: Record<string, { optional?: boolean }>
  }
  const packageKey = `${name}\0${resolvedPackageJsonPath}`

  if (!copied.has(packageKey)) {
    copied.add(packageKey)
    const targetDir = join(outputNodeModules, ...name.split("/"))
    await rm(targetDir, { force: true, recursive: true })
    const copiedTrace = await copyTracedPackageFiles(name, resolver, packageDir, resolvedPackageJsonPath, packageJson, targetDir)
    if (!copiedTrace) await copyPackageDirectory(packageDir, targetDir)
  }

  const packageRequire = createRequire(resolvedPackageJsonPath)
  const dependencyNames = new Set(Object.keys(packageJson.dependencies || {}))
  if (options.includePeerDependencies) {
    for (const dependencyName of Object.keys(packageJson.peerDependencies || {})) {
      if (!packageJson.peerDependenciesMeta?.[dependencyName]?.optional) dependencyNames.add(dependencyName)
    }
  }

  for (const dependencyName of dependencyNames) {
    await copyPackageToNodeModules(dependencyName, packageRequire, packageDir, outputNodeModules, copied, {
      includePeerDependencies: options.includePeerDependencies,
      name: dependencyName,
    })
  }
}

async function copyTracedPackageFiles(
  name: string,
  resolver: NodeJS.Require,
  packageDir: string,
  packageJsonPath: string,
  packageJson: { exports?: unknown, main?: string, module?: string },
  targetDir: string,
): Promise<boolean> {
  const entries = await resolvePackageTraceEntries(name, resolver, packageDir, packageJson)
  if (!entries) return false

  const nodeFileTrace = await loadNodeFileTrace()
  const { fileList } = await nodeFileTrace([...entries], {
    base: packageDir,
    conditions: ["node"],
    exportsOnly: true,
    processCwd: packageDir,
  })

  fileList.add(relative(packageDir, packageJsonPath))
  for (const file of fileList) {
    const source = resolve(packageDir, file)
    if (!isInsideDirectory(packageDir, source) || hasNodeModulesSegment(file)) continue
    const sourceStat = await stat(source)
    if (!sourceStat.isFile()) continue
    const target = resolve(targetDir, file)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(source, target)
  }

  return true
}

async function copyPackageDirectory(packageDir: string, targetDir: string): Promise<void> {
  await mkdir(dirname(targetDir), { recursive: true })
  await cp(packageDir, targetDir, {
    dereference: true,
    filter: source => !hasNodeModulesSegment(relative(packageDir, source)),
    recursive: true,
  })
}

async function loadNodeFileTrace(): Promise<typeof import("@vercel/nft").nodeFileTrace> {
  nodeFileTracePromise ??= import("@vercel/nft").then(({ nodeFileTrace }) => nodeFileTrace)
  return nodeFileTracePromise
}

async function resolvePackageTraceEntries(
  name: string,
  resolver: NodeJS.Require,
  packageDir: string,
  packageJson: { exports?: unknown, main?: string, module?: string },
): Promise<string[] | undefined> {
  const entryCandidates = new Set<string>()

  if (packageJson.exports) {
    const exportedTargets = collectRuntimeExportTargets(packageJson.exports)
    if (!exportedTargets) return undefined
    for (const target of exportedTargets) entryCandidates.add(resolve(packageDir, target))
  } else {
    try {
      entryCandidates.add(resolver.resolve(name))
    }
    catch (error) {
      if (!isPackageResolutionMiss(error)) throw error
    }
    if (packageJson.main) entryCandidates.add(resolve(packageDir, packageJson.main))
    if (packageJson.module) entryCandidates.add(resolve(packageDir, packageJson.module))
    entryCandidates.add(resolve(packageDir, "index.js"))
  }

  const entries: string[] = []
  for (const candidate of entryCandidates) {
    try {
      const candidateStat = await stat(candidate)
      if (candidateStat.isFile()) entries.push(candidate)
      else if (candidateStat.isDirectory()) return undefined
    }
    catch (error) {
      // SAFETY: Node filesystem failures expose their stable error code through ErrnoException.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }

  return entries.length ? entries : undefined
}

function collectRuntimeExportTargets(exportsValue: unknown, condition?: string): Set<string> | undefined {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Package export maps come from JSON, so this parser must inspect their runtime representation.
  if (typeof exportsValue === "string") {
    if (condition === "types") return new Set()
    if (exportsValue.includes("*")) return undefined
    return exportsValue.startsWith("./") ? new Set([exportsValue]) : new Set()
  }

  if (Array.isArray(exportsValue)) {
    const targets = new Set<string>()
    for (const entry of exportsValue) {
      const entryTargets = collectRuntimeExportTargets(entry, condition)
      if (!entryTargets) return undefined
      for (const target of entryTargets) targets.add(target)
    }
    return targets
  }

  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Package export maps come from JSON, so this parser must reject non-object runtime values.
  if (typeof exportsValue !== "object" || exportsValue === null) return new Set()

  const targets = new Set<string>()
  for (const [key, value] of Object.entries(exportsValue)) {
    if (key === "types") continue
    if (!key.startsWith(".") && !runtimeExportConditions.has(key)) continue
    const entryTargets = collectRuntimeExportTargets(value, key)
    if (!entryTargets) return undefined
    for (const target of entryTargets) targets.add(target)
  }
  return targets
}

function hasNodeModulesSegment(path: string): boolean {
  return path.split(/[\\/]/).includes("node_modules")
}

function isInsideDirectory(parent: string, child: string): boolean {
  const childRelativePath = relative(parent, child)
  return childRelativePath === "" || (!childRelativePath.startsWith(`..${sep}`) && childRelativePath !== ".." && !isAbsolute(childRelativePath))
}

async function resolvePackageJson(name: string, resolver: NodeJS.Require, fromDir: string): Promise<string | undefined> {
  try {
    return resolver.resolve(`${name}/package.json`)
  }
  catch (error) {
    if (!isPackageResolutionMiss(error)) throw error
  }

  try {
    let current = dirname(resolver.resolve(name))
    while (current !== dirname(current)) {
      const candidate = join(current, "package.json")
      try {
        await access(candidate)
        const parsedPackageJson: unknown = JSON.parse(await readFile(candidate, "utf8"))
        // SAFETY: parsePackageJson validates the object boundary before this narrower property view.
        const packageJson = parsePackageJson(parsedPackageJson, candidate) as { name?: string }
        if (packageJson.name === name) return candidate
      }
      catch (error) {
        // SAFETY: Node filesystem failures expose their stable error code through ErrnoException.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
      current = dirname(current)
    }
  }
  catch (error) {
    if (!isPackageResolutionMiss(error)) throw error
  }

  let current = fromDir
  while (current !== dirname(current)) {
    const candidate = join(current, "node_modules", ...name.split("/"), "package.json")
    try {
      await access(candidate)
      return candidate
    }
    catch (error) {
      // SAFETY: Node filesystem failures expose their stable error code through ErrnoException.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    current = dirname(current)
  }
}

function isPackageResolutionMiss(error: unknown): boolean {
  // SAFETY: Node module resolution failures expose their stable error code through ErrnoException.
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND" || code === "ERR_PACKAGE_PATH_NOT_EXPORTED"
}

function parsePackageJson(value: unknown, path: string): Record<string, unknown> {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- JSON.parse returns an untrusted runtime value that must be checked at this boundary.
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Expected ${path} to contain a JSON object.`)
  }
  // SAFETY: The checks above establish a non-null, non-array object with string keys.
  return value as Record<string, unknown>
}
