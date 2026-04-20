import { existsSync } from "node:fs"
import { cp, mkdir, rm, writeFile } from "node:fs/promises"
import { basename, dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { build as bundle } from "esbuild"

import { normalizeQueueOptions } from "../config.ts"
import { createQueueRegistryContents, discoverQueueDefinitions } from "../discovery.ts"
import { getCloudflareQueueBindingName, getCloudflareQueueName } from "../integrations/cloudflare.ts"
import { getVercelQueueTopicName } from "../integrations/vercel.ts"

import type { DiscoveredQueueDefinition, QueueModuleOptions, QueueProvider } from "../types.ts"

export const queuePackageName = "@vitehub/queue"
const defaultCompatibilityDate = "2026-04-20"
const generatedDirSegments = [".vitehub", "queue"] as const

const generatedRegistryFileName = "registry.mjs"
const userAppEntryCandidates = ["server.ts", "server.mts", "server.js", "server.mjs", "worker.ts", "worker.mts", "worker.js", "worker.mjs"].map(name => resolve("src", name))
const currentFileDir = dirname(fileURLToPath(import.meta.url))
const packageDir = resolve(currentFileDir, basename(currentFileDir) === "internal" ? "../.." : "..")

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

function ensureGeneratedDir(rootDir: string) {
  return resolve(rootDir, ...generatedDirSegments)
}

function createImportPath(fromFile: string, targetFile: string) {
  const importPath = relative(dirname(fromFile), targetFile).replace(/\\/g, "/")
  return importPath.startsWith(".") ? importPath : `./${importPath}`
}

function resolveUserAppEntry(rootDir: string) {
  return userAppEntryCandidates.map(candidate => resolve(rootDir, candidate)).find(existsSync)
}

function toGeneratedWorkerPath(rootDir: string, filename: string) {
  return relative(rootDir, resolve(rootDir, ...generatedDirSegments, filename)).replace(/\\/g, "/")
}

function toSafeAppName(rootDir: string) {
  return basename(rootDir).replace(/[^a-z0-9-]+/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase()
}

function hasStaticIndex(clientDir: string) {
  return existsSync(resolve(clientDir, "index.html"))
}

function resolveRuntimeModule(modulePath: string) {
  const distFile = resolve(packageDir, "dist", `${modulePath}.js`)
  return existsSync(distFile) ? distFile : resolve(packageDir, "src", `${modulePath}.ts`)
}

function renderProviderEntry(spec: ProviderEntrySpec, entryFile: string, registryFile: string, userAppEntry: string | undefined, queueConfig: unknown) {
  const imports = [
    `import { ${spec.factory} } from ${JSON.stringify(createImportPath(entryFile, resolveRuntimeModule(spec.runtimeModule)))}`,
    `import queueRegistry from ${JSON.stringify(`./${generatedRegistryFileName}`)}`,
  ]
  if (userAppEntry) {
    imports.push(`import queueApp from ${JSON.stringify(createImportPath(entryFile, userAppEntry))}`)
  }

  return [
    ...imports,
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

async function writeProviderEntries(rootDir: string, queue: QueueModuleOptions | undefined) {
  const generatedDir = ensureGeneratedDir(rootDir)
  await mkdir(generatedDir, { recursive: true })

  const registryFile = resolve(generatedDir, generatedRegistryFileName)
  const definitions = discoverQueueDefinitions({ rootDir })
  const userAppEntry = resolveUserAppEntry(rootDir)

  await writeFile(registryFile, createQueueRegistryContents(registryFile, definitions), "utf8")

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

async function bundleEsmEntry(entryFile: string, outfile: string, options: { conditions?: string[], external?: string[], format?: "esm" | "cjs", platform?: "browser" | "node" | "neutral" } = {}) {
  const format = options.format || "esm"
  const platform = options.platform || "neutral"
  await bundle({
    banner: format === "esm" && platform === "node"
      ? {
          js: 'import { createRequire as __createRequire } from "node:module";\nvar require = __createRequire(import.meta.url);\n',
        }
      : undefined,
    bundle: true,
    conditions: options.conditions,
    entryPoints: [entryFile],
    external: options.external,
    format,
    logLevel: "silent",
    outfile,
    platform,
    sourcemap: false,
    target: "es2022",
    write: true,
  })
}

async function copyClientOutput(clientDir: string, targetDir: string) {
  if (resolve(clientDir) === resolve(targetDir)) {
    return
  }

  await rm(targetDir, { force: true, recursive: true })
  await mkdir(dirname(targetDir), { recursive: true })
  await cp(clientDir, targetDir, { recursive: true })
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
    compatibility_date: options.compatibilityDate || defaultCompatibilityDate,
    compatibility_flags: ["nodejs_compat"],
    main: toGeneratedWorkerPath(rootDir, providerEntrySpecs[0]!.entryFile),
    observability: { enabled: true },
    ...(queues ? { queues } : {}),
  }
}

async function writeCloudflareOutput(rootDir: string, clientOutDir: string, artifacts: GeneratedQueueArtifacts) {
  const clientDir = resolve(rootDir, clientOutDir)
  const outputRoot = resolve(rootDir, "dist", toSafeAppName(rootDir))
  const workerOutfile = resolve(outputRoot, "index.js")
  const staticIndex = hasStaticIndex(clientDir)
  const queues = createCloudflareQueueBindings(artifacts.definitions)

  await rm(outputRoot, { force: true, recursive: true })
  await mkdir(outputRoot, { recursive: true })

  await bundleEsmEntry(artifacts.cloudflareWorkerFile, workerOutfile, {
    conditions: ["workerd", "worker", "browser", "default"],
    external: ["@vercel/queue", "node:async_hooks"],
    format: "esm",
    platform: "neutral",
  })

  const wranglerConfig: CloudflareQueueConfig = {
    compatibility_date: defaultCompatibilityDate,
    compatibility_flags: ["nodejs_compat"],
    main: "index.js",
    name: toSafeAppName(rootDir),
    observability: { enabled: true },
    ...(staticIndex ? { assets: { directory: "../client", run_worker_first: ["/api/*"] } } : {}),
    ...(queues ? { queues } : {}),
  }

  await writeFile(resolve(outputRoot, "wrangler.json"), `${JSON.stringify(wranglerConfig, null, 2)}\n`, "utf8")

  if (staticIndex) {
    await copyClientOutput(clientDir, resolve(rootDir, "dist", "client"))
  }
}

function createVercelConfigJson() {
  return {
    version: 3,
    routes: [
      { handle: "filesystem" },
      { src: "/(.*)", dest: "/__server" },
    ],
  }
}

function createNodeFunctionConfig(extra: Record<string, unknown> = {}) {
  return {
    handler: "index.mjs",
    launcherType: "Nodejs",
    runtime: "nodejs24.x",
    shouldAddHelpers: false,
    supportsResponseStreaming: true,
    ...extra,
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
    "import { H3 } from 'h3'",
    "import { toNodeHandler } from 'h3/node'",
    `import { handleHostedVercelQueueCallback } from ${JSON.stringify(createImportPath(file, resolveRuntimeModule("runtime/hosted")))}`,
    `import { loadQueueDefinition, runWithQueueRuntimeEvent, setQueueRuntimeConfig, setQueueRuntimeRegistry } from ${JSON.stringify(createImportPath(file, resolveRuntimeModule("runtime/state")))}`,
    `import queueRegistry from ${JSON.stringify(createImportPath(file, registryFile))}`,
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
    "  return runWithQueueRuntimeEvent({ req, res }, () => handler(req, res))",
    "}",
    "",
  ].join("\n")
}

async function writeVercelOutput(rootDir: string, clientOutDir: string, queue: QueueModuleOptions | undefined, artifacts: GeneratedQueueArtifacts) {
  const clientDir = resolve(rootDir, clientOutDir)
  const outputRoot = resolve(rootDir, ".vercel", "output")
  const serverDir = resolve(outputRoot, "functions", "__server.func")
  const serverEntry = resolve(serverDir, "index.mjs")
  const queueRoot = resolve(outputRoot, "functions", "api", "vitehub", "queues", "vercel")
  const staticIndex = hasStaticIndex(clientDir)
  const queueConfig = normalizeQueueOptions(queue, { hosting: "vercel" }) || false

  await rm(outputRoot, { force: true, recursive: true })
  await mkdir(serverDir, { recursive: true })

  await bundleEsmEntry(artifacts.vercelServerFile, serverEntry, {
    format: "esm",
    platform: "node",
  })

  await writeFile(resolve(serverDir, ".vc-config.json"), `${JSON.stringify(createNodeFunctionConfig(), null, 2)}\n`, "utf8")
  await writeFile(resolve(outputRoot, "config.json"), `${JSON.stringify(createVercelConfigJson(), null, 2)}\n`, "utf8")

  if (staticIndex) {
    await copyClientOutput(clientDir, resolve(outputRoot, "static"))
  }

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
  await writeCloudflareOutput(options.rootDir, options.clientOutDir, artifacts)
  await writeVercelOutput(options.rootDir, options.clientOutDir, options.queue, artifacts)
  return artifacts
}
