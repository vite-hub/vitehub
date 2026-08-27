import { mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises"
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
  afterWrite?: () => Promise<void>
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
}

const providerDeploymentOutputFinalizations = new WeakMap<ProviderOutputCatalogType, ProviderDeploymentOutputFinalization>()

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
  const files = Object.entries(options.files ?? {})
  const workerOutfile = options.bundleEntry
    ? resolve(outputRoot, options.bundleOutfileName ?? "index.js")
    : undefined
  if (workerOutfile && files.some(([fileName]) => resolve(outputRoot, fileName) === workerOutfile)) {
    throw new Error(`Cloudflare output file conflicts with bundle outfile: ${workerOutfile}`)
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
      ? copyClientOutput(clientDir, options.staticOutputDir ?? createDefaultCloudflareStaticOutputDir(options.rootDir))
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

  await Promise.all(writes)
  signal?.throwIfAborted()
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
  const functionOutput = options.function ?? { kind: "root" }
  const serverFunctionName = functionOutput.kind === "root" ? "__server.func" : functionOutput.name
  const config = options.config ?? (functionOutput.kind === "root" ? createVercelConfigJson() : {})
  const serverDir = resolve(outputRoot, "functions", serverFunctionName)
  const serverEntry = resolve(serverDir, "index.mjs")
  const stagedServerEntry = resolve(serverDir, ".index.mjs.pending")

  await mkdir(serverDir, { recursive: true })
  const staleFiles = (await readdir(serverDir)).filter(file => file !== "node_modules" && file !== ".index.mjs.pending")

  try {
    await rm(stagedServerEntry, { force: true })
    await bundleEsmEntry(options.bundleEntry, stagedServerEntry, { ...options.bundleOptions, rootDir: options.rootDir, signal })
    signal?.throwIfAborted()
    await Promise.all(staleFiles.map(file => rm(resolve(serverDir, file), { force: true, recursive: true })))
    if ((await readdir(serverDir)).includes(".index.mjs.pending")) {
      await rename(stagedServerEntry, serverEntry)
    }
  }
  catch (error) {
    await rm(stagedServerEntry, { force: true })
    throw error
  }

  const writes = await Promise.allSettled([
    writeFile(
      resolve(serverDir, ".vc-config.json"),
      `${stringifyProviderOutputConfig(options.functionConfig ?? createNodeFunctionConfig())}\n`,
      "utf8",
    ),
    writeProviderOutputConfig(resolve(outputRoot, "config.json"), config, { keys: options.configKeys }),
    staticIndex
      ? copyVercelClientOutput(options.rootDir, clientDir, options.staticOutputDir ?? resolve(outputRoot, "static"))
      : Promise.resolve(),
  ])
  const failedWrite = writes.find(result => result.status === "rejected")
  if (failedWrite?.status === "rejected") throw failedWrite.reason
  signal?.throwIfAborted()
}

async function writeNetlifyDeploymentOutput(options: NetlifyDeploymentOutputOptions, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  const outputRoot = options.outputRoot ?? createDefaultNetlifyOutputRoot(options.rootDir)
  const functionsRoot = resolve(outputRoot, "functions")
  const functionWrites = (options.functions ?? []).map(async (func) => {
    const outfile = resolveNetlifyFunctionFile(functionsRoot, func.functionName)
    const stagedOutfile = `${outfile}.pending`
    await mkdir(dirname(outfile), { recursive: true })
    try {
      await rm(stagedOutfile, { force: true, recursive: true })
      await bundleEsmEntry(func.bundleEntry, stagedOutfile, {
        ...func.bundleOptions,
        minifyIdentifiers: func.config ? true : func.bundleOptions.minifyIdentifiers,
        rootDir: options.rootDir,
        signal,
      })
      await appendNetlifyFunctionConfig(stagedOutfile, func.config)
      signal?.throwIfAborted()
      await rename(stagedOutfile, outfile)
    }
    catch (error) {
      await rm(stagedOutfile, { force: true, recursive: true })
      throw error
    }
  })

  await mkdir(outputRoot, { recursive: true })
  await Promise.all([
    writeProviderOutputConfig(resolve(outputRoot, "config.json"), options.config ?? {}, { keys: options.configKeys }),
    ...functionWrites,
  ])
  signal?.throwIfAborted()
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
): Promise<void> {
  signal?.throwIfAborted()
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
  await options.afterWrite?.()
  signal?.throwIfAborted()

  const cleanups: Array<Promise<void>> = []
  if (!options.cloudflare && options.cleanup?.cloudflare) {
    cleanups.push(cleanupCloudflareDeploymentOutput(options.rootDir, options.cleanup.cloudflare, signal))
  }
  if (!options.netlify && options.cleanup?.netlify) {
    cleanups.push(cleanupNetlifyDeploymentOutput(options.rootDir, options.cleanup.netlify, signal))
  }
  if (!options.vercel && options.cleanup?.vercel) {
    const cleanup = typeof options.cleanup.vercel === "function" ? await options.cleanup.vercel() : options.cleanup.vercel
    signal?.throwIfAborted()
    if (cleanup) cleanups.push(cleanupVercelDeploymentOutputs(options.rootDir, cleanup, signal))
  }
  await settleWrites(cleanups)
  signal?.throwIfAborted()
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

export function contributeProviderDeploymentOutput(
  catalog: ProviderOutputCatalogType | undefined,
  contribution: ProviderDeploymentOutputContribution,
): void {
  catalog?.replaceDeploymentContribution(contribution)
}

export async function resetProviderDeploymentOutputs(catalog: ProviderOutputCatalogType | undefined): Promise<void> {
  if (!catalog) return
  const active = providerDeploymentOutputFinalizations.get(catalog)
  active?.controller.abort(new Error("Provider Output finalization reset"))
  catalog?.resetDeploymentContributions()
  if (active) await active.promise.catch(() => undefined)
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
            for (const contribution of rootContributions) {
              throwIfProviderOutputAborted(controller.signal)
              try {
                await contribution.write({
                  signal: controller.signal,
                  write: async (writeOptions) => {
                    throwIfProviderOutputAborted(controller.signal)
                    await writeProviderDeploymentOutputsNow(writeOptions, controller.signal)
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
        }))
      }
    }
    catch (error) {
      // Contributions in this finalization were detached by takeDeploymentContributions().
      // Anything still pending belongs to a newer build and must survive this failure.
      throw error
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
