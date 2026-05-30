import { mkdir, rm, writeFile } from "node:fs/promises"
import { relative, resolve } from "node:path"

import { defaultCloudflareCompatibilityDate } from "@vite-hub/internal/build/cloudflare"
import { createDefaultVercelOutputRoot, writeProviderDeploymentOutputs } from "@vite-hub/internal/build/deployment-output"
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
const productName = "queue"

const generatedRegistryFileName = "registry.mjs"
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

interface GeneratedQueueArtifacts {
  cloudflareWorkerFile: string
  definitions: DiscoveredQueueDefinition[]
  generatedDir: string
  registryFile: string
  vercelServerFile: string
}

interface GenerateProviderOutputsOptions {
  clientOutDir: string
  queue: QueueModuleOptions | undefined
  rootDir: string
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

function renderProviderEntry(spec: ProviderEntrySpec, entryFile: string, registryFile: string, userAppEntry: string | undefined, queueConfig: unknown) {
  const imports = [
    `import { ${spec.factory} } from ${JSON.stringify(createImportPath(entryFile, resolveRuntimeModule(spec.runtimeModule)))}`,
    `import queueRegistry from ${JSON.stringify(`./${generatedRegistryFileName}`)}`,
  ]
  if (spec.name === "vercel") {
    imports.unshift("import * as __vitehubVercelQueue from '@vercel/queue'")
  }
  if (userAppEntry) {
    imports.push(`import queueApp from ${JSON.stringify(createImportPath(entryFile, userAppEntry))}`)
  }

  return [
    ...imports,
    "",
    spec.name === "vercel" ? "globalThis.__vitehubVercelQueue = __vitehubVercelQueue" : "",
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

async function writeProviderEntries(rootDir: string, queue: QueueModuleOptions | undefined) {
  const generatedDir = ensureGeneratedDir(rootDir, productName)
  await mkdir(generatedDir, { recursive: true })

  const registryFile = resolve(generatedDir, generatedRegistryFileName)
  const definitions = discoverQueueDefinitions({ rootDir })
  const userAppEntry = resolveUserAppEntry(rootDir)

  await writeFile(registryFile, createRuntimeRegistryContents(registryFile, definitions), "utf8")

  const entryFiles: Record<QueueProvider, string> = { cloudflare: "", vercel: "" }
  for (const spec of providerEntrySpecs) {
    const entryFile = resolve(generatedDir, spec.entryFile)
    const queueConfig = normalizeQueueOptions(queue, { hosting: spec.hosting }) || false
    await writeFile(entryFile, renderProviderEntry(spec, entryFile, registryFile, userAppEntry, queueConfig), "utf8")
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

function createCloudflareQueueBindings(definitions: DiscoveredQueueDefinition[]) {
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

export async function createCloudflareQueueConfig(options: CloudflareQueueConfigOptions = {}): Promise<CloudflareQueueConfig> {
  const rootDir = resolve(process.cwd(), options.rootDir || ".")
  const artifacts = await writeProviderEntries(rootDir, undefined)
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
      conditions: ["workerd", "worker", "browser", "default"],
      external: ["@vercel/queue", "node:async_hooks", "node:fs", "node:fs/promises", "node:path", "node:url"],
      format: "esm",
      platform: "neutral",
    },
    wranglerConfigKeys: ["queues"],
    wranglerConfig,
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

function createVercelQueueWrapperContents(file: string, registryFile: string, name: string, queueConfig: false | ReturnType<typeof normalizeQueueOptions>) {
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

function createVercelOutput(artifacts: GeneratedQueueArtifacts): VercelProviderDeploymentOutput {
  return {
    bundleEntry: artifacts.vercelServerFile,
    bundleOptions: {
      format: "esm",
      platform: "node",
    },
  }
}

async function writeVercelQueueFunctions(rootDir: string, queue: QueueModuleOptions | undefined, artifacts: GeneratedQueueArtifacts) {
  const outputRoot = createDefaultVercelOutputRoot(rootDir)
  const queueRoot = resolve(outputRoot, "functions", "api", "vitehub", "queues", "vercel")
  const queueConfig = normalizeQueueOptions(queue, { hosting: "vercel" }) || false

  await rm(queueRoot, { force: true, recursive: true })
  if (queueConfig === false) {
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
  const artifacts = await writeProviderEntries(options.rootDir, options.queue)
  await writeProviderDeploymentOutputs({
    clientOutDir: options.clientOutDir,
    cloudflare: createCloudflareOutput(artifacts),
    rootDir: options.rootDir,
    vercel: createVercelOutput(artifacts),
  })
  await writeVercelQueueFunctions(options.rootDir, options.queue, artifacts)
  return artifacts
}
