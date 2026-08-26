import { access, copyFile, cp, mkdir, readFile, realpath, rm, stat } from "node:fs/promises"
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
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }

  await copyNodeRuntimePackages({
    outputNodeModules: resolve(serverDir, "node_modules"),
    packages: options.packages,
    rootDir: options.rootDir,
  })
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
  const packageJson = JSON.parse(await readFile(resolvedPackageJsonPath, "utf8")) as {
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
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }

  return entries.length ? entries : undefined
}

function collectRuntimeExportTargets(exportsValue: unknown, condition?: string): Set<string> | undefined {
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
        const packageJson = JSON.parse(await readFile(candidate, "utf8")) as { name?: string }
        if (packageJson.name === name) return candidate
      }
      catch (error) {
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
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    current = dirname(current)
  }
}

function isPackageResolutionMiss(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND" || code === "ERR_PACKAGE_PATH_NOT_EXPORTED"
}
