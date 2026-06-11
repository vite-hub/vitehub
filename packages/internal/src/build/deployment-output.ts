import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join, relative, resolve, sep } from "node:path"

import { copyClientOutput, hasStaticIndex } from "./client-output.ts"
import { bundleEsmEntry } from "./esbuild.ts"
import { toSafeAppName } from "./user-entry.ts"
import { createNodeFunctionConfig, createVercelConfigJson } from "./vercel-config.ts"

type BundleOptions = Parameters<typeof bundleEsmEntry>[2]

interface SharedDeploymentOptions {
  clientOutDir: string
  rootDir: string
}

interface CloudflareDeploymentOutputOptions extends SharedDeploymentOptions {
  bundleEntry: string
  bundleOptions: BundleOptions
  bundleOutfileName?: string
  outputRoot?: string
  staticOutputDir?: string
  wranglerConfigKeys?: string[]
  wranglerConfig: object
}

interface VercelDeploymentOutputOptions extends SharedDeploymentOptions {
  bundleEntry: string
  bundleOptions: BundleOptions
  config?: object
  configKeys?: string[]
  functionConfig?: object
  outputRoot?: string
  runtimePackages?: VercelFunctionRuntimePackage[]
  serverFunctionName?: string
  staticOutputDir?: string
}

export type CloudflareProviderDeploymentOutput = Omit<CloudflareDeploymentOutputOptions, keyof SharedDeploymentOptions>
export type VercelProviderDeploymentOutput = Omit<VercelDeploymentOutputOptions, keyof SharedDeploymentOptions>

interface CloudflareProviderDeploymentCleanup {
  bundleOutfileName?: string
  outputRoot?: string
  wranglerConfigKeys?: string[]
}

interface VercelProviderDeploymentCleanup {
  configKeys?: string[]
  outputRoot?: string
  serverFunctionName?: string
}

interface ProviderDeploymentOutputOptions extends SharedDeploymentOptions {
  cloudflare?: CloudflareProviderDeploymentOutput
  cleanup?: {
    cloudflare?: CloudflareProviderDeploymentCleanup
    vercel?: VercelProviderDeploymentCleanup
  }
  vercel?: VercelProviderDeploymentOutput
}

interface ResolvedClientOutput {
  clientDir: string
  staticIndex: boolean
}

interface VercelFunctionRuntimePackage {
  includePeerDependencies?: boolean
  name: string
  optional?: boolean
  resolveFrom?: string
}

interface VercelFunctionRuntimePackagesOptions {
  outputRoot?: string
  packages: VercelFunctionRuntimePackage[]
  rootDir: string
  serverFunctionName?: string
}

function resolveClientOutput(rootDir: string, clientOutDir: string): ResolvedClientOutput {
  const clientDir = resolve(rootDir, clientOutDir)
  return {
    clientDir,
    staticIndex: hasStaticIndex(clientDir),
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function readJsonObject(file: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"))
    return isJsonObject(parsed) ? parsed : {}
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
    throw error
  }
}

function deleteJsonObjectKeys(value: Record<string, unknown>, keys: string[] | undefined): Record<string, unknown> {
  if (!keys?.length) return value
  const next = { ...value }
  for (const key of keys) {
    delete next[key]
  }
  return next
}

async function writeMergedJsonObject(file: string, value: object, ownedKeys?: string[]): Promise<void> {
  const existing = await readJsonObject(file)
  await writeFile(file, `${JSON.stringify({ ...deleteJsonObjectKeys(existing, ownedKeys), ...value }, null, 2)}\n`, "utf8")
}

async function deleteJsonObjectKeysFromFile(file: string, keys: string[] | undefined): Promise<void> {
  if (!keys?.length) return
  let existing: Record<string, unknown>
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"))
    existing = isJsonObject(parsed) ? parsed : {}
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  const next = { ...existing }
  let changed = false
  for (const key of keys) {
    if (key in next) {
      delete next[key]
      changed = true
    }
  }
  if (!changed) return
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, "utf8")
}

export function shouldSkipViteProviderBuild(command: "build" | "serve" | undefined, mode?: string): boolean {
  return command === "serve" || mode === "e2e"
}

export function createDefaultCloudflareOutputRoot(rootDir: string): string {
  return resolve(rootDir, "dist", toSafeAppName(rootDir))
}

function createDefaultCloudflareStaticOutputDir(rootDir: string): string {
  return resolve(rootDir, "dist", "client")
}

export function createDefaultVercelOutputRoot(rootDir: string): string {
  return resolve(rootDir, ".vercel", "output")
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

  const copied = new Set<string>()
  const outputNodeModules = resolve(serverDir, "node_modules")
  for (const runtimePackage of options.packages) {
    const resolver = createRequire(runtimePackage.resolveFrom ?? join(options.rootDir, "package.json"))
    await copyPackageToNodeModules(runtimePackage.name, resolver, options.rootDir, outputNodeModules, copied, runtimePackage)
  }
}

async function copyPackageToNodeModules(
  name: string,
  resolver: NodeJS.Require,
  fromDir: string,
  outputNodeModules: string,
  copied: Set<string>,
  options: VercelFunctionRuntimePackage = { name },
): Promise<void> {
  const packageJsonPath = await resolvePackageJson(name, resolver, fromDir)
  if (!packageJsonPath) {
    if (options.optional) return
    throw new Error(`Could not resolve package.json for ${name}.`)
  }

  const packageDir = dirname(packageJsonPath)
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
    dependencies?: Record<string, string>
    name?: string
    peerDependencies?: Record<string, string>
    peerDependenciesMeta?: Record<string, { optional?: boolean }>
  }
  const packageKey = `${name}\0${packageJsonPath}`

  if (!copied.has(packageKey)) {
    copied.add(packageKey)
    const targetDir = join(outputNodeModules, ...name.split("/"))
    await rm(targetDir, { force: true, recursive: true })
    await mkdir(dirname(targetDir), { recursive: true })
    await cp(packageDir, targetDir, {
      dereference: true,
      filter: source => !relative(packageDir, source).split(sep).includes("node_modules"),
      recursive: true,
    })
  }

  const packageRequire = createRequire(packageJsonPath)
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

async function writeCloudflareDeploymentOutput(options: CloudflareDeploymentOutputOptions): Promise<void> {
  const { clientDir, staticIndex } = resolveClientOutput(options.rootDir, options.clientOutDir)
  const outputRoot = options.outputRoot ?? createDefaultCloudflareOutputRoot(options.rootDir)
  const workerOutfile = resolve(outputRoot, options.bundleOutfileName ?? "index.js")

  await mkdir(outputRoot, { recursive: true })
  await rm(workerOutfile, { force: true, recursive: true })

  await Promise.all([
    bundleEsmEntry(options.bundleEntry, workerOutfile, options.bundleOptions),
    writeMergedJsonObject(resolve(outputRoot, "wrangler.json"), options.wranglerConfig, options.wranglerConfigKeys),
    staticIndex
      ? copyClientOutput(clientDir, options.staticOutputDir ?? createDefaultCloudflareStaticOutputDir(options.rootDir))
      : Promise.resolve(),
  ])
}

async function writeVercelDeploymentOutput(options: VercelDeploymentOutputOptions): Promise<void> {
  const { clientDir, staticIndex } = resolveClientOutput(options.rootDir, options.clientOutDir)
  const outputRoot = options.outputRoot ?? createDefaultVercelOutputRoot(options.rootDir)
  const serverFunctionName = options.serverFunctionName ?? "__server.func"
  const serverDir = resolve(outputRoot, "functions", serverFunctionName)
  const serverEntry = resolve(serverDir, "index.mjs")

  await rm(serverDir, { force: true, recursive: true })
  await mkdir(serverDir, { recursive: true })

  await Promise.all([
    bundleEsmEntry(options.bundleEntry, serverEntry, options.bundleOptions),
    copyVercelFunctionRuntimePackages({
      outputRoot,
      packages: options.runtimePackages ?? [],
      rootDir: options.rootDir,
      serverFunctionName,
    }),
    writeFile(resolve(serverDir, ".vc-config.json"), `${JSON.stringify(options.functionConfig ?? createNodeFunctionConfig(), null, 2)}\n`, "utf8"),
    writeMergedJsonObject(resolve(outputRoot, "config.json"), options.config ?? createVercelConfigJson(), options.configKeys),
    staticIndex
      ? copyClientOutput(clientDir, options.staticOutputDir ?? resolve(outputRoot, "static"))
      : Promise.resolve(),
  ])
}

async function cleanupCloudflareDeploymentOutput(rootDir: string, cleanup: CloudflareProviderDeploymentCleanup): Promise<void> {
  const outputRoot = cleanup.outputRoot ?? createDefaultCloudflareOutputRoot(rootDir)
  const writes: Array<Promise<void>> = []
  if (cleanup.bundleOutfileName) {
    writes.push(rm(resolve(outputRoot, cleanup.bundleOutfileName), { force: true, recursive: true }))
  }
  writes.push(deleteJsonObjectKeysFromFile(resolve(outputRoot, "wrangler.json"), cleanup.wranglerConfigKeys))
  await Promise.all(writes)
}

async function cleanupVercelDeploymentOutput(rootDir: string, cleanup: VercelProviderDeploymentCleanup): Promise<void> {
  const outputRoot = cleanup.outputRoot ?? createDefaultVercelOutputRoot(rootDir)
  const writes: Array<Promise<void>> = []
  if (cleanup.serverFunctionName) {
    writes.push(rm(resolve(outputRoot, "functions", cleanup.serverFunctionName), { force: true, recursive: true }))
  }
  writes.push(deleteJsonObjectKeysFromFile(resolve(outputRoot, "config.json"), cleanup.configKeys))
  await Promise.all(writes)
}

export async function writeProviderDeploymentOutputs(options: ProviderDeploymentOutputOptions): Promise<void> {
  const writes: Array<Promise<void>> = []
  if (options.cloudflare) {
    writes.push(writeCloudflareDeploymentOutput({
      ...options.cloudflare,
      clientOutDir: options.clientOutDir,
      rootDir: options.rootDir,
    }))
  } else if (options.cleanup?.cloudflare) {
    writes.push(cleanupCloudflareDeploymentOutput(options.rootDir, options.cleanup.cloudflare))
  }
  if (options.vercel) {
    writes.push(writeVercelDeploymentOutput({
      ...options.vercel,
      clientOutDir: options.clientOutDir,
      rootDir: options.rootDir,
    }))
  } else if (options.cleanup?.vercel) {
    writes.push(cleanupVercelDeploymentOutput(options.rootDir, options.cleanup.vercel))
  }
  await Promise.all(writes)
}
