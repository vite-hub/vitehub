import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, relative, resolve } from "node:path"

import { defaultCloudflareCompatibilityDate } from "@vite-hub/internal/build/cloudflare"
import { createDefaultCloudflareOutputRoot, createDefaultVercelOutputRoot, writeProviderDeploymentOutputs } from "@vite-hub/internal/build/deployment-output"
import { bundleEsmEntry } from "@vite-hub/internal/build/esbuild"
import { computePackageDir, createImportPath, ensureGeneratedDir, resolveRuntimeModule as resolveRuntimeFromPkg, toGeneratedPath } from "@vite-hub/internal/build/paths"
import { resolveUserAppEntry } from "@vite-hub/internal/build/user-entry"
import { createNodeFunctionConfig } from "@vite-hub/internal/build/vercel-config"
import { createRuntimeRegistryContents } from "@vite-hub/internal/definition-catalog"

import { normalizeQueueOptions } from "../config.ts"
import { discoverQueueDefinitions } from "../discovery.ts"
import { getCloudflareQueueBindingName, getCloudflareQueueName } from "../integrations/cloudflare.ts"
import { getVercelQueueTopicName } from "../integrations/vercel.ts"

import type { DiscoveredQueueDefinition, QueueModuleOptions, QueueProvider } from "../types.ts"
import type { CloudflareProviderDeploymentOutput, VercelProviderDeploymentOutput } from "@vite-hub/internal/build/deployment-output"

export const queuePackageName = "@vite-hub/queue"
const cloudflareQueueWorkerMarker = "vitehub-queue-worker"
const cloudflareQueueOutputState = ".vitehub/queue/cloudflare-output.json"
const productName = "queue"

const generatedRegistryFileName = "registry.mjs"
export const generatedQueueNitroPlugin = ".vitehub/nitro/queue/plugin.ts"
const packageDir = computePackageDir(import.meta.url)
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
  { name: "cloudflare", entryFile: "cloudflare-worker.mjs", runtimeModule: "runtime/cloudflare-vite", factory: "createQueueCloudflareWorker", hosting: "cloudflare" },
  { name: "vercel", entryFile: "vercel-server.mjs", runtimeModule: "runtime/vercel-vite", factory: "createQueueVercelServer", hosting: "vercel" },
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

function shouldCreateCloudflareOutput(queue: QueueModuleOptions | undefined) {
  const queueConfig = resolveOutputQueueConfig(queue, "cloudflare")
  return queueConfig !== false && queueConfig.provider === "cloudflare"
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

function renderProviderEntry(spec: ProviderEntrySpec, entryFile: string, registryFile: string, userAppEntry: string | undefined, queueConfig: unknown, preloadVercelQueue = false) {
  const imports = [
    `import { ${spec.factory} } from ${JSON.stringify(createImportPath(entryFile, resolveRuntimeModule(spec.runtimeModule)))}`,
    `import queueRegistry from ${JSON.stringify(`./${generatedRegistryFileName}`)}`,
  ]
  if (preloadVercelQueue) {
    imports.unshift("import * as __vitehubVercelQueue from '@vercel/queue'")
  }
  if (userAppEntry) {
    imports.push(`import queueApp from ${JSON.stringify(createImportPath(entryFile, userAppEntry))}`)
  }

  return [
    ...imports,
    preloadVercelQueue ? "globalThis.__vitehubVercelQueue = __vitehubVercelQueue" : "",
    "",
    `const queueConfig = ${JSON.stringify(queueConfig, null, 2)}`,
    "",
    `export default ${spec.factory}({`,
    userAppEntry ? "  app: queueApp," : "",
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
    const preloadVercelQueue = spec.name === "vercel" && definitions.length > 0 && isVercelQueueEnabled(queueConfig)
    await writeFile(entryFile, renderProviderEntry(spec, entryFile, registryFile, userAppEntry, queueConfig, preloadVercelQueue), "utf8")
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

export function createCloudflareQueueBindings(definitions: DiscoveredQueueDefinition[]): CloudflareQueueConfig["queues"] {
  if (!definitions.length) {
    return undefined
  }

  return {
    consumers: definitions.map(definition => ({ queue: getCloudflareQueueName(definition.name) })),
    producers: definitions.map(definition => ({
      binding: getCloudflareQueueBindingName(definition.name),
      queue: getCloudflareQueueName(definition.name),
    })),
  }
}

function renderNitroPlugin(pluginFile: string, registryFile: string, queueConfig: NormalizedQueueOptions, hasDefinitions: boolean, cloudflareQueues: boolean) {
  const cloudflare = cloudflareQueues && queueConfig !== false && queueConfig.provider === "cloudflare"
  const vercel = hasDefinitions && queueConfig !== false && queueConfig.provider === "vercel"
  return [
    "import { definePlugin } from 'nitro'",
    ...(vercel ? ["import { waitUntil as vitehubWaitUntil } from '@vercel/functions'", "import * as __vitehubVercelQueue from '@vercel/queue'"] : []),
    ...(cloudflare ? ["import { env as vitehubEnv, waitUntil as vitehubWaitUntil } from 'cloudflare:workers'", "import { createQueueCloudflareWorker } from '@vite-hub/queue/runtime/cloudflare-vite'"] : []),
    "import { enterQueueRuntimeEvent, setQueueRuntimeConfig, setQueueRuntimeEventDefaults, setQueueRuntimeRegistry } from '@vite-hub/queue/runtime/state'",
    `import queueRegistry from ${JSON.stringify(createImportPath(pluginFile, registryFile))}`,
    "",
    ...(vercel ? ["globalThis.__vitehubVercelQueue = __vitehubVercelQueue", ""] : []),
    `const queueConfig = ${JSON.stringify(queueConfig, null, 2)}`,
    ...(cloudflare ? ["const queueWorker = createQueueCloudflareWorker({ queue: queueConfig, registry: queueRegistry })"] : []),
    "",
    "export default definePlugin((nitro) => {",
    "  setQueueRuntimeConfig(queueConfig)",
    "  setQueueRuntimeRegistry(queueRegistry)",
    ...(cloudflare ? ["  setQueueRuntimeEventDefaults({ env: vitehubEnv, waitUntil: vitehubWaitUntil })"] : []),
    ...(vercel
      ? ["  nitro.hooks.hook('request', (event) => enterQueueRuntimeEvent(Object.assign(event, { waitUntil: vitehubWaitUntil })))"]
      : cloudflare
        ? ["  nitro.hooks.hook('request', (event) => enterQueueRuntimeEvent(Object.assign(event, { env: event.env ?? event.context?.cloudflare?.env ?? event.context?._platform?.cloudflare?.env ?? event.req?.runtime?.cloudflare?.env ?? event.node?.req?.runtime?.cloudflare?.env ?? vitehubEnv, waitUntil: vitehubWaitUntil })))"]
        : ["  nitro.hooks.hook('request', (event) => enterQueueRuntimeEvent(event))"]),
    ...(cloudflare ? ["  nitro.hooks.hook('cloudflare:queue', ({ batch, context, env }) => queueWorker.queue(batch, env, context))"] : []),
    "})",
    "",
  ].join("\n")
}

export async function writeQueueNitroIntegration(rootDir: string, queue: QueueModuleOptions | undefined, hosting: string, cloudflareQueues = true, definitions: DiscoveredQueueDefinition[] = discoverQueueDefinitions({ rootDir })): Promise<void> {
  const generatedDir = ensureGeneratedDir(rootDir, productName)
  const registryFile = resolve(generatedDir, generatedRegistryFileName)
  const pluginFile = resolve(rootDir, generatedQueueNitroPlugin)
  const queueConfig = resolveOutputQueueConfig(typeof queue === "undefined" ? {} : queue, hosting)
  await Promise.all([
    mkdir(dirname(pluginFile), { recursive: true }),
    mkdir(generatedDir, { recursive: true }),
  ])
  await Promise.all([
    writeFile(registryFile, createRuntimeRegistryContents(registryFile, definitions), "utf8"),
    writeFile(pluginFile, renderNitroPlugin(pluginFile, registryFile, queueConfig, definitions.length > 0, cloudflareQueues), "utf8"),
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

function createCloudflareOutput(artifacts: GeneratedQueueArtifacts): CloudflareProviderDeploymentOutput {
  const queues = createCloudflareQueueBindings(artifacts.definitions)

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
      banner: `// ${cloudflareQueueWorkerMarker}`,
      conditions: ["workerd", "worker", "browser", "default"],
      external: ["@vercel/queue", "node:async_hooks", "node:fs", "node:fs/promises", "node:path", "node:url"],
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
    "import * as __vitehubVercelQueue from '@vercel/queue'",
    "import { H3 } from 'h3'",
    "import { toNodeHandler } from 'h3/node'",
    `import { handleHostedVercelQueueCallback, hostedVercelWaitUntil } from ${JSON.stringify(createImportPath(file, resolveRuntimeModule("runtime/hosted")))}`,
    `import { loadQueueDefinition, runWithQueueRuntimeEvent, setQueueRuntimeConfig, setQueueRuntimeRegistry } from ${JSON.stringify(createImportPath(file, resolveRuntimeModule("runtime/state")))}`,
    `import queueRegistry from ${JSON.stringify(createImportPath(file, registryFile))}`,
    "",
    "globalThis.__vitehubVercelQueue = __vitehubVercelQueue",
    "",
    `setQueueRuntimeConfig(${JSON.stringify(queueConfig, null, 2)})`,
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

function createVercelOutput(artifacts: GeneratedQueueArtifacts, serverFunctionName?: string): VercelProviderDeploymentOutput {
  return {
    bundleEntry: artifacts.vercelServerFile,
    bundleOptions: {
      format: "esm",
      platform: "node",
    },
    ...(serverFunctionName ? { function: { kind: "isolated" as const, name: serverFunctionName } } : {}),
  }
}

async function writeVercelQueueFunctions(rootDir: string, queue: QueueModuleOptions | undefined, artifacts: GeneratedQueueArtifacts) {
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
      format: "esm",
      platform: "node",
      rootDir,
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
  const usesCloudflare = shouldCreateCloudflareOutput(options.queue)
  const createCloudflare = !options.cloudflareOwnedByNitro && usesCloudflare
  const createVercel = shouldCreateVercelOutput(options.queue)
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
  await writeProviderDeploymentOutputs({
    clientOutDir: options.clientOutDir,
    cloudflare: createCloudflare ? createCloudflareOutput(artifacts) : undefined,
    cleanup: {
      vercel: { serverFunctionName: options.serverFunctionName ?? "__server.func" },
    },
    rootDir: options.rootDir,
    vercel: createVercel ? createVercelOutput(artifacts, options.serverFunctionName) : undefined,
  })
  if (createCloudflare) {
    const queues = createCloudflareQueueBindings(artifacts.definitions)
    await mkdir(dirname(resolve(options.rootDir, cloudflareQueueOutputState)), { recursive: true })
    await writeFile(resolve(options.rootDir, cloudflareQueueOutputState), `${JSON.stringify({ queues }, null, 2)}\n`, "utf8")
  }
  await writeVercelQueueFunctions(options.rootDir, options.queue, artifacts)
  return artifacts
}
