import { createRuntimePackageResolver, isPackageResolutionMiss } from "./runtime-package-resolution.ts"
import { access, copyFile, mkdir, readFile, realpath, rm, stat } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

import { updateRuntimePackageDirectory } from "./runtime-package-directory.ts"
import { copyRuntimePackageFiles } from "./runtime-package-files.ts"
import { createDefaultVercelOutputRoot } from "./vercel-config.ts"
import { internalErrorDiagnostics } from "../error-diagnostics.ts"

const runtimeExportConditions = new Set(["default", "import", "module", "node", "node-addons", "require"])
const resolvePackageJson = createRuntimePackageResolver((source, path) => parsePackageJson(JSON.parse(source), path).name)
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

export interface VercelFunctionRuntimePackagesRequest {
  outputRoot?: string
  packages: VercelFunctionRuntimePackage[] | (() => VercelFunctionRuntimePackage[] | Promise<VercelFunctionRuntimePackage[]>)
  rootDir: string
  serverFunctionName?: string
}

interface VercelFunctionRuntimePackagesOptions extends VercelFunctionRuntimePackagesRequest {
  signal?: AbortSignal
}

/** Copies runtime packages into one Vercel function. A build with several features uses `createVercelFunctionRuntimePackagesPass()`. */
export async function copyVercelFunctionRuntimePackages(options: VercelFunctionRuntimePackagesOptions): Promise<void> {
  const pass = createVercelFunctionRuntimePackagesPass()
  pass.add(options)
  await pass.copy(options.signal)
}

/** Collects the runtime packages that features add to Vercel functions, then traces and copies them once per function. */
export function createVercelFunctionRuntimePackagesPass(): {
  add: (request: VercelFunctionRuntimePackagesRequest) => void
  copy: (signal?: AbortSignal) => Promise<void>
} {
  const requests: VercelFunctionRuntimePackagesRequest[] = []
  return {
    add(request) {
      requests.push(request)
    },
    async copy(signal) {
      const functions = new Map<string, { requests: VercelFunctionRuntimePackagesRequest[], rootDir: string }>()
      for (const request of requests.splice(0)) {
        const outputRoot = request.outputRoot ?? createDefaultVercelOutputRoot(request.rootDir)
        const serverDir = resolve(outputRoot, "functions", request.serverFunctionName ?? "__server.func")
        const entry = functions.get(serverDir) ?? { requests: [], rootDir: request.rootDir }
        entry.requests.push(request)
        functions.set(serverDir, entry)
      }
      for (const [serverDir, entry] of functions) {
        await copyFunctionRuntimePackages(serverDir, entry.rootDir, entry.requests, signal)
      }
    },
  }
}

async function copyFunctionRuntimePackages(
  serverDir: string,
  rootDir: string,
  requests: VercelFunctionRuntimePackagesRequest[],
  signal: AbortSignal | undefined,
): Promise<void> {
  try {
    await access(serverDir)
  }
  catch (error) {
    // SAFETY: Node filesystem failures expose their stable error code through ErrnoException.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }

  const packages: NodeRuntimePackage[] = []
  for (const request of requests) {
    const requested = Array.isArray(request.packages) ? request.packages : await request.packages()
    for (const runtimePackage of requested) {
      packages.push({ ...runtimePackage, resolveFrom: runtimePackage.resolveFrom ?? join(request.rootDir, "package.json") })
    }
  }
  if (!packages.length) return

  await updateRuntimePackageDirectory({
    directory: resolve(serverDir, "node_modules"),
    signal,
    update: outputNodeModules => copyNodeRuntimePackages({
      outputNodeModules,
      packages,
      rootDir,
    }),
  })
}

export async function copyNodeRuntimePackages(options: NodeRuntimePackagesOptions): Promise<void> {
  if (!options.packages.length) return

  const copied = new Set<string>()
  const expanded = new Set<string>()
  const requested = new Map<string, string>()
  for (const runtimePackage of options.packages) {
    const resolveFrom = runtimePackage.resolveFrom ?? join(options.rootDir, "package.json")
    const resolver = createRequire(resolveFrom)
    const packageJsonPath = await copyPackageToNodeModules(runtimePackage.name, resolver, dirname(resolveFrom), options.outputNodeModules, copied, expanded, runtimePackage)
    if (!packageJsonPath) continue
    const previous = requested.get(runtimePackage.name)
    if (previous && previous !== packageJsonPath) {
      throw internalErrorDiagnostics.INTERNAL_RUNTIME_PACKAGE_VERSION_CONFLICT({ first: dirname(previous), name: runtimePackage.name, second: dirname(packageJsonPath) })
    }
    requested.set(runtimePackage.name, packageJsonPath)
  }
}

async function copyPackageToNodeModules(
  name: string,
  resolver: NodeJS.Require,
  fromDir: string,
  outputNodeModules: string,
  copied: Set<string>,
  expanded: Set<string>,
  options: NodeRuntimePackage = { name },
): Promise<string | undefined> {
  const packageJsonPath = await resolvePackageJson(name, resolver, fromDir)
  if (!packageJsonPath) {
    if (options.optional) return undefined
    throw internalErrorDiagnostics.INTERNAL_B0046({ message: `Could not resolve package.json for ${name}.` })
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
    optionalDependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
    peerDependenciesMeta?: Record<string, { optional?: boolean }>
  }
  const packageKey = `${name}\0${resolvedPackageJsonPath}`
  if (!copied.has(packageKey)) {
    copied.add(packageKey)
    const targetDir = join(outputNodeModules, ...name.split("/"))
    await rm(targetDir, { force: true, recursive: true })
    const copiedTrace = await copyTracedPackageFiles(name, resolver, packageDir, resolvedPackageJsonPath, packageJson, targetDir)
    if (!copiedTrace) await copyRuntimePackageFiles(packageDir, targetDir)
  }

  const expansionKey = `${packageKey}\0${options.includePeerDependencies ? "peers" : "dependencies"}`
  if (expanded.has(expansionKey)) return resolvedPackageJsonPath
  expanded.add(expansionKey)

  const packageRequire = createRequire(resolvedPackageJsonPath)
  const dependencyNames = new Set(Object.keys(packageJson.dependencies || {}))
  const optionalDependencyNames = new Set(Object.keys(packageJson.optionalDependencies || {}))
  for (const dependencyName of optionalDependencyNames) dependencyNames.add(dependencyName)
  const requiredPeerDependencyNames = new Set<string>()
  if (options.includePeerDependencies) {
    for (const dependencyName of Object.keys(packageJson.peerDependencies || {})) {
      if (!packageJson.peerDependenciesMeta?.[dependencyName]?.optional) {
        dependencyNames.add(dependencyName)
        requiredPeerDependencyNames.add(dependencyName)
      }
    }
  }

  for (const dependencyName of dependencyNames) {
    await copyPackageToNodeModules(dependencyName, packageRequire, packageDir, outputNodeModules, copied, expanded, {
      includePeerDependencies: options.includePeerDependencies,
      name: dependencyName,
      optional: optionalDependencyNames.has(dependencyName) && !requiredPeerDependencyNames.has(dependencyName),
    })
  }
  return resolvedPackageJsonPath
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

function parsePackageJson(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw internalErrorDiagnostics.INTERNAL_B0047({ message: `Expected ${path} to contain a JSON object.` })
  }
  // SAFETY: The checks above establish a non-null, non-array object with string keys.
  return value as Record<string, unknown>
}
