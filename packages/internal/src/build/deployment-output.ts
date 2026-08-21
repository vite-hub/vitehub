import { mkdir, readFile, readdir, rm, rmdir, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"

import { copyClientOutput, hasStaticIndex } from "./client-output.ts"
import { createDefaultCloudflareOutputRoot, writeCloudflareWranglerConfig } from "./cloudflare.ts"
import { bundleEsmEntry } from "./esbuild.ts"
import { cleanProviderOutputConfig, stringifyProviderOutputConfig, writeProviderOutputConfig } from "./provider-output-config.ts"
import { createNodeFunctionConfig, createVercelConfigJson } from "./vercel-config.ts"

import type { ProviderOutputConfigOwnership } from "./provider-output-config.ts"
import type { VercelFunctionRuntimePackage } from "./vercel-runtime-packages.ts"

export { createDefaultCloudflareOutputRoot } from "./cloudflare.ts"
export { composeNitroCloudflareProviderOutput, registerCloudflareProviderOutput } from "./cloudflare-provider-output.ts"
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

const composedProviderOutputKey = Symbol.for("vitehub.composedProviderOutput")
const providerDeploymentOutputWrites = new Map<string, Promise<unknown>>()

export interface ComposedProviderOutput {
  runtimeModuleFilesByProduct: Record<string, Record<string, string> | undefined>
  vercelRuntimePackagesByProduct?: Record<string, VercelFunctionRuntimePackage[] | undefined>
}

export function useComposedProviderOutput(config: object): ComposedProviderOutput {
  const owner = config as Record<symbol, ComposedProviderOutput | undefined>
  return owner[composedProviderOutputKey] ??= { runtimeModuleFilesByProduct: {}, vercelRuntimePackagesByProduct: {} }
}

export function resetComposedProviderOutput(composed: ComposedProviderOutput | undefined): void {
  if (composed) composed.runtimeModuleFilesByProduct = {}
  if (composed) composed.vercelRuntimePackagesByProduct = {}
}

export function registerProviderRuntimeModules(composed: ComposedProviderOutput | undefined, product: string, runtimeModuleFiles: Record<string, string>): void {
  if (composed) composed.runtimeModuleFilesByProduct[product] = runtimeModuleFiles
}

export function getProviderRuntimeModule(composed: ComposedProviderOutput | undefined, product: string, provider: string): string | undefined {
  return composed?.runtimeModuleFilesByProduct[product]?.[provider]
}

export function registerVercelRuntimePackages(composed: ComposedProviderOutput | undefined, product: string, packages: VercelFunctionRuntimePackage[]): void {
  if (composed) (composed.vercelRuntimePackagesByProduct ??= {})[product] = packages
}

export function getVercelRuntimePackages(composed: ComposedProviderOutput | undefined, product: string): VercelFunctionRuntimePackage[] {
  return composed?.vercelRuntimePackagesByProduct?.[product] ?? []
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

async function writeCloudflareDeploymentOutput(options: CloudflareDeploymentOutputOptions): Promise<void> {
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
    await rm(workerOutfile, { force: true, recursive: true })
    writes.push(bundleEsmEntry(options.bundleEntry, workerOutfile, { ...options.bundleOptions, rootDir: options.rootDir }))
  }

  await Promise.all(writes)
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

async function writeVercelDeploymentOutput(options: VercelDeploymentOutputOptions): Promise<void> {
  const { clientDir, staticIndex } = resolveClientOutput(options.rootDir, options.clientOutDir)
  const outputRoot = options.outputRoot ?? createDefaultVercelOutputRoot(options.rootDir)
  const functionOutput = options.function ?? { kind: "root" }
  const serverFunctionName = functionOutput.kind === "root" ? "__server.func" : functionOutput.name
  const config = options.config ?? (functionOutput.kind === "root" ? createVercelConfigJson() : {})
  const serverDir = resolve(outputRoot, "functions", serverFunctionName)
  const serverEntry = resolve(serverDir, "index.mjs")

  await mkdir(serverDir, { recursive: true })
  const staleFiles = (await readdir(serverDir)).filter(file => file !== "node_modules")
  await Promise.all(staleFiles.map(file => rm(resolve(serverDir, file), { force: true, recursive: true })))

  try {
    await bundleEsmEntry(options.bundleEntry, serverEntry, { ...options.bundleOptions, rootDir: options.rootDir })
  }
  catch (error) {
    await rm(serverDir, { force: true, recursive: true })
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
}

async function writeNetlifyDeploymentOutput(options: NetlifyDeploymentOutputOptions): Promise<void> {
  const outputRoot = options.outputRoot ?? createDefaultNetlifyOutputRoot(options.rootDir)
  const functionsRoot = resolve(outputRoot, "functions")
  const functionWrites = (options.functions ?? []).map(async (func) => {
    const outfile = resolveNetlifyFunctionFile(functionsRoot, func.functionName)
    await rm(outfile, { force: true, recursive: true })
    await mkdir(dirname(outfile), { recursive: true })
    await bundleEsmEntry(func.bundleEntry, outfile, {
      ...func.bundleOptions,
      minifyIdentifiers: func.config ? true : func.bundleOptions.minifyIdentifiers,
      rootDir: options.rootDir,
    })
    await appendNetlifyFunctionConfig(outfile, func.config)
  })

  await mkdir(outputRoot, { recursive: true })
  await Promise.all([
    writeProviderOutputConfig(resolve(outputRoot, "config.json"), options.config ?? {}, { keys: options.configKeys }),
    ...functionWrites,
  ])
}

async function cleanupCloudflareDeploymentOutput(rootDir: string, cleanupInput: CloudflareProviderDeploymentCleanup | (() => CloudflareProviderDeploymentCleanup | Promise<CloudflareProviderDeploymentCleanup>)): Promise<void> {
  const cleanup = typeof cleanupInput === "function" ? await cleanupInput() : cleanupInput
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

async function cleanupVercelDeploymentOutput(rootDir: string, cleanup: VercelProviderDeploymentCleanup): Promise<void> {
  const outputRoot = cleanup.outputRoot ?? createDefaultVercelOutputRoot(rootDir)
  const writes: Array<Promise<void>> = []
  if (cleanup.serverFunctionName) {
    writes.push(rm(resolve(outputRoot, "functions", cleanup.serverFunctionName), { force: true, recursive: true }))
  }
  writes.push(cleanProviderOutputConfig(resolve(outputRoot, "config.json"), { keys: cleanup.configKeys }))
  await Promise.all(writes)
}

async function cleanupVercelDeploymentOutputs(rootDir: string, cleanup: VercelProviderDeploymentCleanup | VercelProviderDeploymentCleanup[]): Promise<void> {
  await Promise.all((Array.isArray(cleanup) ? cleanup : [cleanup]).map(item => cleanupVercelDeploymentOutput(rootDir, item)))
}

async function cleanupNetlifyDeploymentOutput(rootDir: string, cleanup: NetlifyProviderDeploymentCleanup): Promise<void> {
  const outputRoot = cleanup.outputRoot ?? createDefaultNetlifyOutputRoot(rootDir)
  const functionsRoot = resolve(outputRoot, "functions")
  const writes = (cleanup.functionNames ?? []).map(functionName =>
    rm(resolveNetlifyFunctionFile(functionsRoot, functionName), { force: true, recursive: true }))
  writes.push(cleanProviderOutputConfig(resolve(outputRoot, "config.json"), { keys: cleanup.configKeys }))
  await Promise.all(writes)
}

async function writeProviderDeploymentOutputsNow(options: ProviderDeploymentOutputOptions): Promise<void> {
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
  if (options.netlify) {
    writes.push(writeNetlifyDeploymentOutput({
      ...options.netlify,
      clientOutDir: options.clientOutDir,
      rootDir: options.rootDir,
    }))
  } else if (options.cleanup?.netlify) {
    writes.push(cleanupNetlifyDeploymentOutput(options.rootDir, options.cleanup.netlify))
  }
  if (options.vercel) {
    writes.push(writeVercelDeploymentOutput({
      ...options.vercel,
      clientOutDir: options.clientOutDir,
      rootDir: options.rootDir,
    }))
  } else if (options.cleanup?.vercel) {
    const cleanup = typeof options.cleanup.vercel === "function" ? await options.cleanup.vercel() : options.cleanup.vercel
    if (cleanup) writes.push(cleanupVercelDeploymentOutputs(options.rootDir, cleanup))
  }
  await Promise.all(writes)
  await options.afterWrite?.()
}

export async function withProviderDeploymentOutputLock<T>(
  rootDir: string,
  operation: (write: (options: ProviderDeploymentOutputOptions) => Promise<void>) => Promise<T>,
): Promise<T> {
  const key = resolve(rootDir)
  const previous = providerDeploymentOutputWrites.get(key) ?? Promise.resolve()
  const write = previous.catch(() => undefined).then(() => operation(writeProviderDeploymentOutputsNow))
  providerDeploymentOutputWrites.set(key, write)
  try {
    return await write
  }
  finally {
    if (providerDeploymentOutputWrites.get(key) === write) providerDeploymentOutputWrites.delete(key)
  }
}

export async function writeProviderDeploymentOutputs(options: ProviderDeploymentOutputOptions): Promise<void> {
  await withProviderDeploymentOutputLock(options.rootDir, async write => await write(options))
}
