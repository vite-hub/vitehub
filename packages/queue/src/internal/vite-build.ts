import { hash } from "node:crypto"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, relative, resolve } from "node:path"

import { defaultCloudflareCompatibilityDate } from "@vite-hub/internal/build/cloudflare"
import { createDefaultCloudflareOutputRoot, createDefaultVercelOutputRoot, getProviderRuntimeModule, getVercelRuntimePackages, writeProviderDeploymentOutputs } from "@vite-hub/internal/build/deployment-output"
import { bundleEsmEntry } from "@vite-hub/internal/build/esbuild"
import { computePackageDir, createImportPath, ensureGeneratedDir, resolveRuntimeModule as resolveRuntimeFromPkg, toGeneratedPath } from "@vite-hub/internal/build/paths"
import { resolveUserAppEntry } from "@vite-hub/internal/build/user-entry"
import { createNodeFunctionConfig } from "@vite-hub/internal/build/vercel-config"
import { createRuntimeRegistryContents } from "@vite-hub/internal/definition-catalog"

import { normalizeQueueOptions } from "../config.ts"
import { discoverQueueDefinitions } from "../discovery.ts"
import { getCloudflareQueueBindingName } from "../integrations/cloudflare.ts"
import { getVercelQueueTopicName } from "../integrations/vercel.ts"
import { getCloudflareQueueName } from "./cloudflare-resource-name.ts"

import type { DiscoveredQueueDefinition, QueueModuleOptions, QueueProvider } from "../types.ts"
import type { CloudflareProviderDeploymentOutput, ComposedProviderOutput, VercelProviderDeploymentOutput } from "@vite-hub/internal/build/deployment-output"

export const queuePackageName = "@vite-hub/queue"
const cloudflareQueueWorkerMarker = "vitehub-queue-worker"
const cloudflareQueueOutputState = ".vitehub/queue/cloudflare-output.json"
const vercelQueueOutputState = ".vitehub/queue/vercel-output.json"
const vercelQueueFunctionMarker = ".vitehub-queue-output.json"
const productName = "queue"

const generatedRegistryFileName = "registry.mjs"
export const generatedQueueNitroPlugin = ".vitehub/nitro/queue/plugin.ts"
export const generatedQueueNitroMiddleware = ".vitehub/nitro/queue/middleware.ts"
const packageDir = computePackageDir(import.meta.url)
const packageRequire = createRequire(resolve(packageDir, "package.json"))
const resolvePackageDependency = (specifier: string) => packageRequire.resolve(specifier)
const resolveRuntimeModule = (modulePath: string) => resolveRuntimeFromPkg(packageDir, modulePath)

// Table-driven provider entry generation. Add a new entry to support a new provider.
interface ProviderEntrySpec {
  name: QueueProvider
  entryFile: string
  runtimeModule: string
  factory: string
  hosting: string
}

const providerEntrySpecs: ProviderEntrySpec[] = [
  { name: "cloudflare", entryFile: "cloudflare-worker.mjs", runtimeModule: "internal/runtime/cloudflare-vite", factory: "createQueueCloudflareWorker", hosting: "cloudflare" },
  { name: "vercel", entryFile: "vercel-server.mjs", runtimeModule: "internal/runtime/vercel-vite", factory: "createQueueVercelServer", hosting: "vercel" },
]

type NormalizedQueueOptions = false | NonNullable<ReturnType<typeof normalizeQueueOptions>>

function isVercelQueueEnabled(queueConfig: NormalizedQueueOptions) {
  return queueConfig !== false && queueConfig.provider === "vercel"
}

function resolveOutputQueueConfig(queue: QueueModuleOptions | undefined, hosting: string): NormalizedQueueOptions {
  if (typeof queue === "undefined") return false
  return normalizeQueueOptions(queue, { hosting }) || false
}

function shouldWriteProviderEntry(spec: ProviderEntrySpec, queue: QueueModuleOptions | undefined) {
  const queueConfig = resolveOutputQueueConfig(queue, spec.hosting)
  return queueConfig === false ? spec.name === "vercel" : queueConfig.provider === spec.name
}

function shouldCreateVercelOutput(queue: QueueModuleOptions | undefined) {
  const queueConfig = resolveOutputQueueConfig(queue, "vercel")
  return queueConfig === false || queueConfig.provider === "vercel"
}

interface GeneratedQueueArtifacts {
  cloudflareWorkerFile: string
  definitions: DiscoveredQueueDefinition[]
  generatedDir: string
  registryFile: string
  vercelServerFile: string
}

interface GenerateProviderOutputsOptions {
  clientOutDir: string
  cloudflareOwnedByNitro?: boolean
  definitions?: DiscoveredQueueDefinition[]
  providerImportAliases?: Record<string, string>
  providerOutput?: ComposedProviderOutput
  queue: QueueModuleOptions | undefined
  rootDir: string
  serverFunctionName?: string
}

export interface CloudflareQueueConfigOptions {
  compatibilityDate?: string
  rootDir?: string
}

export interface CloudflareQueueConfig {
  assets?: { directory?: string, run_worker_first: string[] }
  compatibility_date: string
  compatibility_flags: string[]
  main: string
  name?: string
  observability: { enabled: true }
  queues?: {
    consumers: Array<{ queue: string }>
    producers: Array<{ binding: string, queue: string }>
  }
}

function renderProviderEntry(spec: ProviderEntrySpec, entryFile: string, registryFile: string, userAppEntry: string | undefined, queueConfig: NormalizedQueueOptions, preloadVercelQueue = false, queueDefinitions?: Record<string, string>) {
  const vercelRuntime = spec.name === "vercel" && queueConfig !== false && queueConfig.provider === "vercel"
  const imports = [
    `import { ${spec.factory} } from ${JSON.stringify(createImportPath(entryFile, resolveRuntimeModule(spec.runtimeModule)))}`,
    `import queueRegistry from ${JSON.stringify(`./${generatedRegistryFileName}`)}`,
  ]
  if (vercelRuntime) {
    imports.push(`import { createVercelQueueRuntimeClient } from ${JSON.stringify(createImportPath(entryFile, resolveRuntimeModule("internal/runtime/vercel-client")))}`)
  }
  if (preloadVercelQueue) {
    imports.unshift(`import * as __vitehubVercelQueue from ${JSON.stringify(createImportPath(entryFile, resolvePackageDependency("@vercel/queue")))}`)
  }
  if (userAppEntry) {
    imports.push(`import queueApp from ${JSON.stringify(createImportPath(entryFile, userAppEntry))}`)
  }

  return [
    ...imports,
    preloadVercelQueue ? "globalThis.__vitehubVercelQueue = __vitehubVercelQueue" : "",
    "",
    `const queueConfig = ${JSON.stringify(queueConfig, null, 2)}`,
    queueDefinitions ? `const queueDefinitions = ${JSON.stringify(queueDefinitions, null, 2)}` : "",
    "",
    `export default ${spec.factory}({`,
    userAppEntry ? "  app: queueApp," : "",
    vercelRuntime ? "  createClient: createVercelQueueRuntimeClient," : "",
    queueDefinitions ? "  definitions: queueDefinitions," : "",
    "  queue: queueConfig,",
    "  registry: queueRegistry,",
    "})",
    "",
  ].filter(Boolean).join("\n")
}

async function writeProviderEntries(rootDir: string, queue: QueueModuleOptions | undefined, definitions = discoverQueueDefinitions({ rootDir })) {
  const generatedDir = ensureGeneratedDir(rootDir, productName)
  await mkdir(generatedDir, { recursive: true })

  const registryFile = resolve(generatedDir, generatedRegistryFileName)
  const userAppEntry = resolveUserAppEntry(rootDir)

  await writeFile(registryFile, createRuntimeRegistryContents(registryFile, definitions), "utf8")

  const entryFiles: Record<QueueProvider, string> = { cloudflare: "", vercel: "" }
  for (const spec of providerEntrySpecs) {
    if (!shouldWriteProviderEntry(spec, queue)) {
      continue
    }
    const entryFile = resolve(generatedDir, spec.entryFile)
    const queueConfig = resolveOutputQueueConfig(queue, spec.hosting)
    const preloadVercelQueue = spec.name === "vercel" && isVercelQueueEnabled(queueConfig)
    const queueDefinitions = spec.name === "cloudflare"
      ? createCloudflareQueueDefinitionNames(definitions, queueConfig !== false && queueConfig.provider === "cloudflare" ? queueConfig.namePrefix : undefined)
      : undefined
    await writeFile(entryFile, renderProviderEntry(spec, entryFile, registryFile, userAppEntry, queueConfig, preloadVercelQueue, queueDefinitions), "utf8")
    entryFiles[spec.name] = entryFile
  }

  return {
    cloudflareWorkerFile: entryFiles.cloudflare,
    definitions,
    generatedDir,
    registryFile,
    vercelServerFile: entryFiles.vercel,
  }
}

function createCloudflareQueueDefinitionNames(definitions: DiscoveredQueueDefinition[], namePrefix = ""): Record<string, string> {
  const names = new Map<string, DiscoveredQueueDefinition>()
  for (const definition of definitions) {
    const physicalName = getCloudflareQueueName(definition.name, namePrefix)
    const existing = names.get(physicalName)
    if (existing) {
      throw new Error(`Queue names ${JSON.stringify(existing.name)} and ${JSON.stringify(definition.name)} collide after Cloudflare resource name derivation:\n  - ${existing.handler}\n  - ${definition.handler}\nResolved Queue name: ${physicalName}`)
    }
    names.set(physicalName, definition)
  }
  return Object.fromEntries([...names].map(([physicalName, definition]) => [physicalName, definition.name]))
}

export function createCloudflareQueueBindings(definitions: DiscoveredQueueDefinition[], namePrefix = ""): CloudflareQueueConfig["queues"] {
  if (!definitions.length) {
    return undefined
  }

  const names = createCloudflareQueueDefinitionNames(definitions, namePrefix)
  return {
    consumers: Object.keys(names).map(queue => ({ queue })),
    producers: definitions.map(definition => ({
      binding: getCloudflareQueueBindingName(definition.name),
      queue: getCloudflareQueueName(definition.name, namePrefix),
    })),
  }
}

function renderNitroPlugin(pluginFile: string, registryFile: string, queueConfig: NormalizedQueueOptions, cloudflareQueues: boolean, queueDefinitions: Record<string, string>) {
  const cloudflareRuntime = queueConfig !== false && queueConfig.provider === "cloudflare"
  const vercelRuntime = queueConfig !== false && queueConfig.provider === "vercel"
  const cloudflare = cloudflareQueues && cloudflareRuntime
  const runtimeClientFactory = cloudflareRuntime
    ? "createCloudflareQueueRuntimeClient"
    : vercelRuntime
      ? "createVercelQueueRuntimeClient"
      : undefined
  return [
    "import { definePlugin } from 'nitro'",
    ...(vercelRuntime ? [`import * as __vitehubVercelQueue from ${JSON.stringify(createImportPath(pluginFile, resolvePackageDependency("@vercel/queue")))}`] : []),
    ...(cloudflareRuntime ? ["import { env as vitehubEnv, waitUntil as vitehubWaitUntil } from 'cloudflare:workers'"] : []),
    ...(cloudflare ? [`import { createQueueCloudflareWorker } from ${JSON.stringify(createImportPath(pluginFile, resolveRuntimeModule("internal/runtime/cloudflare-vite")))}`] : []),
    ...(cloudflareRuntime ? [`import { createCloudflareQueueRuntimeClient } from ${JSON.stringify(createImportPath(pluginFile, resolveRuntimeModule("internal/runtime/cloudflare-client")))}`] : []),
    ...(vercelRuntime ? [`import { createVercelQueueRuntimeClient } from ${JSON.stringify(createImportPath(pluginFile, resolveRuntimeModule("internal/runtime/vercel-client")))}`] : []),
    `import { setQueueRuntimeConfig, setQueueRuntimeEventDefaults, setQueueRuntimeRegistry } from ${JSON.stringify(createImportPath(pluginFile, resolveRuntimeModule("internal/runtime/state")))}`,
    `import queueRegistry from ${JSON.stringify(createImportPath(pluginFile, registryFile))}`,
    "",
    ...(vercelRuntime ? ["globalThis.__vitehubVercelQueue = __vitehubVercelQueue", ""] : []),
    `const queueConfig = ${JSON.stringify(queueConfig, null, 2)}`,
    ...(cloudflare ? [`const queueDefinitions = ${JSON.stringify(queueDefinitions, null, 2)}`, "const queueWorker = createQueueCloudflareWorker({ definitions: queueDefinitions, queue: queueConfig, registry: queueRegistry })"] : []),
    "",
    `export default definePlugin((${cloudflare ? "nitro" : ""}) => {`,
    `  setQueueRuntimeConfig(queueConfig${runtimeClientFactory ? `, ${runtimeClientFactory}` : ""})`,
    "  setQueueRuntimeRegistry(queueRegistry)",
    ...(cloudflareRuntime ? ["  setQueueRuntimeEventDefaults({ env: vitehubEnv, waitUntil: vitehubWaitUntil })"] : []),
    ...(cloudflare ? ["  nitro.hooks.hook('cloudflare:queue', ({ batch, context, env }) => queueWorker.queue(batch, env, context))"] : []),
    "})",
    "",
  ].join("\n")
}

function renderNitroMiddleware(middlewareFile: string, queueConfig: NormalizedQueueOptions, hasDefinitions: boolean) {
  const cloudflare = queueConfig !== false && queueConfig.provider === "cloudflare"
  const vercel = hasDefinitions && queueConfig !== false && queueConfig.provider === "vercel"
  return [
    "import { defineMiddleware } from 'nitro'",
    ...(vercel ? [`import { waitUntil as vitehubWaitUntil } from ${JSON.stringify(createImportPath(middlewareFile, resolvePackageDependency("@vercel/functions")))}`] : []),
    ...(cloudflare ? ["import { env as vitehubEnv, waitUntil as vitehubWaitUntil } from 'cloudflare:workers'"] : []),
    `import { enterQueueRuntimeEvent } from ${JSON.stringify(createImportPath(middlewareFile, resolveRuntimeModule("internal/runtime/state")))}`,
    "",
    "export default defineMiddleware((event) => {",
    ...(cloudflare ? ["  const runtimeEvent = event as any"] : []),
    ...(vercel ? ["  Object.assign(event, { waitUntil: vitehubWaitUntil })"] : []),
    ...(cloudflare ? ["  Object.assign(event, { env: runtimeEvent.env ?? runtimeEvent.context?.cloudflare?.env ?? runtimeEvent.context?._platform?.cloudflare?.env ?? runtimeEvent.req?.runtime?.cloudflare?.env ?? runtimeEvent.node?.req?.runtime?.cloudflare?.env ?? vitehubEnv, waitUntil: vitehubWaitUntil })"] : []),
    "  enterQueueRuntimeEvent(event)",
    "})",
    "",
  ].join("\n")
}

export async function writeQueueNitroIntegration(rootDir: string, queue: QueueModuleOptions | undefined, hosting: string, cloudflareQueues = true, definitions: DiscoveredQueueDefinition[] = discoverQueueDefinitions({ rootDir })): Promise<void> {
  const generatedDir = ensureGeneratedDir(rootDir, productName)
  const registryFile = resolve(generatedDir, generatedRegistryFileName)
  const pluginFile = resolve(rootDir, generatedQueueNitroPlugin)
  const middlewareFile = resolve(rootDir, generatedQueueNitroMiddleware)
  const queueConfig = resolveOutputQueueConfig(typeof queue === "undefined" ? {} : queue, hosting)
  const queueDefinitions = cloudflareQueues && queueConfig !== false && queueConfig.provider === "cloudflare"
    ? createCloudflareQueueDefinitionNames(definitions, queueConfig.namePrefix)
    : {}
  await Promise.all([
    mkdir(dirname(pluginFile), { recursive: true }),
    mkdir(generatedDir, { recursive: true }),
  ])
  await Promise.all([
    writeFile(registryFile, createRuntimeRegistryContents(registryFile, definitions), "utf8"),
    writeFile(pluginFile, renderNitroPlugin(pluginFile, registryFile, queueConfig, cloudflareQueues, queueDefinitions), "utf8"),
    writeFile(middlewareFile, renderNitroMiddleware(middlewareFile, queueConfig, definitions.length > 0), "utf8"),
  ])
}

export async function createCloudflareQueueConfig(options: CloudflareQueueConfigOptions = {}): Promise<CloudflareQueueConfig> {
  const rootDir = resolve(process.cwd(), options.rootDir || ".")
  const artifacts = await writeProviderEntries(rootDir, { provider: "cloudflare" })
  const queues = createCloudflareQueueBindings(artifacts.definitions)
  return {
    assets: { run_worker_first: ["/api/*"] },
    compatibility_date: options.compatibilityDate || defaultCloudflareCompatibilityDate,
    compatibility_flags: ["nodejs_compat"],
    main: toGeneratedPath(rootDir, productName, providerEntrySpecs[0]!.entryFile),
    observability: { enabled: true },
    ...(queues ? { queues } : {}),
  }
}

function createProviderRuntimeAliases(
  providerOutput: ComposedProviderOutput | undefined,
  provider: QueueProvider,
  providerImportAliases: Record<string, string> = {},
): Record<string, string> {
  const blobRuntime = getProviderRuntimeModule(providerOutput, "blob", provider)
  return {
    ...providerImportAliases,
    ...(blobRuntime ? { "@vite-hub/blob": blobRuntime } : {}),
  }
}

async function copyVercelRuntimePackages(options: Parameters<typeof import("@vite-hub/internal/build/vercel-runtime-package-copy").copyVercelFunctionRuntimePackageDirectories>[0]) {
  const { copyVercelFunctionRuntimePackageDirectories } = await import("@vite-hub/internal/build/vercel-runtime-package-copy")
  await copyVercelFunctionRuntimePackageDirectories(options)
}

function createCloudflareOutput(
  artifacts: GeneratedQueueArtifacts,
  providerOutput: ComposedProviderOutput | undefined,
  providerImportAliases: Record<string, string> | undefined,
  namePrefix = "",
): CloudflareProviderDeploymentOutput {
  const queues = createCloudflareQueueBindings(artifacts.definitions, namePrefix)

  const wranglerConfig: CloudflareQueueConfig = {
    compatibility_date: defaultCloudflareCompatibilityDate,
    compatibility_flags: ["nodejs_compat"],
    main: "index.js",
    observability: { enabled: true },
    ...(queues ? { queues } : {}),
  }

  return {
    bundleEntry: artifacts.cloudflareWorkerFile,
    bundleOptions: {
      alias: createProviderRuntimeAliases(providerOutput, "cloudflare", providerImportAliases),
      banner: `// ${cloudflareQueueWorkerMarker}`,
      conditions: ["workerd", "worker", "browser", "default"],
      external: ["@vercel/queue", "cloudflare:workers", "node:async_hooks", "node:fs", "node:fs/promises", "node:path", "node:url"],
      format: "esm",
      platform: "neutral",
    },
    wranglerConfigKeys: ["queues"],
    wranglerConfig,
  }
}

function isLegacyCloudflareQueueWorker(contents: string, wrangler: unknown): boolean {
  if (!contents.includes("createQueueCloudflareWorker({")
    || !contents.includes("getCloudflareQueueDefinitionName(batch.queue)")
    || !contents.includes('label: "queue"')
    || contents.includes("cloudflare:queue")) return false
  if (!wrangler || typeof wrangler !== "object" || Array.isArray(wrangler)) return false
  const config = wrangler as Record<string, unknown>
  const observability = config.observability
  return config.main === "index.js"
    && Array.isArray(config.compatibility_flags)
    && config.compatibility_flags.includes("nodejs_compat")
    && Boolean(observability)
    && typeof observability === "object"
    && !Array.isArray(observability)
    && (observability as Record<string, unknown>).enabled === true
}

async function createNitroCloudflareCleanup(rootDir: string, hasCurrentContribution: boolean) {
  const outputRoot = createDefaultCloudflareOutputRoot(rootDir)
  let ownsWorker = false
  let ownsQueues = false
  try {
    const contents = await readFile(resolve(outputRoot, "index.js"), "utf8")
    if (contents.includes(cloudflareQueueWorkerMarker)) {
      ownsWorker = true
    } else {
      const wrangler = JSON.parse(await readFile(resolve(outputRoot, "wrangler.json"), "utf8")) as unknown
      ownsWorker = isLegacyCloudflareQueueWorker(contents, wrangler)
    }
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  try {
    const [state, wrangler] = await Promise.all([
      readFile(resolve(rootDir, cloudflareQueueOutputState), "utf8").then(value => JSON.parse(value) as Record<string, unknown>),
      readFile(resolve(outputRoot, "wrangler.json"), "utf8").then(value => JSON.parse(value) as Record<string, unknown>),
    ])
    ownsQueues = JSON.stringify(state.queues) === JSON.stringify(wrangler.queues)
    await rm(resolve(rootDir, cloudflareQueueOutputState), { force: true })
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  return {
    fileNames: ownsWorker ? ["index.js"] : [],
    outputRoot,
    wranglerConfigOwnership: {
      keys: [
        ...(ownsWorker ? ["compatibility_date", "compatibility_flags", "main", "observability"] : []),
        ...(ownsWorker || (ownsQueues && !hasCurrentContribution) ? ["queues"] : []),
      ],
    },
  }
}

function sanitizeVercelConsumerName(functionPath: string) {
  let result = ""
  for (const char of functionPath) {
    if (char === "_") {
      result += "__"
    } else if (char === "/") {
      result += "_S"
    } else if (char === ".") {
      result += "_D"
    } else if (/[A-Za-z0-9-]/.test(char)) {
      result += char
    } else {
      result += `_${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`
    }
  }
  return result
}

function createVercelQueueWrapperContents(file: string, registryFile: string, name: string, queueConfig: NormalizedQueueOptions) {
  return [
    `import * as __vitehubVercelQueue from ${JSON.stringify(createImportPath(file, resolvePackageDependency("@vercel/queue")))}`,
    `import { H3 } from ${JSON.stringify(createImportPath(file, resolvePackageDependency("h3")))}`,
    `import { toNodeHandler } from ${JSON.stringify(createImportPath(file, resolvePackageDependency("h3/node")))}`,
    `import { createVercelQueueRuntimeClient } from ${JSON.stringify(createImportPath(file, resolveRuntimeModule("internal/runtime/vercel-client")))}`,
    `import { handleHostedVercelQueueCallback, hostedVercelWaitUntil } from ${JSON.stringify(createImportPath(file, resolveRuntimeModule("runtime/hosted")))}`,
    `import { loadQueueDefinition, runWithQueueRuntimeEvent, setQueueRuntimeConfig, setQueueRuntimeRegistry } from ${JSON.stringify(createImportPath(file, resolveRuntimeModule("internal/runtime/state")))}`,
    `import queueRegistry from ${JSON.stringify(createImportPath(file, registryFile))}`,
    "",
    "globalThis.__vitehubVercelQueue = __vitehubVercelQueue",
    "",
    `setQueueRuntimeConfig(${JSON.stringify(queueConfig, null, 2)}, createVercelQueueRuntimeClient)`,
    "setQueueRuntimeRegistry(queueRegistry)",
    "",
    "const app = new H3()",
    "app.use(async (event) => {",
    `  const definition = await loadQueueDefinition(${JSON.stringify(name)})`,
    "  if (!definition) {",
    "    throw new Error('Missing queue definition.')",
    "  }",
    `  return await handleHostedVercelQueueCallback(event, ${JSON.stringify(name)}, definition)`,
    "})",
    "",
    "const handler = toNodeHandler(app)",
    "export default function queueHandler(req, res) {",
    "  return runWithQueueRuntimeEvent({ req, res, waitUntil: hostedVercelWaitUntil }, () => handler(req, res))",
    "}",
    "",
  ].join("\n")
}

function createVercelOutput(
  artifacts: GeneratedQueueArtifacts,
  providerOutput: ComposedProviderOutput | undefined,
  providerImportAliases: Record<string, string> | undefined,
  serverFunctionName?: string,
): VercelProviderDeploymentOutput {
  return {
    bundleEntry: artifacts.vercelServerFile,
    bundleOptions: {
      alias: createProviderRuntimeAliases(providerOutput, "vercel", providerImportAliases),
      format: "esm",
      platform: "node",
    },
    ...(serverFunctionName ? { function: { kind: "isolated" as const, name: serverFunctionName } } : {}),
  }
}

interface VercelQueueOutputState {
  digest: string
  serverFunctionName: string
}

async function readVercelQueueOutputState(rootDir: string): Promise<VercelQueueOutputState | undefined> {
  try {
    const state = JSON.parse(await readFile(resolve(rootDir, vercelQueueOutputState), "utf8")) as Partial<VercelQueueOutputState>
    return typeof state.serverFunctionName === "string" && /^[^/\\]+\.func$/.test(state.serverFunctionName)
      && typeof state.digest === "string" && /^[0-9a-f]{64}$/.test(state.digest)
      ? { digest: state.digest, serverFunctionName: state.serverFunctionName }
      : undefined
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

async function isVercelQueueFunctionOwned(rootDir: string, serverFunctionName: string, state?: VercelQueueOutputState): Promise<boolean> {
  try {
    const functionRoot = resolve(createDefaultVercelOutputRoot(rootDir), "functions", serverFunctionName)
    const contents = await readFile(resolve(functionRoot, "index.mjs"))
    const digest = hash("sha256", contents, "hex")
    if (state?.serverFunctionName === serverFunctionName && state.digest === digest) return true
    const marker = JSON.parse(await readFile(resolve(functionRoot, vercelQueueFunctionMarker), "utf8")) as { digest?: unknown }
    return marker.digest === digest
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

async function writeVercelQueueFunctions(
  rootDir: string,
  queue: QueueModuleOptions | undefined,
  artifacts: GeneratedQueueArtifacts,
  providerOutput: ComposedProviderOutput | undefined,
  providerImportAliases: Record<string, string> | undefined,
) {
  const outputRoot = createDefaultVercelOutputRoot(rootDir)
  const queueRoot = resolve(outputRoot, "functions", "api", "vitehub", "queues", "vercel")
  const queueConfig = resolveOutputQueueConfig(queue, "vercel")

  await rm(queueRoot, { force: true, recursive: true })
  if (!isVercelQueueEnabled(queueConfig)) {
    return
  }

  const functionDirs = new Map<string, DiscoveredQueueDefinition>()
  for (const definition of artifacts.definitions) {
    const safeName = definition.name.replace(/[^a-z0-9/_-]+/gi, "_")
    const segments = safeName.split("/")
    const functionDirKey = [...segments, `${segments.at(-1)}.func`].join("/")
    const existing = functionDirs.get(functionDirKey)
    if (existing) {
      throw new Error(`Queue names "${existing.name}" and "${definition.name}" collide after Vercel output sanitization:\n  - ${existing.handler}\n  - ${definition.handler}\nResolved output path: ${functionDirKey}`)
    }
    functionDirs.set(functionDirKey, definition)
    const functionDir = resolve(queueRoot, ...segments, `${segments.at(-1)}.func`)
    const functionFile = resolve(functionDir, "index.mjs")
    const wrapperFile = resolve(functionDir, "index.source.mjs")
    const functionPath = relative(resolve(outputRoot, "functions"), functionDir).replace(/\\/g, "/")
    const consumer = sanitizeVercelConsumerName(functionPath)
    await mkdir(functionDir, { recursive: true })
    await writeFile(wrapperFile, createVercelQueueWrapperContents(wrapperFile, artifacts.registryFile, definition.name, queueConfig), "utf8")
    await bundleEsmEntry(wrapperFile, functionFile, {
      alias: createProviderRuntimeAliases(providerOutput, "vercel", providerImportAliases),
      format: "esm",
      platform: "node",
      rootDir,
    })
    await copyVercelRuntimePackages({
      outputRoot,
      packages: getVercelRuntimePackages(providerOutput, "blob"),
      rootDir,
      serverFunctionName: functionPath,
    })
    await rm(wrapperFile, { force: true })
    await writeFile(resolve(functionDir, ".vc-config.json"), `${JSON.stringify(createNodeFunctionConfig({
      experimentalTriggers: [{
        consumer,
        topic: getVercelQueueTopicName(definition.name),
        type: "queue/v2beta",
      }],
    }), null, 2)}\n`, "utf8")
  }
}

export async function generateProviderOutputs(options: GenerateProviderOutputsOptions): Promise<GeneratedQueueArtifacts> {
  const artifacts = await writeProviderEntries(options.rootDir, options.queue, options.definitions)
  const cloudflareQueueConfig = resolveOutputQueueConfig(options.queue, "cloudflare")
  const usesCloudflare = cloudflareQueueConfig !== false && cloudflareQueueConfig.provider === "cloudflare"
  const cloudflareNamePrefix = cloudflareQueueConfig !== false && cloudflareQueueConfig.provider === "cloudflare" ? cloudflareQueueConfig.namePrefix : undefined
  const createCloudflare = !options.cloudflareOwnedByNitro && usesCloudflare
  const createVercel = shouldCreateVercelOutput(options.queue)
  const vercelFunctionName = options.serverFunctionName ?? "__server.func"
  if (!createCloudflare) {
    await writeProviderDeploymentOutputs({
      clientOutDir: options.clientOutDir,
      cleanup: {
        cloudflare: options.cloudflareOwnedByNitro
          ? () => createNitroCloudflareCleanup(options.rootDir, usesCloudflare && artifacts.definitions.length > 0)
          : { wranglerConfigOwnership: { keys: ["queues"] } },
      },
      rootDir: options.rootDir,
    })
  }
  // Verify and update Queue ownership under the shared provider-output lock.
  await writeProviderDeploymentOutputs({
    afterWrite: async () => {
      const previousVercelOutput = await readVercelQueueOutputState(options.rootDir)
      const vercelFunctionCandidates = new Set(["__server.func", "__queue.func"])
      if (previousVercelOutput) vercelFunctionCandidates.add(previousVercelOutput.serverFunctionName)
      const ownedVercelFunctions: string[] = []
      for (const serverFunctionName of vercelFunctionCandidates) {
        if (await isVercelQueueFunctionOwned(options.rootDir, serverFunctionName, previousVercelOutput)) {
          ownedVercelFunctions.push(serverFunctionName)
        }
      }
      await Promise.all(ownedVercelFunctions
        .filter(serverFunctionName => !createVercel || serverFunctionName !== vercelFunctionName)
        .map(serverFunctionName => rm(resolve(createDefaultVercelOutputRoot(options.rootDir), "functions", serverFunctionName), { force: true, recursive: true })))
      if (createVercel) {
        const functionRoot = resolve(createDefaultVercelOutputRoot(options.rootDir), "functions", vercelFunctionName)
        await copyVercelRuntimePackages({
          packages: getVercelRuntimePackages(options.providerOutput, "blob"),
          rootDir: options.rootDir,
          serverFunctionName: vercelFunctionName,
        })
        const contents = await readFile(resolve(functionRoot, "index.mjs"))
        const digest = hash("sha256", contents, "hex")
        await writeFile(resolve(functionRoot, vercelQueueFunctionMarker), `${JSON.stringify({ digest }, null, 2)}\n`, "utf8")
        await mkdir(dirname(resolve(options.rootDir, vercelQueueOutputState)), { recursive: true })
        await writeFile(resolve(options.rootDir, vercelQueueOutputState), `${JSON.stringify({
          digest,
          serverFunctionName: vercelFunctionName,
        }, null, 2)}\n`, "utf8")
      }
      else {
        await rm(resolve(options.rootDir, vercelQueueOutputState), { force: true })
      }
    },
    clientOutDir: options.clientOutDir,
    cloudflare: createCloudflare ? createCloudflareOutput(artifacts, options.providerOutput, options.providerImportAliases, cloudflareNamePrefix) : undefined,
    rootDir: options.rootDir,
    vercel: createVercel ? createVercelOutput(artifacts, options.providerOutput, options.providerImportAliases, options.serverFunctionName) : undefined,
  })
  if (createCloudflare) {
    const queues = createCloudflareQueueBindings(artifacts.definitions, cloudflareNamePrefix)
    await mkdir(dirname(resolve(options.rootDir, cloudflareQueueOutputState)), { recursive: true })
    await writeFile(resolve(options.rootDir, cloudflareQueueOutputState), `${JSON.stringify({ queues }, null, 2)}\n`, "utf8")
  }
  else {
    await rm(resolve(options.rootDir, cloudflareQueueOutputState), { force: true })
  }
  await writeVercelQueueFunctions(options.rootDir, options.queue, artifacts, options.providerOutput, options.providerImportAliases)
  return artifacts
}
