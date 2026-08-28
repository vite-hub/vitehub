import { existsSync, renameSync, rmSync } from "node:fs"
import { cp, mkdir, mkdtemp, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"

import { copyClientOutput, hasStaticIndex } from "./client-output.ts"
import { createDefaultCloudflareOutputRoot, writeCloudflareWranglerConfig } from "./cloudflare.ts"
import { bundleEsmEntry } from "./esbuild.ts"
import { cleanProviderOutputConfig, stringifyProviderOutputConfig, writeProviderOutputConfig } from "./provider-output-config.ts"
import { createNodeFunctionConfig, createVercelConfigJson } from "./vercel-config.ts"

import type { ProviderOutputConfigOwnership } from "./provider-output-config.ts"
import type { ProviderOutputCatalog as ProviderOutputCatalogType } from "./provider-output-catalog.ts"

export { createDefaultCloudflareOutputRoot } from "./cloudflare.ts"
export { composeNitroCloudflareProviderOutput } from "./cloudflare-provider-output.ts"
export {
  contributeCloudflareProviderOutput,
  contributeProviderRuntime,
  createProviderOutputCatalog,
  getProviderRuntimeModule,
  getVercelRuntimePackages,
  hasProviderRuntimeModule,
  ProviderOutputCatalog,
  resetProviderOutputRuntime,
  useProviderOutputCatalog,
} from "./provider-output-catalog.ts"
export { shouldSkipViteProviderBuild } from "./vite.ts"

type BundleOptions = NonNullable<Parameters<typeof bundleEsmEntry>[2]>

interface SharedDeploymentOptions {
  clientOutDir: string
  rootDir: string
}

interface CloudflareDeploymentOutputOptions extends SharedDeploymentOptions {
  bundleEntry?: string
  bundleOptions?: BundleOptions
  bundleOutfileName?: string
  files?: Record<string, string>
  outputRoot?: string
  staticOutputDir?: string
  wranglerConfigKeys?: string[]
  wranglerConfigOwnership?: ProviderOutputConfigOwnership
  wranglerConfig: object
}

type VercelFunctionOutput =
  | { kind: "isolated", name: string }
  | { kind: "root" }

interface VercelDeploymentOutputOptions extends SharedDeploymentOptions {
  bundleEntry: string
  bundleOptions: BundleOptions
  config?: object
  configKeys?: string[]
  function?: VercelFunctionOutput
  functionConfig?: object
  outputRoot?: string
  staticOutputDir?: string
}

interface NetlifyFunctionDeploymentOutput {
  bundleEntry: string
  bundleOptions: BundleOptions
  config?: object
  functionName: string
}

interface NetlifyDeploymentOutputOptions extends SharedDeploymentOptions {
  config?: object
  configKeys?: string[]
  functions?: NetlifyFunctionDeploymentOutput[]
  outputRoot?: string
}

export type CloudflareProviderDeploymentOutput = Omit<CloudflareDeploymentOutputOptions, keyof SharedDeploymentOptions>
type NetlifyProviderDeploymentOutput = Omit<NetlifyDeploymentOutputOptions, keyof SharedDeploymentOptions>
export type VercelProviderDeploymentOutput = Omit<VercelDeploymentOutputOptions, keyof SharedDeploymentOptions>

interface CloudflareProviderDeploymentCleanup {
  fileNames?: string[]
  outputRoot?: string
  wranglerConfigOwnership?: ProviderOutputConfigOwnership
}

interface VercelProviderDeploymentCleanup {
  configKeys?: string[]
  outputRoot?: string
  serverFunctionName?: string
}

type VercelProviderDeploymentCleanupInput = VercelProviderDeploymentCleanup | VercelProviderDeploymentCleanup[] | (() => VercelProviderDeploymentCleanup | VercelProviderDeploymentCleanup[] | undefined | Promise<VercelProviderDeploymentCleanup | VercelProviderDeploymentCleanup[] | undefined>)

interface NetlifyProviderDeploymentCleanup {
  configKeys?: string[]
  functionNames?: string[]
  outputRoot?: string
}

export interface ProviderDeploymentOutputOptions extends SharedDeploymentOptions {
  afterWrite?: (signal?: AbortSignal) => Promise<void>
  cloudflare?: CloudflareProviderDeploymentOutput
  cleanup?: {
    cloudflare?: CloudflareProviderDeploymentCleanup | (() => CloudflareProviderDeploymentCleanup | Promise<CloudflareProviderDeploymentCleanup>)
    netlify?: NetlifyProviderDeploymentCleanup
    vercel?: VercelProviderDeploymentCleanupInput
  }
  netlify?: NetlifyProviderDeploymentOutput
  vercel?: VercelProviderDeploymentOutput
}

export type ProviderDeploymentOutputOwner =
  | "agent"
  | "database"
  | "blob"
  | "queue"
  | "rate-limit"
  | "schedule"
  | "workflow"
  | "vite-hub"

export interface ProviderDeploymentOutputWriter {
  (options: ProviderDeploymentOutputOptions): Promise<void>
}

export interface ProviderDeploymentOutputContribution {
  owner: ProviderDeploymentOutputOwner
  rootDir: string
  write: (context: { signal: AbortSignal; write: ProviderDeploymentOutputWriter }) => Promise<void>
}

interface FinalizeProviderDeploymentOutputOptions {
  signal?: AbortSignal
}

const providerDeploymentOutputWrites = new Map<string, Promise<unknown>>()
interface ProviderDeploymentOutputFinalization {
  controller: AbortController
  handoff?: Promise<void>
  promise: Promise<void>
  reset?: ProviderDeploymentOutputReset
}

const providerDeploymentOutputFinalizations = new WeakMap<ProviderOutputCatalogType, ProviderDeploymentOutputFinalization>()
interface ProviderDeploymentOutputReset {
  failures: Set<unknown>
  promise: Promise<void>
}

const providerDeploymentOutputCompletedResets = new WeakMap<ProviderOutputCatalogType, ProviderDeploymentOutputReset>()

const providerDeploymentOutputOwnerOrder: ProviderDeploymentOutputOwner[] = [
  "agent",
  "database",
  "blob",
  "queue",
  "rate-limit",
  "schedule",
  "workflow",
  "vite-hub",
]

function throwIfProviderOutputAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  throw signal.reason ?? new DOMException("Provider Output finalization aborted.", "AbortError")
}

async function settleWrites(writes: Array<Promise<void>>): Promise<void> {
  const results = await Promise.allSettled(writes)
  const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected")
  if (failure) throw failure.reason
}

interface ResolvedClientOutput {
  clientDir: string
  staticIndex: boolean
}

function resolveClientOutput(rootDir: string, clientOutDir: string): ResolvedClientOutput {
  const clientDir = resolve(rootDir, clientOutDir)
  return {
    clientDir,
    staticIndex: hasStaticIndex(clientDir),
  }
}

function createDefaultCloudflareStaticOutputDir(rootDir: string): string {
  return resolve(rootDir, "dist", "client")
}

export function createDefaultVercelOutputRoot(rootDir: string): string {
  return resolve(rootDir, ".vercel", "output")
}

export function createDefaultNetlifyOutputRoot(rootDir: string): string {
  return resolve(rootDir, ".netlify", "v1")
}

function assertNetlifyFunctionName(functionName: string): void {
  if (!functionName || functionName.includes("\\") || functionName.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error(`Invalid Netlify function name: ${functionName}`)
  }
}

function resolveNetlifyFunctionFile(functionsRoot: string, functionName: string): string {
  assertNetlifyFunctionName(functionName)
  return resolve(functionsRoot, `${functionName}.mjs`)
}

async function appendNetlifyFunctionConfig(outfile: string, config: object | undefined): Promise<void> {
  if (!config) return
  const bundled = await readFile(outfile, "utf8")
  await writeFile(outfile, `${bundled.trimEnd()}\n\nexport const config = ${stringifyProviderOutputConfig(config)}\n`, "utf8")
}

async function writeCloudflareDeploymentOutput(options: CloudflareDeploymentOutputOptions, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  const { clientDir, staticIndex } = resolveClientOutput(options.rootDir, options.clientOutDir)
  const outputRoot = options.outputRoot ?? createDefaultCloudflareOutputRoot(options.rootDir)
  const staticOutputDir = options.staticOutputDir ?? createDefaultCloudflareStaticOutputDir(options.rootDir)
  const copiesStaticOutput = Boolean(options.bundleEntry && staticIndex && resolve(clientDir) !== resolve(staticOutputDir))
  const files = Object.entries(options.files ?? {})
  const workerOutfile = options.bundleEntry
    ? resolve(outputRoot, options.bundleOutfileName ?? "index.js")
    : undefined
  if (workerOutfile && files.some(([fileName]) => resolve(outputRoot, fileName) === workerOutfile)) {
    throw new Error(`Cloudflare output file conflicts with bundle outfile: ${workerOutfile}`)
  }
  const backupRoot = copiesStaticOutput
    ? await mkdtemp(resolve(dirname(clientDir), ".vitehub-cloudflare-output-"))
    : undefined
  const previousOutputRoot = backupRoot ? resolve(backupRoot, "output") : `${outputRoot}.previous`
  const previousStaticOutputDir = backupRoot ? resolve(backupRoot, "static") : `${staticOutputDir}.previous`

  if (!backupRoot) await rm(previousOutputRoot, { force: true, recursive: true })
  if (copiesStaticOutput && !backupRoot) await rm(previousStaticOutputDir, { force: true, recursive: true })
  let hadPreviousOutput = false
  let hadPreviousStaticOutput = false
  let publicationSucceeded = false
  let outputRestorationSucceeded = false
  let staticRestorationSucceeded = false
  try {
    await cp(outputRoot, previousOutputRoot, { recursive: true })
    hadPreviousOutput = true
  }
  catch (error) {
    // SAFETY: Node filesystem failures expose their stable error code through ErrnoException.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  if (copiesStaticOutput) {
    try {
      await cp(staticOutputDir, previousStaticOutputDir, { recursive: true })
      hadPreviousStaticOutput = true
    }
    catch (error) {
      // SAFETY: Node filesystem failures expose their stable error code through ErrnoException.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }

  await mkdir(outputRoot, { recursive: true })

  const writes = [
    writeCloudflareWranglerConfig({
      outputRoot,
      rootDir: options.rootDir,
      wranglerConfig: options.wranglerConfig,
      wranglerConfigOwnership: options.wranglerConfigOwnership ?? { keys: options.wranglerConfigKeys },
    }),
    options.bundleEntry && staticIndex
      ? copyClientOutput(clientDir, staticOutputDir)
      : Promise.resolve(),
    ...files.map(([fileName, contents]) =>
      writeFile(resolve(outputRoot, fileName), contents, "utf8")),
  ]

  if (options.bundleEntry && workerOutfile) {
    const stagedWorkerOutfile = `${workerOutfile}.pending`
    writes.push((async () => {
      try {
        await rm(stagedWorkerOutfile, { force: true, recursive: true })
        await bundleEsmEntry(options.bundleEntry!, stagedWorkerOutfile, { ...options.bundleOptions, rootDir: options.rootDir, signal })
        signal?.throwIfAborted()
        await rename(stagedWorkerOutfile, workerOutfile)
      }
      catch (error) {
        await rm(stagedWorkerOutfile, { force: true, recursive: true })
        throw error
      }
    })())
  }

  try {
    await settleWrites(writes)
    signal?.throwIfAborted()
    publicationSucceeded = true
  }
  catch (error) {
    await rm(outputRoot, { force: true, recursive: true })
    if (hadPreviousOutput) {
      await cp(previousOutputRoot, outputRoot, { recursive: true })
      outputRestorationSucceeded = true
    }
    if (copiesStaticOutput) {
      await rm(staticOutputDir, { force: true, recursive: true })
      if (hadPreviousStaticOutput) {
        await cp(previousStaticOutputDir, staticOutputDir, { recursive: true })
        staticRestorationSucceeded = true
      }
    }
    throw error
  }
  finally {
    if (publicationSucceeded || outputRestorationSucceeded || !hadPreviousOutput) {
      await rm(previousOutputRoot, { force: true, recursive: true }).catch(() => undefined)
    }
    if (copiesStaticOutput && (publicationSucceeded || staticRestorationSucceeded || !hadPreviousStaticOutput)) {
      await rm(previousStaticOutputDir, { force: true, recursive: true }).catch(() => undefined)
    }
    if (backupRoot) await rmdir(backupRoot).catch(() => undefined)
  }
}

async function copyVercelClientOutput(rootDir: string, clientDir: string, staticOutputDir: string): Promise<void> {
  const cloudflareOutputRoot = createDefaultCloudflareOutputRoot(rootDir)
  const outputRelativePath = relative(clientDir, cloudflareOutputRoot)
  const excludesCloudflareOutput = outputRelativePath
    && outputRelativePath !== ".."
    && !outputRelativePath.startsWith(`..${sep}`)
    && !isAbsolute(outputRelativePath)

  await copyClientOutput(clientDir, staticOutputDir)
  if (resolve(clientDir) === resolve(staticOutputDir) || !excludesCloudflareOutput) return

  try {
    await readFile(resolve(cloudflareOutputRoot, "wrangler.json"))
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }

  await rm(resolve(staticOutputDir, outputRelativePath), { force: true, recursive: true })
}

async function writeVercelDeploymentOutput(options: VercelDeploymentOutputOptions, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  const { clientDir, staticIndex } = resolveClientOutput(options.rootDir, options.clientOutDir)
  const outputRoot = options.outputRoot ?? createDefaultVercelOutputRoot(options.rootDir)
  const stagedOutputRoot = `${outputRoot}.pending`
  const previousOutputRoot = `${outputRoot}.previous`
  const functionOutput = options.function ?? { kind: "root" }
  const serverFunctionName = functionOutput.kind === "root" ? "__server.func" : functionOutput.name
  const config = options.config ?? (functionOutput.kind === "root" ? createVercelConfigJson() : {})
  const serverDir = resolve(stagedOutputRoot, "functions", serverFunctionName)
  const serverEntry = resolve(serverDir, "index.mjs")
  const staticOutputDir = options.staticOutputDir ?? resolve(outputRoot, "static")
  const staticRelativePath = relative(outputRoot, staticOutputDir)
  const staticInsideOutputRoot = !staticRelativePath.startsWith(`..${sep}`) && !isAbsolute(staticRelativePath)
  const externalStaticNeedsCommit = staticIndex
    && !staticInsideOutputRoot
    && resolve(clientDir) !== resolve(staticOutputDir)
  const stagedStaticOutputDir = staticInsideOutputRoot
    ? resolve(stagedOutputRoot, staticRelativePath)
    : externalStaticNeedsCommit ? `${staticOutputDir}.pending` : staticOutputDir
  const previousStaticOutputDir = `${staticOutputDir}.previous`
  let replacedOutput = false
  let installedOutput = false
  let replacedExternalStatic = false
  let installedExternalStatic = false

  try {
    await rm(stagedOutputRoot, { force: true, recursive: true })
    try {
      await cp(outputRoot, stagedOutputRoot, { recursive: true })
    }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error
    }
    await mkdir(serverDir, { recursive: true })
    await rm(serverDir, { force: true, recursive: true })
    await mkdir(serverDir, { recursive: true })
    try {
      await cp(resolve(outputRoot, "functions", serverFunctionName, "node_modules"), resolve(serverDir, "node_modules"), { recursive: true })
    }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error
    }
    await bundleEsmEntry(options.bundleEntry, serverEntry, { ...options.bundleOptions, rootDir: options.rootDir, signal })
    await writeFile(
      resolve(serverDir, ".vc-config.json"),
      `${stringifyProviderOutputConfig(options.functionConfig ?? createNodeFunctionConfig())}\n`,
      "utf8",
    )
    const writes = await Promise.allSettled([
      writeProviderOutputConfig(resolve(stagedOutputRoot, "config.json"), config, { keys: options.configKeys }),
      staticIndex
        ? copyVercelClientOutput(options.rootDir, clientDir, stagedStaticOutputDir)
        : Promise.resolve(),
    ])
    const failedWrite = writes.find(result => result.status === "rejected")
    if (failedWrite?.status === "rejected") throw failedWrite.reason
    signal?.throwIfAborted()

    rmSync(previousOutputRoot, { force: true, recursive: true })
    if (existsSync(outputRoot)) {
      renameSync(outputRoot, previousOutputRoot)
      replacedOutput = true
    }
    try {
      renameSync(stagedOutputRoot, outputRoot)
      installedOutput = true
    }
    catch (error) {
      if (replacedOutput && existsSync(previousOutputRoot)) renameSync(previousOutputRoot, outputRoot)
      replacedOutput = false
      throw error
    }
    signal?.throwIfAborted()

    if (externalStaticNeedsCommit) {
      rmSync(previousStaticOutputDir, { force: true, recursive: true })
      if (existsSync(staticOutputDir)) {
        renameSync(staticOutputDir, previousStaticOutputDir)
        replacedExternalStatic = true
      }
      try {
        renameSync(stagedStaticOutputDir, staticOutputDir)
        installedExternalStatic = true
      }
      catch (error) {
        if (replacedExternalStatic && existsSync(previousStaticOutputDir)) renameSync(previousStaticOutputDir, staticOutputDir)
        replacedExternalStatic = false
        throw error
      }
      signal?.throwIfAborted()
    }

    try {
      rmSync(previousOutputRoot, { force: true, recursive: true })
    }
    catch {}
    if (replacedExternalStatic) {
      try {
        rmSync(previousStaticOutputDir, { force: true, recursive: true })
      }
      catch {}
    }
  }
  catch (error) {
    await rm(stagedOutputRoot, { force: true, recursive: true })
    if (externalStaticNeedsCommit) await rm(stagedStaticOutputDir, { force: true, recursive: true })
    if (installedExternalStatic) rmSync(staticOutputDir, { force: true, recursive: true })
    if (replacedExternalStatic) {
      if (existsSync(previousStaticOutputDir)) renameSync(previousStaticOutputDir, staticOutputDir)
    }
    if (installedOutput) rmSync(outputRoot, { force: true, recursive: true })
    if (replacedOutput) {
      if (existsSync(previousOutputRoot)) renameSync(previousOutputRoot, outputRoot)
    }
    throw error
  }
}

async function writeNetlifyDeploymentOutput(options: NetlifyDeploymentOutputOptions, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  const outputRoot = options.outputRoot ?? createDefaultNetlifyOutputRoot(options.rootDir)
  const stagedOutputRoot = `${outputRoot}.pending`
  const previousOutputRoot = `${outputRoot}.previous`
  const functionsRoot = resolve(stagedOutputRoot, "functions")
  let replacedOutput = false
  let installedOutput = false
  await rm(stagedOutputRoot, { force: true, recursive: true })
  await rm(previousOutputRoot, { force: true, recursive: true })
  try {
    await cp(outputRoot, stagedOutputRoot, { recursive: true })
  }
  catch (error) {
    // SAFETY: Node filesystem failures expose their stable error code through ErrnoException.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  const functionWrites = (options.functions ?? []).map(async (func) => {
    const outfile = resolveNetlifyFunctionFile(functionsRoot, func.functionName)
    await mkdir(dirname(outfile), { recursive: true })
    await bundleEsmEntry(func.bundleEntry, outfile, {
      ...func.bundleOptions,
      minifyIdentifiers: func.config ? true : func.bundleOptions.minifyIdentifiers,
      rootDir: options.rootDir,
      signal,
    })
    await appendNetlifyFunctionConfig(outfile, func.config)
  })

  try {
    await mkdir(stagedOutputRoot, { recursive: true })
    await settleWrites([
      writeProviderOutputConfig(resolve(stagedOutputRoot, "config.json"), options.config ?? {}, { keys: options.configKeys }),
      ...functionWrites,
    ])
    signal?.throwIfAborted()
    if (existsSync(outputRoot)) {
      renameSync(outputRoot, previousOutputRoot)
      replacedOutput = true
    }
    renameSync(stagedOutputRoot, outputRoot)
    installedOutput = true
    signal?.throwIfAborted()
  }
  catch (error) {
    await rm(stagedOutputRoot, { force: true, recursive: true })
    if (installedOutput) rmSync(outputRoot, { force: true, recursive: true })
    if (replacedOutput && existsSync(previousOutputRoot)) renameSync(previousOutputRoot, outputRoot)
    throw error
  }
  try {
    rmSync(previousOutputRoot, { force: true, recursive: true })
  }
  catch {}
}

async function cleanupCloudflareDeploymentOutput(rootDir: string, cleanupInput: CloudflareProviderDeploymentCleanup | (() => CloudflareProviderDeploymentCleanup | Promise<CloudflareProviderDeploymentCleanup>), signal?: AbortSignal): Promise<void> {
  const cleanup = typeof cleanupInput === "function" ? await cleanupInput() : cleanupInput
  signal?.throwIfAborted()
  const outputRoot = cleanup.outputRoot ?? createDefaultCloudflareOutputRoot(rootDir)
  const writes = (cleanup.fileNames ?? []).map(fileName => rm(resolve(outputRoot, fileName), { force: true, recursive: true }))
  writes.push(writeCloudflareWranglerConfig({
    outputRoot,
    rootDir,
    wranglerConfigOwnership: cleanup.wranglerConfigOwnership,
  }))
  await Promise.all(writes)
  try {
    await rmdir(outputRoot)
  }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "ENOENT" && code !== "ENOTEMPTY") throw error
  }
}

async function cleanupVercelDeploymentOutput(rootDir: string, cleanup: VercelProviderDeploymentCleanup, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  const outputRoot = cleanup.outputRoot ?? createDefaultVercelOutputRoot(rootDir)
  const writes: Array<Promise<void>> = []
  if (cleanup.serverFunctionName) {
    writes.push(rm(resolve(outputRoot, "functions", cleanup.serverFunctionName), { force: true, recursive: true }))
  }
  writes.push(cleanProviderOutputConfig(resolve(outputRoot, "config.json"), { keys: cleanup.configKeys }))
  await Promise.all(writes)
}

async function cleanupVercelDeploymentOutputs(rootDir: string, cleanup: VercelProviderDeploymentCleanup | VercelProviderDeploymentCleanup[], signal?: AbortSignal): Promise<void> {
  await Promise.all((Array.isArray(cleanup) ? cleanup : [cleanup]).map(item => cleanupVercelDeploymentOutput(rootDir, item, signal)))
}

async function cleanupNetlifyDeploymentOutput(rootDir: string, cleanup: NetlifyProviderDeploymentCleanup, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  const outputRoot = cleanup.outputRoot ?? createDefaultNetlifyOutputRoot(rootDir)
  const functionsRoot = resolve(outputRoot, "functions")
  const writes = (cleanup.functionNames ?? []).map(functionName =>
    rm(resolveNetlifyFunctionFile(functionsRoot, functionName), { force: true, recursive: true }))
  writes.push(cleanProviderOutputConfig(resolve(outputRoot, "config.json"), { keys: cleanup.configKeys }))
  await Promise.all(writes)
}

async function writeProviderDeploymentOutputsNow(
  options: ProviderDeploymentOutputOptions,
  signal?: AbortSignal,
  transaction?: ProviderDeploymentOutputRootTransaction,
): Promise<void> {
  signal?.throwIfAborted()
  await transaction?.snapshot(providerDeploymentOutputPaths(options))
  const writes: Array<Promise<void>> = []
  if (options.cloudflare) {
    writes.push(writeCloudflareDeploymentOutput({
      ...options.cloudflare,
      clientOutDir: options.clientOutDir,
      rootDir: options.rootDir,
    }, signal))
  }
  if (options.netlify) {
    writes.push(writeNetlifyDeploymentOutput({
      ...options.netlify,
      clientOutDir: options.clientOutDir,
      rootDir: options.rootDir,
    }, signal))
  }
  if (options.vercel) {
    writes.push(writeVercelDeploymentOutput({
      ...options.vercel,
      clientOutDir: options.clientOutDir,
      rootDir: options.rootDir,
    }, signal))
  }
  await settleWrites(writes)
  signal?.throwIfAborted()
  await options.afterWrite?.(signal)
  signal?.throwIfAborted()

  const cleanups: Array<() => Promise<void>> = []
  const cleanupPaths: string[] = []
  if (!options.cloudflare && options.cleanup?.cloudflare) {
    const cleanup = typeof options.cleanup.cloudflare === "function"
      ? await options.cleanup.cloudflare()
      : options.cleanup.cloudflare
    cleanupPaths.push(cleanup.outputRoot ?? createDefaultCloudflareOutputRoot(options.rootDir))
    cleanups.push(async () => await cleanupCloudflareDeploymentOutput(options.rootDir, cleanup, signal))
  }
  if (!options.netlify && options.cleanup?.netlify) {
    const cleanup = options.cleanup.netlify
    cleanupPaths.push(cleanup.outputRoot ?? createDefaultNetlifyOutputRoot(options.rootDir))
    cleanups.push(async () => await cleanupNetlifyDeploymentOutput(options.rootDir, cleanup, signal))
  }
  if (!options.vercel && options.cleanup?.vercel) {
    const cleanup = typeof options.cleanup.vercel === "function" ? await options.cleanup.vercel() : options.cleanup.vercel
    signal?.throwIfAborted()
    if (cleanup) {
      const items = Array.isArray(cleanup) ? cleanup : [cleanup]
      cleanupPaths.push(...items.map(item => item.outputRoot ?? createDefaultVercelOutputRoot(options.rootDir)))
      cleanups.push(async () => await cleanupVercelDeploymentOutputs(options.rootDir, cleanup, signal))
    }
  }
  await transaction?.snapshot(cleanupPaths)
  await settleWrites(cleanups.map(cleanup => cleanup()))
  signal?.throwIfAborted()
}

function providerDeploymentOutputPaths(options: ProviderDeploymentOutputOptions): string[] {
  return [
    options.cloudflare?.outputRoot,
    options.cloudflare?.staticOutputDir,
    options.netlify?.outputRoot,
    options.vercel?.outputRoot,
    options.vercel?.staticOutputDir,
  ].filter((path): path is string => Boolean(path))
}

async function withProviderDeploymentOutputRootLock<T>(rootDir: string, operation: () => Promise<T>): Promise<T> {
  const key = resolve(rootDir)
  const previous = providerDeploymentOutputWrites.get(key) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(operation)
  providerDeploymentOutputWrites.set(key, current)
  try {
    return await current
  }
  finally {
    if (providerDeploymentOutputWrites.get(key) === current) providerDeploymentOutputWrites.delete(key)
  }
}

interface ProviderDeploymentOutputSnapshot {
  backup: string
  path: string
  present: boolean
}

interface ProviderDeploymentOutputRootTransaction {
  snapshot: (paths: string[]) => Promise<void>
}

function pathContains(parent: string, child: string): boolean {
  const nested = relative(parent, child)
  return !nested || (!nested.startsWith(`..${sep}`) && nested !== ".." && !isAbsolute(nested))
}

async function restoreProviderDeploymentOutputSnapshot(snapshot: ProviderDeploymentOutputSnapshot): Promise<void> {
  if (!snapshot.present) {
    await rm(snapshot.path, { force: true, recursive: true })
    return
  }
  const restoreRoot = await mkdtemp(resolve(dirname(snapshot.path), ".vitehub-provider-output-restore-"))
  const staged = resolve(restoreRoot, "snapshot")
  let restored = false
  try {
    await cp(snapshot.backup, staged, { recursive: true })
    await rm(snapshot.path, { force: true, recursive: true })
    await rename(staged, snapshot.path)
    restored = true
  }
  finally {
    if (restored) await rm(restoreRoot, { force: true, recursive: true })
  }
}

async function withProviderDeploymentOutputRootTransaction<T>(
  rootDir: string,
  operation: (transaction: ProviderDeploymentOutputRootTransaction) => Promise<T>,
): Promise<T> {
  const roots = [
    createDefaultCloudflareOutputRoot(rootDir),
    createDefaultCloudflareStaticOutputDir(rootDir),
    createDefaultNetlifyOutputRoot(rootDir),
    createDefaultVercelOutputRoot(rootDir),
    resolve(rootDir, ".vitehub"),
  ]
  const transactionRoot = await mkdtemp(resolve(tmpdir(), "vitehub-provider-output-"))
  const snapshots = new Map<string, ProviderDeploymentOutputSnapshot>()
  let snapshotIndex = 0
  const transaction: ProviderDeploymentOutputRootTransaction = {
    async snapshot(paths) {
      const candidates = [...new Set(paths.map(path => resolve(path)))]
        .sort((left, right) => left.length - right.length)
        .filter((path, index, all) => !all.slice(0, index).some(parent => pathContains(parent, path)))
        .filter(path => ![...snapshots.keys()].some(parent => pathContains(parent, path)))
      const expanding = candidates.find(path => [...snapshots.keys()].some(child => pathContains(path, child)))
      if (expanding) throw new Error(`Provider Output transaction cannot expand over an active snapshot: ${expanding}`)
      const pending = candidates.map(path => ({
        backup: resolve(transactionRoot, String(snapshotIndex++)),
        path,
        present: existsSync(path),
      }))
      const results = await Promise.allSettled(pending.map(async (snapshot) => {
        if (snapshot.present) await cp(snapshot.path, snapshot.backup, { recursive: true })
      }))
      const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected")
      if (failure) {
        await Promise.all(pending.map(snapshot => rm(snapshot.backup, { force: true, recursive: true })))
        throw failure.reason
      }
      for (const snapshot of pending) snapshots.set(snapshot.path, snapshot)
    },
  }
  try {
    await transaction.snapshot(roots)
    const result = await operation(transaction)
    await rm(transactionRoot, { force: true, recursive: true })
    return result
  }
  catch (error) {
    const restorations = await Promise.allSettled([...snapshots.values()].map(restoreProviderDeploymentOutputSnapshot))
    if (restorations.every(result => result.status === "fulfilled")) {
      await rm(transactionRoot, { force: true, recursive: true })
    }
    const restorationFailure = restorations.find((result): result is PromiseRejectedResult => result.status === "rejected")
    if (restorationFailure) throw new AggregateError([error, restorationFailure.reason], "Provider Output rollback failed")
    throw error
  }
}

export function contributeProviderDeploymentOutput(
  catalog: ProviderOutputCatalogType | undefined,
  contribution: ProviderDeploymentOutputContribution,
  generation?: number,
): void {
  catalog?.replaceDeploymentContribution(contribution, generation)
}

export function captureProviderDeploymentOutputGeneration(catalog: ProviderOutputCatalogType | undefined): number | undefined {
  return catalog?.deploymentGeneration()
}

interface ProviderDeploymentOutputPluginContext {
  environment?: object
}

export function createProviderDeploymentOutputGenerationState(): {
  capture: (context: ProviderDeploymentOutputPluginContext | undefined, catalog: ProviderOutputCatalogType | undefined) => void
  get: (context: ProviderDeploymentOutputPluginContext | undefined) => number | undefined
} {
  const generations = new WeakMap<object, number | undefined>()
  const fallback = {}
  const environment = (context: ProviderDeploymentOutputPluginContext | undefined): object => context
    ? context.environment ?? context
    : fallback
  return {
    capture(context, catalog) {
      generations.set(environment(context), captureProviderDeploymentOutputGeneration(catalog))
    },
    get(context) {
      return generations.get(environment(context))
    },
  }
}

export async function resetProviderDeploymentOutputs(catalog: ProviderOutputCatalogType | undefined, failure?: unknown): Promise<void> {
  if (!catalog) return
  const completedReset = providerDeploymentOutputCompletedResets.get(catalog)
  if (completedReset && failure !== undefined && completedReset.failures.has(failure)) {
    await completedReset.promise
    return
  }
  if (completedReset) providerDeploymentOutputCompletedResets.delete(catalog)
  const active = providerDeploymentOutputFinalizations.get(catalog)
  if (active?.reset) {
    if (failure !== undefined && !active.reset.failures.has(failure)) {
      active.reset.failures.add(failure)
      catalog.resetDeploymentContributions()
    }
    providerDeploymentOutputCompletedResets.set(catalog, active.reset)
    await active.reset.promise
    return
  }
  active?.controller.abort(new Error("Provider Output finalization reset"))
  catalog?.resetDeploymentContributions()
  if (active) {
    active.reset = {
      failures: new Set([failure]),
      promise: active.promise.catch(() => undefined),
    }
    providerDeploymentOutputCompletedResets.set(catalog, active.reset)
    await active.reset.promise
  }
  else if (failure !== undefined) {
    providerDeploymentOutputCompletedResets.set(catalog, {
      failures: new Set([failure]),
      promise: Promise.resolve(),
    })
  }
}

export async function finalizeProviderDeploymentOutputs(
  catalog: ProviderOutputCatalogType | undefined,
  options: FinalizeProviderDeploymentOutputOptions = {},
): Promise<void> {
  if (!catalog) return
  const existing = providerDeploymentOutputFinalizations.get(catalog)
  if (existing) {
    try {
      await existing.promise
    }
    catch (error) {
      if (!catalog.hasDeploymentContributions()) throw error
      existing.handoff ??= (async () => {
        await existing.promise.catch(() => undefined)
        if (providerDeploymentOutputFinalizations.get(catalog) === existing) {
          providerDeploymentOutputFinalizations.delete(catalog)
        }
        await finalizeProviderDeploymentOutputs(catalog, options)
      })()
      await existing.handoff
      return
    }
    if (providerDeploymentOutputFinalizations.get(catalog) === existing) {
      providerDeploymentOutputFinalizations.delete(catalog)
    }
    if (catalog.hasDeploymentContributions()) await finalizeProviderDeploymentOutputs(catalog, options)
    return
  }

  const controller = new AbortController()
  const finalization = (async () => {
    const order = new Map(providerDeploymentOutputOwnerOrder.map((owner, index) => [owner, index]))
    const abort = () => controller.abort(options.signal?.reason)
    if (options.signal?.aborted) abort()
    else options.signal?.addEventListener("abort", abort, { once: true })
    try {
      while (true) {
        const contributions = catalog.takeDeploymentContributions()
        if (!contributions.length) return
        contributions.sort((left, right) => order.get(left.owner)! - order.get(right.owner)!)
        const grouped = new Map<string, ProviderDeploymentOutputContribution[]>()
        for (const contribution of contributions) {
          const rootDir = resolve(contribution.rootDir)
          const rootContributions = grouped.get(rootDir) ?? []
          rootContributions.push(contribution)
          grouped.set(rootDir, rootContributions)
        }
        await settleWrites([...grouped.entries()].map(async ([rootDir, rootContributions]) => {
          await withProviderDeploymentOutputRootLock(rootDir, async () => {
            await withProviderDeploymentOutputRootTransaction(rootDir, async (transaction) => {
              for (const contribution of rootContributions) {
                throwIfProviderOutputAborted(controller.signal)
                try {
                  await contribution.write({
                    signal: controller.signal,
                    write: async (writeOptions) => {
                      throwIfProviderOutputAborted(controller.signal)
                      await writeProviderDeploymentOutputsNow(writeOptions, controller.signal, transaction)
                    },
                  })
                }
                catch (error) {
                  controller.abort(error)
                  throw error
                }
                throwIfProviderOutputAborted(controller.signal)
              }
            })
          })
        }))
      }
    }
    finally {
      options.signal?.removeEventListener("abort", abort)
    }
  })()
  const active = { controller, promise: finalization }
  providerDeploymentOutputFinalizations.set(catalog, active)
  try {
    await finalization
  }
  finally {
    if (providerDeploymentOutputFinalizations.get(catalog) === active) {
      providerDeploymentOutputFinalizations.delete(catalog)
    }
  }
}

export async function withProviderDeploymentOutputLock<T>(
  rootDir: string,
  operation: (write: (options: ProviderDeploymentOutputOptions) => Promise<void>) => Promise<T>,
): Promise<T> {
  return await withProviderDeploymentOutputRootLock(rootDir, async () => await operation(writeProviderDeploymentOutputsNow))
}

export async function writeProviderDeploymentOutputs(options: ProviderDeploymentOutputOptions): Promise<void> {
  await withProviderDeploymentOutputLock(options.rootDir, async write => await write(options))
}
