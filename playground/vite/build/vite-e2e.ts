import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { normalizeBlobOptions } from "../../../packages/blob/src/config.ts"
import { resolveDBViteConfig } from "../../../packages/db/src/config.ts"
import { serializeSchemaObject } from "../../../packages/db/src/internal/schema-serializer.ts"
import { configureCloudflareKV } from "../../../packages/kv/src/integrations/cloudflare.ts"
import { normalizeKVOptions } from "../../../packages/kv/src/config.ts"
import { normalizeQueueOptions } from "../../../packages/queue/src/config.ts"
import { discoverQueueDefinitions } from "../../../packages/queue/src/discovery.ts"
import { getCloudflareQueueBindingName, getCloudflareQueueName } from "../../../packages/queue/src/integrations/cloudflare.ts"
import { getVercelQueueTopicName } from "../../../packages/queue/src/integrations/vercel.ts"
import { discoverScheduleDefinitions } from "../../../packages/schedule/src/discovery.ts"
import { getVercelSchedulePath } from "../../../packages/schedule/src/integrations/vercel.ts"
import { readDefinitionCrons } from "../../../packages/schedule/src/internal/provider-output.ts"
import { defaultCloudflareSandboxBinding, defaultCloudflareSandboxClassName, defaultCloudflareSandboxMigrationTag, configureCloudflareSandbox, writeCloudflareSandboxDockerfile } from "../../../packages/sandbox/src/cloudflare.ts"
import { extractSandboxDefinitionOptions } from "../../../packages/sandbox/src/definition-options.ts"
import { discoverNitroSandboxDefinitions } from "../../../packages/sandbox/src/discovery.ts"
import { bundleSandboxDefinition } from "../../../packages/sandbox/src/bundle.ts"
import { resolveSandboxFeatureConfig } from "../../../packages/sandbox/src/feature.ts"
import { finalizeCloudflareWranglerConfig } from "../../../packages/sandbox/src/internal/shared/cloudflare-wrangler.ts"
import { normalizeWorkspaceOptions } from "../../../packages/workspace/src/config.ts"
import { discoverViteWorkspaceDefinitions } from "../../../packages/workspace/src/build/discovery.ts"
import { configureCloudflareArtifacts } from "../../../packages/workspace/src/integrations/cloudflare.ts"
import { normalizeWorkflowOptions } from "../../../packages/workflow/src/config.ts"
import { discoverWorkflowDefinitions } from "../../../packages/workflow/src/discovery.ts"
import { createCloudflareWorkflowBindings, getCloudflareWorkflowClassName } from "../../../packages/workflow/src/integrations/cloudflare.ts"
import { defaultCloudflareCompatibilityDate } from "@vitehub/internal/build/cloudflare"
import { copyClientOutput, hasStaticIndex } from "@vitehub/internal/build/client-output"
import { bundleEsmEntry } from "@vitehub/internal/build/esbuild"
import { createImportPath, ensureGeneratedDir } from "@vitehub/internal/build/paths"
import { toSafeAppName } from "@vitehub/internal/build/user-entry"
import { createNodeFunctionConfig, createVercelConfigJson } from "@vitehub/internal/build/vercel-config"
import { createRuntimeRegistryContents } from "@vitehub/internal/definition-discovery"

import type { ResolvedBlobModuleOptions } from "../../../packages/blob/src/types.ts"
import type { ResolvedDBViteConfig } from "../../../packages/db/src/types.ts"
import type { ResolvedKVModuleOptions } from "../../../packages/kv/src/types.ts"
import type { ResolvedQueueOptions } from "../../../packages/queue/src/types.ts"
import type { AgentSandboxConfig } from "../../../packages/sandbox/src/module-types.ts"
import type { ResolvedWorkspaceModuleOptions } from "../../../packages/workspace/src/core/types.ts"
import type { ResolvedWorkflowOptions } from "../../../packages/workflow/src/types.ts"
import type { Plugin } from "vite"

const currentDir = dirname(fileURLToPath(import.meta.url))
const workspaceDir = resolve(currentDir, "../../..")
const packagesDir = resolve(workspaceDir, "packages")
const blobPackageDir = resolve(packagesDir, "blob")
const dbPackageDir = resolve(packagesDir, "db")
const kvPackageDir = resolve(packagesDir, "kv")
const queuePackageDir = resolve(packagesDir, "queue")
const schedulePackageDir = resolve(packagesDir, "schedule")
const sandboxPackageDir = resolve(packagesDir, "sandbox")
const workspacePackageDir = resolve(packagesDir, "workspace")
const workflowPackageDir = resolve(packagesDir, "workflow")
const viteE2EProductName = "vite-e2e"

type HostedProvider = "cloudflare" | "vercel"

interface ViteE2EComposerOptions {
  blob?: false | ResolvedBlobModuleOptions
  clientOutDir: string
  db?: ResolvedDBViteConfig
  hosting: HostedProvider
  kv?: false | ResolvedKVModuleOptions
  rootDir: string
  sandbox?: false | AgentSandboxConfig
  queue?: false | ResolvedQueueOptions
  schedule?: false | true
  workspace?: false | ResolvedWorkspaceModuleOptions
  workflow?: false | ResolvedWorkflowOptions
}

interface CloudflareWranglerConfig {
  assets?: { directory?: string, run_worker_first: string[] }
  compatibility_date: string
  compatibility_flags: string[]
  containers?: Array<Record<string, unknown>>
  d1_databases?: Array<Record<string, unknown>>
  durable_objects?: { bindings?: Array<Record<string, unknown>> }
  kv_namespaces?: Array<Record<string, unknown>>
  main: string
  migrations?: Array<Record<string, unknown>>
  name?: string
  observability: { enabled: true }
  queues?: {
    consumers: Array<{ queue: string }>
    producers: Array<{ binding: string, queue: string }>
  }
  r2_buckets?: Array<{ binding: string, bucket_name: string }>
  artifacts?: Array<{ binding: string, namespace: string }>
  triggers?: { crons: string[] }
  workflows?: Array<{ binding: string, class_name: string, name: string }>
}

interface GeneratedFeatureArtifacts {
  alias: Record<string, string>
  generatedDir: string
  queueDefinitions: Array<{ name: string, handler: string }>
  queueRegistryFile?: string
  scheduleCrons: Map<string, string>
  scheduleDefinitions: Array<{ name: string, handler: string }>
  scheduleRegistryFile?: string
  sandboxConfig?: false | AgentSandboxConfig
  workflowBindings: Array<{ binding: string, class_name: string, name: string }>
  workflowDefinitions: Array<{ name: string, handler: string }>
  workflowRegistryFile?: string
  workspaceRegistryFile?: string
}

function resolveHostedProvider(hosting: string): HostedProvider {
  if (hosting.includes("cloudflare")) return "cloudflare"
  if (hosting.includes("vercel")) return "vercel"
  throw new TypeError(`[vitehub] Unsupported hosted e2e provider: ${hosting || "<empty>"}`)
}

function resolveCloudflareWorkerName(rootDir: string) {
  const workerName = process.env.VITEHUB_CLOUDFLARE_WORKER_NAME?.trim()
  return workerName || toSafeAppName(rootDir)
}

function resolvePackageRuntime(packageDir: string, modulePath: string) {
  return resolve(packageDir, "src", `${modulePath}.ts`)
}

function resolvePackageDependency(packageDir: string, specifier: string) {
  return createRequire(resolve(packageDir, "package.json")).resolve(specifier)
}

function resolveIsomorphicGitEsmEntry() {
  return resolve(dirname(resolvePackageDependency(workspacePackageDir, "isomorphic-git")), "index.js")
}

function resolveIsomorphicGitHttpWebEsmEntry() {
  return resolve(dirname(resolvePackageDependency(workspacePackageDir, "isomorphic-git/http/web")), "index.js")
}

function resolveSandboxClassName(config: { className?: unknown } | undefined) {
  return typeof config?.className === "string" ? config.className : defaultCloudflareSandboxClassName
}

function withoutCloudflareWorkspaceAliases(alias: Record<string, string>) {
  const filtered = { ...alias }
  for (const dependency of ["async-lock", "clean-git-ref", "crc-32", "diff3", "ignore", "inherits", "isomorphic-git", "isomorphic-git/http/web", "minimisted", "pako", "pify", "readable-stream", "sha.js/sha1.js", "simple-get"]) {
    delete filtered[dependency]
  }
  return filtered
}

function renderDbRuntimeModule(file: string, config: ResolvedDBViteConfig) {
  const schemaBlocks = config.databaseNames.map((name, index) => serializeSchemaObject(
    config.schemaPathsByDatabase[name] || [],
    `schema_${index}`,
    name === "default",
    file,
  ))
  const databaseEntries = config.databaseNames.map((name, index) => [
    `  ${JSON.stringify(name)}: {`,
    `    db: createHostedDrizzleDb(${JSON.stringify(config.databases[name], null, 4)}, schema_${index}),`,
    `    schema: schema_${index},`,
    "  },",
  ].join("\n"))

  return [
    `import { createHostedDrizzleDb } from ${JSON.stringify(createImportPath(file, resolvePackageRuntime(dbPackageDir, "runtime/hosted")))}`,
    "",
    ...schemaBlocks,
    "export const databases = {",
    ...databaseEntries,
    "}",
    "",
    "export const db = databases.default.db",
    "export const schema = databases.default.schema",
    "",
  ].join("\n")
}

function renderBlobRuntimeModule(file: string, config: false | ResolvedBlobModuleOptions | undefined) {
  const imports = [
    `import { ensureBlob } from ${JSON.stringify(createImportPath(file, resolvePackageRuntime(blobPackageDir, "ensure")))}`,
    `import { createBlobStorage } from ${JSON.stringify(createImportPath(file, resolvePackageRuntime(blobPackageDir, "storage")))}`,
    `import { setBlobRuntimeConfig, setBlobRuntimeStorage } from ${JSON.stringify(createImportPath(file, resolvePackageRuntime(blobPackageDir, "runtime/state")))}`,
  ]

  if (config?.store.driver === "cloudflare-r2") {
    imports.push(`import { createDriver } from ${JSON.stringify(createImportPath(file, resolvePackageRuntime(blobPackageDir, "drivers/cloudflare")))}`)
  }
  else if (config?.store.driver === "vercel-blob") {
    imports.push(`import { resolveRuntimeVercelBlobStore } from ${JSON.stringify(createImportPath(file, resolvePackageRuntime(blobPackageDir, "config")))}`)
    imports.push(`import { createDriver } from ${JSON.stringify(createImportPath(file, resolvePackageRuntime(blobPackageDir, "drivers/vercel")))}`)
  }
  else if (config?.store.driver === "fs") {
    imports.push(`import { createDriver } from ${JSON.stringify(createImportPath(file, resolvePackageRuntime(blobPackageDir, "drivers/fs")))}`)
  }
  else if (config) {
    imports.push(`import { createDriver } from ${JSON.stringify(createImportPath(file, resolvePackageRuntime(blobPackageDir, "drivers/files")))}`)
  }

  const storageExpression = !config
    ? "undefined"
    : config.store.driver === "vercel-blob"
      ? "createBlobStorage(createDriver(resolveRuntimeVercelBlobStore(blobConfig.store, process.env)))"
      : "createBlobStorage(createDriver(blobConfig.store))"

  return [
    ...imports,
    "",
    `const blobConfig = ${JSON.stringify(config || false, null, 2)}`,
    "setBlobRuntimeConfig(blobConfig)",
    `export const blob = ${storageExpression}`,
    "setBlobRuntimeStorage(blob || undefined)",
    "export { ensureBlob }",
    "",
  ].join("\n")
}

function renderKvRuntimeModule(file: string, config: false | ResolvedKVModuleOptions | undefined) {
  if (!config) {
    return [
      "const disabled = async () => { throw new Error('[vitehub] `@vitehub/kv` runtime is disabled.') }",
      "export const kv = {",
      "  clear: disabled,",
      "  del: disabled,",
      "  get: disabled,",
      "  has: disabled,",
      "  keys: disabled,",
      "  set: disabled,",
      "}",
      "",
    ].join("\n")
  }

  const imports = [
    `import { createStorage } from ${JSON.stringify(createImportPath(file, resolvePackageDependency(kvPackageDir, "unstorage")))}`,
  ]

  if (config.store.driver === "cloudflare-kv-binding") {
    imports.push(`import createDriver from ${JSON.stringify(createImportPath(file, resolvePackageDependency(kvPackageDir, "unstorage/drivers/cloudflare-kv-binding")))}`)
  }
  else if (config.store.driver === "upstash") {
    imports.push(`import createDriver from ${JSON.stringify(createImportPath(file, resolvePackageDependency(kvPackageDir, "unstorage/drivers/upstash")))}`)
    imports.push(`import { resolveRuntimeKVOptions } from ${JSON.stringify(createImportPath(file, resolvePackageRuntime(kvPackageDir, "runtime/upstash")))}`)
  }
  else {
    imports.push(`import createDriver from ${JSON.stringify(createImportPath(file, resolvePackageDependency(kvPackageDir, "unstorage/drivers/fs-lite")))}`)
  }

  const resolvedConfigExpression = config.store.driver === "upstash"
    ? "resolveRuntimeKVOptions(kvConfig, process.env) || kvConfig"
    : "kvConfig"

  return [
    ...imports,
    "",
    `const kvConfig = ${JSON.stringify(config, null, 2)}`,
    `const resolvedKvConfig = ${resolvedConfigExpression}`,
    "const storage = createStorage({ driver: createDriver(resolvedKvConfig.store) })",
    "export const kv = {",
    "  async clear(base, options) { await storage.clear(base, options) },",
    "  async del(key, options) { await storage.removeItem(key, options) },",
    "  async get(key, options) { return await storage.getItem(key, options) },",
    "  async has(key, options) { return await storage.hasItem(key, options) },",
    "  async keys(base, options) { return await storage.getKeys(base, options) },",
    "  async set(key, value, options) { await storage.setItem(key, value, options) },",
    "}",
    "",
  ].join("\n")
}

function renderQueueRuntimeModule(file: string) {
  return [
    `export { defineQueue } from ${JSON.stringify(createImportPath(file, resolve(queuePackageDir, "src/definition.ts")))}`,
    `export { createQueueMessageId } from ${JSON.stringify(createImportPath(file, resolve(queuePackageDir, "src/enqueue.ts")))}`,
    `export { QueueError } from ${JSON.stringify(createImportPath(file, resolve(queuePackageDir, "src/errors.ts")))}`,
    `export { createQueueClient, deferQueue, getQueue, runQueue } from ${JSON.stringify(createImportPath(file, resolve(queuePackageDir, "src/runtime/client.ts")))}`,
    "",
  ].join("\n")
}

function renderScheduleRuntimeModule(file: string) {
  return [
    `export { defineSchedule } from ${JSON.stringify(createImportPath(file, resolve(schedulePackageDir, "src/definition.ts")))}`,
    "",
  ].join("\n")
}

function renderSandboxRuntimeModule(file: string) {
  return [
    `export { defineSandbox } from ${JSON.stringify(createImportPath(file, resolvePackageRuntime(sandboxPackageDir, "runtime/registry")))}`,
    `export { runSandbox } from ${JSON.stringify(createImportPath(file, resolvePackageRuntime(sandboxPackageDir, "runtime/public")))}`,
    `export { readValidatedPayload } from ${JSON.stringify(createImportPath(file, resolvePackageRuntime(sandboxPackageDir, "runtime/validation")))}`,
    `export { readRequestPayload } from ${JSON.stringify(createImportPath(file, resolvePackageRuntime(sandboxPackageDir, "internal/shared/request-payload")))}`,
    "",
  ].join("\n")
}

function renderWorkflowRuntimeModule(file: string) {
  return [
    `export { defineWorkflow } from ${JSON.stringify(createImportPath(file, resolve(workflowPackageDir, "src/definition.ts")))}`,
    `export { WorkflowError } from ${JSON.stringify(createImportPath(file, resolve(workflowPackageDir, "src/errors.ts")))}`,
    `export { createWorkflow, deferWorkflow, getWorkflowRun, runWorkflow } from ${JSON.stringify(createImportPath(file, resolve(workflowPackageDir, "src/runtime/client.ts")))}`,
    `export { readRequestPayload, readValidatedPayload, validatePayload } from ${JSON.stringify(createImportPath(file, resolve(workflowPackageDir, "src/runtime/payload.ts")))}`,
    "",
  ].join("\n")
}

function renderWorkspaceRuntimeModule(file: string) {
  return [
    `export { defineWorkspace } from ${JSON.stringify(createImportPath(file, resolve(workspacePackageDir, "src/core/define.ts")))}`,
    `export const source = { custom: source => source, file: input => createHostedSourceStub("file", input), github: options => createHostedSourceStub("github", options), glob: options => createHostedSourceStub("glob", options), markdown: options => createHostedSourceStub("markdown", options) }`,
    `export { useWorkspace } from ${JSON.stringify(createImportPath(file, resolve(workspacePackageDir, "src/core/use.ts")))}`,
    `function createHostedSourceStub(kind, input) {`,
    `  return {`,
    `    fingerprint: { input, kind },`,
    `    async getKeys() { throw new Error("[vitehub] workspace source." + kind + "() is not available in the hosted Vite e2e runtime.") },`,
    `    async getItem() { throw new Error("[vitehub] workspace source." + kind + "() is not available in the hosted Vite e2e runtime.") },`,
    `  }`,
    `}`,
    "",
  ].join("\n")
}

function renderWorkspaceShellRuntimeModule() {
  return [
    "export const workspaceMountPoint = '/workspace'",
    "export function cleanWorkspaceMutationPath(path) { return path }",
    "export function cleanWorkspaceShellPath(path = '.') { return path }",
    "export function createReadonlyWorkspaceFs(fs) { return fs }",
    "export function createWritableWorkspaceFs(fs) { return fs }",
    "export async function runWorkspaceInspectionCommand() {",
    "  throw new Error('[vitehub] Workspace shell tools are not available in the hosted Vite e2e runtime.')",
    "}",
    "",
  ].join("\n")
}

function toSandboxArtifactName(name: string) {
  return name.replace(/[^a-z0-9/_:-]/gi, "_").replace(/\//g, "__").replace(/:/g, "__")
}

function renderSandboxRegistryModule(definitions: Array<{ name: string, file: string }>) {
  return [
    "const registry = {",
    ...definitions.map(definition => `  ${JSON.stringify(definition.name)}: async () => import(${JSON.stringify(definition.file)}),`),
    "}",
    "export default registry",
    "",
  ].join("\n")
}

function renderSandboxProviderLoaderModule(file: string, provider: "cloudflare" | "vercel") {
  const runtimeProviderFile = resolvePackageRuntime(sandboxPackageDir, `runtime/providers/${provider}`)
  const clientProviderFile = resolvePackageRuntime(sandboxPackageDir, `sandbox/providers/${provider}`)
  const clientFactory = provider === "cloudflare" ? "createCloudflareSandboxClient" : "createVercelSandboxClient"

  return [
    `import { resolveSandboxProvider } from ${JSON.stringify(createImportPath(file, runtimeProviderFile))}`,
    `import { ${clientFactory} } from ${JSON.stringify(createImportPath(file, clientProviderFile))}`,
    "",
    "export async function loadSandboxRuntimeProvider(selectedProvider) {",
    `  if (selectedProvider !== ${JSON.stringify(provider)})`,
    "    throw new Error(`[vitehub] Unsupported sandbox provider for this hosted build: ${selectedProvider}`)",
    "  return {",
    "    resolveSandboxProvider,",
    `    createSandboxClient: ${clientFactory},`,
    "  }",
    "}",
    "",
  ].join("\n")
}

async function prepareFeatureArtifacts(options: ViteE2EComposerOptions) {
  const generatedDir = ensureGeneratedDir(options.rootDir, viteE2EProductName)
  await rm(generatedDir, { force: true, recursive: true })
  await mkdir(generatedDir, { recursive: true })

  const alias: Record<string, string> = {}
  const queueDefinitions = options.queue
    ? discoverQueueDefinitions({ mode: "nitro-server-queues", scanDirs: [resolve(options.rootDir, "server")] })
    : []
  const scheduleDefinitions = options.schedule
    ? discoverScheduleDefinitions({ rootDir: options.rootDir })
    : []
  const workflowDefinitions = options.workflow
    ? discoverWorkflowDefinitions({ mode: "nitro-server-workflows", scanDirs: [resolve(options.rootDir, "server")] })
    : []
  const sandboxDefinitions = options.sandbox
    ? discoverNitroSandboxDefinitions([resolve(options.rootDir, "server")])
    : []
  const workspaceDefinitions = options.workspace
    ? discoverViteWorkspaceDefinitions(options.rootDir)
    : []

  const runtimeWrites: Promise<void>[] = []

  let queueRegistryFile: string | undefined
  if (queueDefinitions.length) {
    queueRegistryFile = resolve(generatedDir, "queue-registry.mjs")
    runtimeWrites.push(writeFile(queueRegistryFile, createRuntimeRegistryContents(queueRegistryFile, queueDefinitions), "utf8"))
  }

  let scheduleRegistryFile: string | undefined
  if (scheduleDefinitions.length) {
    scheduleRegistryFile = resolve(generatedDir, "schedule-registry.mjs")
    runtimeWrites.push(writeFile(scheduleRegistryFile, createRuntimeRegistryContents(scheduleRegistryFile, scheduleDefinitions), "utf8"))
  }

  let workflowRegistryFile: string | undefined
  if (workflowDefinitions.length) {
    workflowRegistryFile = resolve(generatedDir, "workflow-registry.mjs")
    runtimeWrites.push(writeFile(workflowRegistryFile, createRuntimeRegistryContents(workflowRegistryFile, workflowDefinitions), "utf8"))
  }

  if (options.db) {
    const dbRuntimeFile = resolve(generatedDir, "db-runtime.mjs")
    alias["@vitehub/db/drizzle"] = dbRuntimeFile
    runtimeWrites.push(writeFile(dbRuntimeFile, renderDbRuntimeModule(dbRuntimeFile, options.db), "utf8"))
  }

  if (typeof options.blob !== "undefined") {
    const blobRuntimeFile = resolve(generatedDir, "blob-runtime.mjs")
    alias["@vitehub/blob"] = blobRuntimeFile
    runtimeWrites.push(writeFile(blobRuntimeFile, renderBlobRuntimeModule(blobRuntimeFile, options.blob), "utf8"))
  }

  if (typeof options.kv !== "undefined") {
    const kvRuntimeFile = resolve(generatedDir, "kv-runtime.mjs")
    alias["@vitehub/kv"] = kvRuntimeFile
    runtimeWrites.push(writeFile(kvRuntimeFile, renderKvRuntimeModule(kvRuntimeFile, options.kv), "utf8"))
  }

  if (typeof options.queue !== "undefined") {
    const queueRuntimeFile = resolve(generatedDir, "queue-runtime.mjs")
    alias["@vitehub/queue"] = queueRuntimeFile
    runtimeWrites.push(writeFile(queueRuntimeFile, renderQueueRuntimeModule(queueRuntimeFile), "utf8"))
  }

  if (typeof options.schedule !== "undefined") {
    const scheduleRuntimeFile = resolve(generatedDir, "schedule-runtime.mjs")
    alias["@vitehub/schedule"] = scheduleRuntimeFile
    runtimeWrites.push(writeFile(scheduleRuntimeFile, renderScheduleRuntimeModule(scheduleRuntimeFile), "utf8"))
  }

  if (typeof options.sandbox !== "undefined") {
    const sandboxRuntimeFile = resolve(generatedDir, "sandbox-runtime.mjs")
    alias["@vitehub/sandbox/runtime/state"] = resolve(sandboxPackageDir, "src/runtime/state.ts")
    alias["@vitehub/sandbox"] = sandboxRuntimeFile
    runtimeWrites.push(writeFile(sandboxRuntimeFile, renderSandboxRuntimeModule(sandboxRuntimeFile), "utf8"))
  }

  if (typeof options.workflow !== "undefined") {
    const workflowRuntimeFile = resolve(generatedDir, "workflow-runtime.mjs")
    alias["@vitehub/workflow"] = workflowRuntimeFile
    runtimeWrites.push(writeFile(workflowRuntimeFile, renderWorkflowRuntimeModule(workflowRuntimeFile), "utf8"))
  }

  if (typeof options.workspace !== "undefined") {
    const workspaceRuntimeFile = resolve(generatedDir, "workspace-runtime.mjs")
    const workspaceShellRuntimeFile = resolve(generatedDir, "workspace-shell-runtime.mjs")
    alias["@vitehub/workspace/internal/runtime/state"] = resolve(workspacePackageDir, "src/runtime/state.ts")
    alias["@vitehub/workspace/loader"] = resolve(workspacePackageDir, "src/loader.ts")
    alias["@vitehub/workspace/publish"] = resolve(workspacePackageDir, "src/publish.ts")
    alias["@vitehub/workspace/test"] = resolve(workspacePackageDir, "src/test.ts")
    alias["@vitehub/workspace"] = workspaceRuntimeFile
    alias["@vitehub/shell/workspace"] = workspaceShellRuntimeFile
    alias["@vitehub/shell"] = workspaceShellRuntimeFile
    alias["isomorphic-git/http/web"] = resolveIsomorphicGitHttpWebEsmEntry()
    alias["isomorphic-git"] = resolveIsomorphicGitEsmEntry()
    for (const dependency of ["async-lock", "clean-git-ref", "crc-32", "diff3", "ignore", "inherits", "minimisted", "pako", "pify", "readable-stream", "sha.js/sha1.js", "simple-get"]) {
      alias[dependency] = resolvePackageDependency(workspacePackageDir, dependency)
    }
    runtimeWrites.push(
      writeFile(workspaceRuntimeFile, renderWorkspaceRuntimeModule(workspaceRuntimeFile), "utf8"),
      writeFile(workspaceShellRuntimeFile, renderWorkspaceShellRuntimeModule(), "utf8"),
    )
  }

  await Promise.all(runtimeWrites)
  const scheduleCrons = await readDefinitionCrons(scheduleDefinitions)

  let sandboxConfig: false | AgentSandboxConfig | undefined
  if (options.sandbox) {
    sandboxConfig = resolveSandboxFeatureConfig(options.sandbox, options.hosting)
    const sandboxProvider = sandboxConfig.provider === "vercel" ? "vercel" : "cloudflare"

    const emittedDefinitions = await Promise.all(sandboxDefinitions.map(async (definition) => {
      const file = resolve(generatedDir, "runtime", "sandbox-definitions", `${toSandboxArtifactName(definition.name)}.mjs`)
      const [source, definitionOptions] = await Promise.all([
        readFile(definition._meta.sourcePath, "utf8"),
        extractSandboxDefinitionOptions(definition.handler),
      ])
      const bundle = await bundleSandboxDefinition(source, definition._meta.sourcePath)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, `export default ${JSON.stringify({ bundle, options: definitionOptions ?? undefined })}\n`, "utf8")
      return { file, name: definition.name }
    }))

    const sandboxRegistryFile = resolve(generatedDir, "runtime", "sandbox-registry.mjs")
    const sandboxProviderLoaderFile = resolve(generatedDir, "runtime", "sandbox-provider-loader.mjs")

    await Promise.all([
      writeFile(sandboxRegistryFile, renderSandboxRegistryModule(emittedDefinitions), "utf8"),
      writeFile(sandboxProviderLoaderFile, renderSandboxProviderLoaderModule(sandboxProviderLoaderFile, sandboxProvider), "utf8"),
    ])

    alias["#vitehub-sandbox-registry"] = sandboxRegistryFile
    alias["#vitehub-sandbox-provider-loader"] = sandboxProviderLoaderFile

    if (sandboxProvider === "cloudflare") {
      alias["@cloudflare/sandbox"] = resolvePackageDependency(sandboxPackageDir, "@cloudflare/sandbox")
    }
  }

  let workspaceRegistryFile: string | undefined
  if (workspaceDefinitions.length) {
    workspaceRegistryFile = resolve(generatedDir, "runtime", "workspace-registry.mjs")
    await mkdir(dirname(workspaceRegistryFile), { recursive: true })
    await writeFile(workspaceRegistryFile, createRuntimeRegistryContents(workspaceRegistryFile, workspaceDefinitions), "utf8")
    alias["#vitehub-workspace-registry"] = workspaceRegistryFile
  }

  return {
    alias,
    generatedDir,
    queueDefinitions,
    queueRegistryFile,
    scheduleCrons,
    scheduleDefinitions,
    scheduleRegistryFile,
    sandboxConfig,
    workflowBindings: createCloudflareWorkflowBindings(workflowDefinitions, options.workflow) || [],
    workflowDefinitions,
    workflowRegistryFile,
    workspaceRegistryFile,
  } satisfies GeneratedFeatureArtifacts
}

function renderCloudflareEntry(file: string, options: ViteE2EComposerOptions, artifacts: GeneratedFeatureArtifacts) {
  const appEntry = resolve(options.rootDir, "src/server.e2e.ts")
  const resolveApp = resolve(packagesDir, "internal/src/runtime/app.ts")
  const cloudflareEnv = resolve(packagesDir, "internal/src/runtime/cloudflare-env.ts")
  const workspaceProvider = options.workspace && options.workspace.store.provider

  const imports = [
    `import { H3, toWebHandler } from "h3"`,
    `import { resolveAppFetch } from ${JSON.stringify(createImportPath(file, resolveApp))}`,
    `import { clearActiveCloudflareEnv, createCloudflareRuntimeEvent, runWithActiveCloudflareEnv, setActiveCloudflareEnv } from ${JSON.stringify(createImportPath(file, cloudflareEnv))}`,
    `import app from ${JSON.stringify(createImportPath(file, appEntry))}`,
    `import { createCloudflareQueueBatchHandler } from ${JSON.stringify(createImportPath(file, resolve(queuePackageDir, "src/providers/cloudflare.ts")))}`,
    `import { getCloudflareQueueDefinitionName } from ${JSON.stringify(createImportPath(file, resolve(queuePackageDir, "src/integrations/cloudflare.ts")))}`,
    `import { createQueueJob } from ${JSON.stringify(createImportPath(file, resolve(queuePackageDir, "src/runtime/cloudflare-shared.ts")))}`,
    `import { loadQueueDefinition, runWithQueueRuntimeEvent, setQueueRuntimeConfig, setQueueRuntimeRegistry } from ${JSON.stringify(createImportPath(file, resolve(queuePackageDir, "src/runtime/state.ts")))}`,
    `import { executeStaticSchedule } from ${JSON.stringify(createImportPath(file, resolve(schedulePackageDir, "src/runtime/execute.ts")))}`,
    `import { runCloudflareWorkflow } from ${JSON.stringify(createImportPath(file, resolve(workflowPackageDir, "src/runtime/cloudflare-runner.ts")))}`,
    `import { runWithWorkflowRuntimeEvent, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from ${JSON.stringify(createImportPath(file, resolve(workflowPackageDir, "src/runtime/state.ts")))}`,
    `import { setBlobRuntimeConfig } from ${JSON.stringify(createImportPath(file, resolve(blobPackageDir, "src/runtime/state.ts")))}`,
    `import { setSandboxRuntimeConfig, setSandboxRuntimeRegistry } from ${JSON.stringify(createImportPath(file, resolve(sandboxPackageDir, "src/runtime/state.ts")))}`,
    `import { setWorkspaceHostedStoreLoader, setWorkspaceRuntimeConfig, setWorkspaceRuntimeRegistry } from ${JSON.stringify(createImportPath(file, resolve(workspacePackageDir, "src/runtime/state.ts")))}`,
  ]

  if (workspaceProvider === "cloudflare-artifacts") {
    imports.push(`import { createCloudflareArtifactsWorkspaceStore } from ${JSON.stringify(createImportPath(file, resolve(workspacePackageDir, "src/providers/cloudflare/artifacts-store.ts")))}`)
  }

  if (artifacts.queueRegistryFile) {
    imports.push(`import queueRegistry from ${JSON.stringify(createImportPath(file, artifacts.queueRegistryFile))}`)
  }
  if (artifacts.scheduleRegistryFile) {
    imports.push(`import __vitehubScheduleRegistry from ${JSON.stringify(createImportPath(file, artifacts.scheduleRegistryFile))}`)
  }
  if (artifacts.workflowRegistryFile) {
    imports.push(`import workflowRegistry from ${JSON.stringify(createImportPath(file, artifacts.workflowRegistryFile))}`)
  }
  if (artifacts.alias["#vitehub-sandbox-registry"]) {
    imports.push(`import sandboxRegistry from ${JSON.stringify(createImportPath(file, artifacts.alias["#vitehub-sandbox-registry"]))}`)
  }
  if (artifacts.workspaceRegistryFile) {
    imports.push(`import workspaceRegistry from ${JSON.stringify(createImportPath(file, artifacts.workspaceRegistryFile))}`)
  }
  if (artifacts.workflowBindings.length) {
    imports.push(`import { WorkflowEntrypoint } from "cloudflare:workers"`)
  }
  if (artifacts.sandboxConfig && options.sandbox) {
    imports.push(`import { Sandbox as CloudflareSandbox } from "@cloudflare/sandbox"`)
  }

  const workflowClassExports = artifacts.workflowDefinitions.map((definition, index) => {
    const binding = artifacts.workflowBindings[index]
    return [
      `export class ${binding?.class_name || getCloudflareWorkflowClassName(definition.name)} extends WorkflowEntrypoint {`,
      "  async run(event, step) {",
      `    return await runCloudflareWorkflow({ config: workflowConfig, env: this.env || {}, event, name: ${JSON.stringify(definition.name)}, registry: workflowRegistry, step })`,
      "  }",
      "}",
      "",
    ].join("\n")
  })

  return [
    ...imports,
    "",
    `const queueConfig = ${JSON.stringify(options.queue || false, null, 2)}`,
    `const workflowConfig = ${JSON.stringify(options.workflow || false, null, 2)}`,
    `const blobConfig = ${JSON.stringify(options.blob || false, null, 2)}`,
    `const sandboxConfig = ${JSON.stringify(artifacts.sandboxConfig || false, null, 2)}`,
    `const workspaceConfig = ${JSON.stringify(options.workspace || false, null, 2)}`,
    "setQueueRuntimeConfig(queueConfig)",
    `setQueueRuntimeRegistry(${artifacts.queueRegistryFile ? "queueRegistry" : "undefined"})`,
    "setWorkflowRuntimeConfig(workflowConfig)",
    `setWorkflowRuntimeRegistry(${artifacts.workflowRegistryFile ? "workflowRegistry" : "undefined"})`,
    "setBlobRuntimeConfig(blobConfig)",
    "setSandboxRuntimeConfig(sandboxConfig)",
    `setSandboxRuntimeRegistry(${artifacts.alias["#vitehub-sandbox-registry"] ? "sandboxRegistry" : "undefined"})`,
    "setWorkspaceRuntimeConfig(workspaceConfig)",
    ...(workspaceProvider === "cloudflare-artifacts"
      ? [
          "setWorkspaceHostedStoreLoader((store, workspaceName) => {",
          "  if (store.provider !== 'cloudflare-artifacts') throw new Error(`[vitehub] Unsupported workspace store for Cloudflare build: ${store.provider}`)",
          "  return createCloudflareArtifactsWorkspaceStore(store, workspaceName)",
          "})",
        ]
      : ["setWorkspaceHostedStoreLoader(undefined)"]),
    `setWorkspaceRuntimeRegistry(${artifacts.workspaceRegistryFile ? "workspaceRegistry" : "{ }"})`,
    "const defaultHandler = toWebHandler(new H3())",
    "const appHandler = resolveAppFetch('vitehub', app)",
    "",
    ...workflowClassExports,
    artifacts.sandboxConfig && options.sandbox
      ? `export class ${resolveSandboxClassName(artifacts.sandboxConfig)} extends CloudflareSandbox {}`
      : "",
    "",
    "const worker = {",
    "  async fetch(request, env, context) {",
    "    setActiveCloudflareEnv(env)",
    "    const runtimeEvent = createCloudflareRuntimeEvent(env, context)",
    "    try {",
    "      return await runWithActiveCloudflareEnv(env, () => runWithQueueRuntimeEvent(runtimeEvent, () => runWithWorkflowRuntimeEvent(runtimeEvent, () => Promise.resolve(appHandler ? appHandler(request, runtimeEvent.context) : defaultHandler(request, runtimeEvent.context)))))",
    "    } finally {",
    "      clearActiveCloudflareEnv()",
    "    }",
    "  },",
    "  async queue(batch, env, context) {",
    "    if (queueConfig === false || queueConfig?.provider !== 'cloudflare') return",
    "    setActiveCloudflareEnv(env)",
    "    try {",
    "      const definition = await loadQueueDefinition(getCloudflareQueueDefinitionName(batch.queue))",
    "      if (!definition) return",
    "      const runtimeEvent = createCloudflareRuntimeEvent(env, context)",
    "      await createCloudflareQueueBatchHandler({",
    "        concurrency: definition.options?.concurrency,",
    "        onError: definition.options?.onError,",
    "        onMessage: async (message, currentBatch) => {",
    "          await runWithQueueRuntimeEvent(runtimeEvent, async () => {",
    "            await definition.handler(createQueueJob(message, currentBatch))",
    "          })",
    "        },",
    "      })(batch)",
    "    } finally {",
    "      clearActiveCloudflareEnv()",
    "    }",
    "  },",
    "  async scheduled(event, env, context) {",
    `    const scheduleRegistry = ${artifacts.scheduleRegistryFile ? "__vitehubScheduleRegistry" : "{}"}`,
    "    setActiveCloudflareEnv(env)",
    "    try {",
    "      await Promise.all(Object.entries(scheduleRegistry).map(async ([name, loader]) => {",
    "        const loaded = await loader()",
    "        const definition = loaded?.default ?? loaded",
    "        if (!definition || definition.cron !== event.cron) return",
    "        await executeStaticSchedule({ cron: event.cron, definition, name, scheduledAt: new Date(event.scheduledTime) })",
    "      }))",
    "    } finally {",
    "      clearActiveCloudflareEnv()",
    "    }",
    "  },",
    "}",
    "",
    "export default worker",
    "",
  ].filter(Boolean).join("\n")
}

function renderVercelEntry(file: string, options: ViteE2EComposerOptions, artifacts: GeneratedFeatureArtifacts) {
  const appEntry = resolve(options.rootDir, "src/server.e2e.ts")
  const resolveApp = resolve(packagesDir, "internal/src/runtime/app.ts")
  const workspaceProvider = options.workspace && options.workspace.store.provider
  const preloadVercelQueue = options.queue && options.queue.provider === "vercel"

  const imports = [
    `import { waitUntil as vercelWaitUntil } from ${JSON.stringify(createImportPath(file, resolvePackageDependency(queuePackageDir, "@vercel/functions")))}`,
    `import { H3, fromWebHandler } from "h3"`,
    `import { toNodeHandler } from "h3/node"`,
    `import { resolveAppFetch } from ${JSON.stringify(createImportPath(file, resolveApp))}`,
    `import { setQueueRuntimeConfig, setQueueRuntimeRegistry, runWithQueueRuntimeEvent } from ${JSON.stringify(createImportPath(file, resolve(queuePackageDir, "src/runtime/state.ts")))}`,
    `import { setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry, runWithWorkflowRuntimeEvent } from ${JSON.stringify(createImportPath(file, resolve(workflowPackageDir, "src/runtime/state.ts")))}`,
    `import { setBlobRuntimeConfig } from ${JSON.stringify(createImportPath(file, resolve(blobPackageDir, "src/runtime/state.ts")))}`,
    `import { setSandboxRuntimeConfig, setSandboxRuntimeRegistry } from ${JSON.stringify(createImportPath(file, resolve(sandboxPackageDir, "src/runtime/state.ts")))}`,
    `import { setWorkspaceHostedStoreLoader, setWorkspaceRuntimeConfig, setWorkspaceRuntimeRegistry } from ${JSON.stringify(createImportPath(file, resolve(workspacePackageDir, "src/runtime/state.ts")))}`,
    `import app from ${JSON.stringify(createImportPath(file, appEntry))}`,
  ]
  if (preloadVercelQueue) {
    imports.push("import * as __vitehubVercelQueue from '@vercel/queue'")
  }

  if (workspaceProvider === "vercel-blob") {
    imports.push(`import { createVercelBlobWorkspaceStore } from ${JSON.stringify(createImportPath(file, resolve(workspacePackageDir, "src/providers/vercel/blob-store.ts")))}`)
  }

  if (artifacts.queueRegistryFile) {
    imports.push(`import queueRegistry from ${JSON.stringify(createImportPath(file, artifacts.queueRegistryFile))}`)
  }
  if (artifacts.workflowRegistryFile) {
    imports.push(`import workflowRegistry from ${JSON.stringify(createImportPath(file, artifacts.workflowRegistryFile))}`)
  }
  if (artifacts.alias["#vitehub-sandbox-registry"]) {
    imports.push(`import sandboxRegistry from ${JSON.stringify(createImportPath(file, artifacts.alias["#vitehub-sandbox-registry"]))}`)
  }
  if (artifacts.workspaceRegistryFile) {
    imports.push(`import workspaceRegistry from ${JSON.stringify(createImportPath(file, artifacts.workspaceRegistryFile))}`)
  }

  return [
    ...imports,
    "",
    preloadVercelQueue ? "globalThis.__vitehubVercelQueue = __vitehubVercelQueue" : "",
    `const queueConfig = ${JSON.stringify(options.queue || false, null, 2)}`,
    `const workflowConfig = ${JSON.stringify(options.workflow || false, null, 2)}`,
    `const blobConfig = ${JSON.stringify(options.blob || false, null, 2)}`,
    `const sandboxConfig = ${JSON.stringify(artifacts.sandboxConfig || false, null, 2)}`,
    `const workspaceConfig = ${JSON.stringify(options.workspace || false, null, 2)}`,
    "setQueueRuntimeConfig(queueConfig)",
    `setQueueRuntimeRegistry(${artifacts.queueRegistryFile ? "queueRegistry" : "undefined"})`,
    "setWorkflowRuntimeConfig(workflowConfig)",
    `setWorkflowRuntimeRegistry(${artifacts.workflowRegistryFile ? "workflowRegistry" : "undefined"})`,
    "setBlobRuntimeConfig(blobConfig)",
    "setSandboxRuntimeConfig(sandboxConfig)",
    `setSandboxRuntimeRegistry(${artifacts.alias["#vitehub-sandbox-registry"] ? "sandboxRegistry" : "undefined"})`,
    "setWorkspaceRuntimeConfig(workspaceConfig)",
    ...(workspaceProvider === "vercel-blob"
      ? [
          "setWorkspaceHostedStoreLoader((store, workspaceName) => {",
          "  if (store.provider !== 'vercel-blob') throw new Error(`[vitehub] Unsupported workspace store for Vercel build: ${store.provider}`)",
          "  return createVercelBlobWorkspaceStore(store, workspaceName)",
          "})",
        ]
      : ["setWorkspaceHostedStoreLoader(undefined)"]),
    `setWorkspaceRuntimeRegistry(${artifacts.workspaceRegistryFile ? "workspaceRegistry" : "{ }"})`,
    "const appInstance = new H3()",
    "const fetchHandler = resolveAppFetch('vitehub', app)",
    "if (fetchHandler) {",
    "  appInstance.use(fromWebHandler(async (request, context) => await fetchHandler(request, context)))",
    "}",
    "const nodeHandler = toNodeHandler(appInstance)",
    "export default function vitehubVercelServer(req, res) {",
    "  const runtimeEvent = { req, res, waitUntil: vercelWaitUntil }",
    "  return runWithQueueRuntimeEvent(runtimeEvent, () => runWithWorkflowRuntimeEvent(runtimeEvent, () => nodeHandler(req, res)))",
    "}",
    "",
  ].filter(Boolean).join("\n")
}

function renderVercelQueueWrapper(file: string, queueRegistryFile: string, definitionName: string, queueConfig: false | ResolvedQueueOptions | undefined) {
  const preloadVercelQueue = queueConfig && queueConfig.provider === "vercel"
  const imports = [
    "import { H3 } from 'h3'",
    "import { toNodeHandler } from 'h3/node'",
  ]
  if (preloadVercelQueue) {
    imports.push("import * as __vitehubVercelQueue from '@vercel/queue'")
  }

  return [
    ...imports,
    `import { handleHostedVercelQueueCallback, hostedVercelWaitUntil } from ${JSON.stringify(createImportPath(file, resolve(queuePackageDir, "src/runtime/hosted.ts")))}`,
    `import { loadQueueDefinition, runWithQueueRuntimeEvent, setQueueRuntimeConfig, setQueueRuntimeRegistry } from ${JSON.stringify(createImportPath(file, resolve(queuePackageDir, "src/runtime/state.ts")))}`,
    `import queueRegistry from ${JSON.stringify(createImportPath(file, queueRegistryFile))}`,
    "",
    preloadVercelQueue ? "globalThis.__vitehubVercelQueue = __vitehubVercelQueue" : "",
    `setQueueRuntimeConfig(${JSON.stringify(queueConfig || false, null, 2)})`,
    "setQueueRuntimeRegistry(queueRegistry)",
    "",
    "const app = new H3()",
    "app.use(async (event) => {",
    `  const definition = await loadQueueDefinition(${JSON.stringify(definitionName)})`,
    "  if (!definition) throw new Error('Missing queue definition.')",
    `  return await handleHostedVercelQueueCallback(event, ${JSON.stringify(definitionName)}, definition)`,
    "})",
    "",
    "const handler = toNodeHandler(app)",
    "export default function queueHandler(req, res) {",
    "  return runWithQueueRuntimeEvent({ req, res, waitUntil: hostedVercelWaitUntil }, () => handler(req, res))",
    "}",
    "",
  ].filter(Boolean).join("\n")
}

function renderVercelScheduleWrapper(file: string, scheduleRegistryFile: string, definitionName: string) {
  return [
    `import { executeStaticSchedule } from ${JSON.stringify(createImportPath(file, resolve(schedulePackageDir, "src/runtime/execute.ts")))}`,
    `import scheduleRegistry from ${JSON.stringify(createImportPath(file, scheduleRegistryFile))}`,
    "",
    "export default async function scheduleHandler(req, res) {",
    `  const name = ${JSON.stringify(definitionName)}`,
    "  const loaded = await scheduleRegistry[name]?.()",
    "  const definition = loaded?.default ?? loaded",
    "  if (!definition) {",
    "    res.statusCode = 404",
    "    res.end('Missing schedule definition.')",
    "    return",
    "  }",
    "  await executeStaticSchedule({ cron: definition.cron, definition, name, scheduledAt: new Date() })",
    "  res.statusCode = 204",
    "  res.end()",
    "}",
    "",
  ].join("\n")
}

function sanitizeVercelConsumerName(functionPath: string) {
  let result = ""
  for (const char of functionPath) {
    if (char === "_") {
      result += "__"
    }
    else if (char === "/") {
      result += "_S"
    }
    else if (char === ".") {
      result += "_D"
    }
    else if (/[A-Za-z0-9-]/.test(char)) {
      result += char
    }
    else {
      result += `_${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`
    }
  }
  return result
}

function createCloudflareQueueBindings(definitions: Array<{ name: string }>) {
  if (!definitions.length) return undefined
  return {
    consumers: definitions.map(definition => ({ queue: getCloudflareQueueName(definition.name) })),
    producers: definitions.map(definition => ({
      binding: getCloudflareQueueBindingName(definition.name),
      queue: getCloudflareQueueName(definition.name),
    })),
  }
}

function createCloudflareR2Bindings(config: false | ResolvedBlobModuleOptions | undefined) {
  if (!config || config.store.driver !== "cloudflare-r2" || !config.store.bucketName) {
    return undefined
  }
  return [{ binding: config.store.binding, bucket_name: config.store.bucketName }]
}

function createCloudflareD1Bindings(config: ResolvedDBViteConfig | undefined) {
  if (!config) {
    return undefined
  }

  const bindings = config.databaseNames
    .map(name => config.databases[name]?.cloudflare)
    .filter(database => Boolean(database?.databaseId))
    .map(database => ({
      binding: database!.binding,
      database_id: database!.databaseId,
      ...(database!.databaseName ? { database_name: database!.databaseName } : {}),
      ...(database!.migrationsDir ? { migrations_dir: database!.migrationsDir } : {}),
      ...(database!.migrationsTable ? { migrations_table: database!.migrationsTable } : {}),
      ...(database!.previewDatabaseId ? { preview_database_id: database!.previewDatabaseId } : {}),
    }))

  return bindings.length ? bindings : undefined
}

async function writeCloudflareOutput(options: ViteE2EComposerOptions, artifacts: GeneratedFeatureArtifacts) {
  const clientDir = resolve(options.rootDir, options.clientOutDir)
  const outputRoot = resolve(options.rootDir, "dist", toSafeAppName(options.rootDir))
  const workerEntry = resolve(artifacts.generatedDir, "cloudflare-entry.mjs")
  const staticIndex = hasStaticIndex(clientDir)
  const workerName = resolveCloudflareWorkerName(options.rootDir)

  await writeFile(workerEntry, renderCloudflareEntry(workerEntry, options, artifacts), "utf8")
  await rm(outputRoot, { force: true, recursive: true })
  if (staticIndex) {
    await copyClientOutput(clientDir, resolve(options.rootDir, "dist", "client"))
  }
  await mkdir(outputRoot, { recursive: true })

  await bundleEsmEntry(workerEntry, resolve(outputRoot, "index.js"), {
    alias: artifacts.alias,
    conditions: ["workerd", "worker", "browser", "default"],
    external: [
      "@vercel/blob",
      "@vercel/queue",
      "@vercel/sandbox",
      "askweb",
      "cloudflare:workers",
      "files-sdk",
      "files-sdk/akamai",
      "files-sdk/azure",
      "files-sdk/box",
      "files-sdk/digitalocean-spaces",
      "files-sdk/dropbox",
      "files-sdk/fs",
      "files-sdk/gcs",
      "files-sdk/google-drive",
      "files-sdk/hetzner",
      "files-sdk/minio",
      "files-sdk/netlify-blobs",
      "files-sdk/onedrive",
      "files-sdk/r2",
      "files-sdk/s3",
      "files-sdk/storj",
      "files-sdk/supabase",
      "files-sdk/uploadthing",
      "files-sdk/vercel-blob",
      "node:async_hooks",
      "node:child_process",
      "node:buffer",
      "node:crypto",
      "node:fs",
      "node:fs/promises",
      "node:path",
      "node:path/posix",
      "node:stream",
      "node:url",
      "workflow",
      "workflow/api",
      "workflow/runtime",
    ],
    format: "esm",
    platform: "neutral",
  })

  const d1Databases = createCloudflareD1Bindings(options.db)
  const queueBindings = createCloudflareQueueBindings(artifacts.queueDefinitions)
  const r2Buckets = createCloudflareR2Bindings(options.blob)

  const wranglerConfig: CloudflareWranglerConfig = {
    compatibility_date: defaultCloudflareCompatibilityDate,
    compatibility_flags: ["nodejs_compat"],
    ...(d1Databases ? { d1_databases: d1Databases } : {}),
    main: "index.js",
    name: workerName,
    observability: { enabled: true },
    ...(staticIndex ? { assets: { directory: "../client", run_worker_first: ["/api/*"] } } : {}),
    ...(queueBindings ? { queues: queueBindings } : {}),
    ...(artifacts.scheduleCrons.size ? { triggers: { crons: [...new Set(artifacts.scheduleCrons.values())] } } : {}),
    ...(artifacts.workflowBindings.length ? { workflows: artifacts.workflowBindings } : {}),
    ...(r2Buckets ? { r2_buckets: r2Buckets } : {}),
  }

  if (options.kv) {
    configureCloudflareKV({ cloudflare: { wrangler: wranglerConfig } as never }, options.kv)
  }
  configureCloudflareArtifacts({ cloudflare: { wrangler: wranglerConfig } as never }, options.workspace || false)

  if (artifacts.sandboxConfig && artifacts.sandboxConfig.provider === "cloudflare") {
    const sandboxClassName = resolveSandboxClassName(artifacts.sandboxConfig)
    configureCloudflareSandbox({ cloudflare: { wrangler: wranglerConfig } as never }, {
      binding: typeof artifacts.sandboxConfig.binding === "string" ? artifacts.sandboxConfig.binding : defaultCloudflareSandboxBinding,
      className: sandboxClassName,
      migrationTag: typeof artifacts.sandboxConfig.migrationTag === "string" ? artifacts.sandboxConfig.migrationTag : defaultCloudflareSandboxMigrationTag,
      name: toSafeAppName(`${workerName}-${sandboxClassName}`),
    })
    await writeCloudflareSandboxDockerfile(outputRoot)
  }

  finalizeCloudflareWranglerConfig({ cloudflare: { wrangler: wranglerConfig } } as never)
  await writeFile(resolve(outputRoot, "wrangler.json"), `${JSON.stringify(wranglerConfig, null, 2)}\n`, "utf8")
}

async function writeVercelOutput(options: ViteE2EComposerOptions, artifacts: GeneratedFeatureArtifacts) {
  const clientDir = resolve(options.rootDir, options.clientOutDir)
  const outputRoot = resolve(options.rootDir, ".vercel", "output")
  const serverDir = resolve(outputRoot, "functions", "__server.func")
  const functionsRoot = resolve(outputRoot, "functions")
  const sourceEntry = resolve(artifacts.generatedDir, "vercel-entry.mjs")
  const staticIndex = hasStaticIndex(clientDir)

  await writeFile(sourceEntry, renderVercelEntry(sourceEntry, options, artifacts), "utf8")
  await rm(outputRoot, { force: true, recursive: true })
  await mkdir(serverDir, { recursive: true })

  await bundleEsmEntry(sourceEntry, resolve(serverDir, "index.mjs"), {
    alias: withoutCloudflareWorkspaceAliases(artifacts.alias),
    external: [
      "@vercel/blob",
      "askweb",
      "cloudflare:workers",
      "files-sdk",
      "files-sdk/akamai",
      "files-sdk/azure",
      "files-sdk/box",
      "files-sdk/digitalocean-spaces",
      "files-sdk/dropbox",
      "files-sdk/fs",
      "files-sdk/gcs",
      "files-sdk/google-drive",
      "files-sdk/hetzner",
      "files-sdk/minio",
      "files-sdk/netlify-blobs",
      "files-sdk/onedrive",
      "files-sdk/r2",
      "files-sdk/s3",
      "files-sdk/storj",
      "files-sdk/supabase",
      "files-sdk/uploadthing",
      "files-sdk/vercel-blob",
      "isomorphic-git",
      "isomorphic-git/http/web",
      "workflow",
      "workflow/api",
      "workflow/runtime",
    ],
    format: "esm",
    platform: "node",
  })

  const vercelConfig = createVercelConfigJson() as ReturnType<typeof createVercelConfigJson> & { crons?: Array<{ path: string, schedule: string }> }
  if (artifacts.scheduleDefinitions.length) {
    vercelConfig.crons = artifacts.scheduleDefinitions.map(definition => ({
      path: getVercelSchedulePath(definition.name),
      schedule: artifacts.scheduleCrons.get(definition.name)!,
    }))
  }

  await Promise.all([
    writeFile(resolve(serverDir, ".vc-config.json"), `${JSON.stringify(createNodeFunctionConfig(), null, 2)}\n`, "utf8"),
    writeFile(resolve(outputRoot, "config.json"), `${JSON.stringify(vercelConfig, null, 2)}\n`, "utf8"),
    staticIndex ? copyClientOutput(clientDir, resolve(outputRoot, "static")) : Promise.resolve(),
  ])

  const scheduleRegistryFile = artifacts.scheduleRegistryFile
  if (artifacts.scheduleDefinitions.length && scheduleRegistryFile) {
    const scheduleRoot = resolve(outputRoot, "functions", "api", "vitehub", "schedules", "vercel")
    const seen = new Set<string>()
    await Promise.all(artifacts.scheduleDefinitions.map(async (definition) => {
      const safeName = definition.name.replace(/[^a-z0-9/_-]+/gi, "_")
      const segments = safeName.split("/")
      const functionDir = resolve(scheduleRoot, ...segments.slice(0, -1), `${segments.at(-1)}.func`)
      if (seen.has(functionDir)) {
        throw new Error(`[vitehub] Conflicting Vercel schedule output for "${definition.name}".`)
      }
      seen.add(functionDir)
      const functionSource = resolve(functionDir, "index.source.mjs")
      await mkdir(functionDir, { recursive: true })
      await writeFile(functionSource, renderVercelScheduleWrapper(functionSource, scheduleRegistryFile, definition.name), "utf8")
      await bundleEsmEntry(functionSource, resolve(functionDir, "index.mjs"), {
        alias: withoutCloudflareWorkspaceAliases(artifacts.alias),
        format: "esm",
        platform: "node",
      })
      await Promise.all([
        rm(functionSource, { force: true }),
        writeFile(resolve(functionDir, ".vc-config.json"), `${JSON.stringify(createNodeFunctionConfig(), null, 2)}\n`, "utf8"),
      ])
    }))
  }

  const queueRegistryFile = artifacts.queueRegistryFile
  if (!artifacts.queueDefinitions.length || !queueRegistryFile) return

  const queueRoot = resolve(outputRoot, "functions", "api", "vitehub", "queues", "vercel")
  const queueFunctionDirs = artifacts.queueDefinitions.map((definition) => {
    const safeName = definition.name.replace(/[^a-z0-9/_-]+/gi, "_")
    const segments = safeName.split("/")
    return { definition, dir: resolve(queueRoot, ...segments, `${segments.at(-1)}.func`) }
  })

  const seen = new Set<string>()
  for (const { definition, dir } of queueFunctionDirs) {
    if (seen.has(dir)) {
      throw new Error(`[vitehub] Conflicting Vercel queue callback output for "${definition.name}".`)
    }
    seen.add(dir)
  }

  await Promise.all(queueFunctionDirs.map(async ({ definition, dir: functionDir }) => {
    const functionSource = resolve(functionDir, "index.source.mjs")
    const functionPath = relative(functionsRoot, functionDir).replace(/\\/g, "/")
    const consumer = sanitizeVercelConsumerName(functionPath)
    await mkdir(functionDir, { recursive: true })
    await writeFile(functionSource, renderVercelQueueWrapper(functionSource, queueRegistryFile, definition.name, options.queue), "utf8")
    await bundleEsmEntry(functionSource, resolve(functionDir, "index.mjs"), {
      format: "esm",
      platform: "node",
    })
    await Promise.all([
      rm(functionSource, { force: true }),
      writeFile(resolve(functionDir, ".vc-config.json"), `${JSON.stringify(createNodeFunctionConfig({
        memory: 1024,
        supportsResponseStreaming: false,
        ...(options.queue && options.queue.provider === "vercel"
          ? {
              experimentalTriggers: [{
                consumer,
                topic: getVercelQueueTopicName(definition.name),
                type: "queue/v2beta",
              }],
            }
          : {}),
      }), null, 2)}\n`, "utf8"),
    ])
  }))
}

async function generateViteE2EOutputs(options: ViteE2EComposerOptions): Promise<void> {
  const artifacts = await prepareFeatureArtifacts(options)

  if (options.hosting === "cloudflare") {
    await writeCloudflareOutput(options, artifacts)
    return
  }

  await writeVercelOutput(options, artifacts)
}

export function createViteE2EComposer(options: ViteE2EComposerOptions): Plugin {
  let resolvedAlias: Record<string, string> | undefined

  return {
    name: "vitehub/vite-e2e",
    async config() {
      const artifacts = await prepareFeatureArtifacts(options)
      resolvedAlias = artifacts.alias
      return {
        resolve: {
          alias: resolvedAlias,
        },
      }
    },
    async closeBundle() {
      await generateViteE2EOutputs(options)
    },
  }
}

export function resolveViteE2EOptions(rootDir: string, hosting: string) {
  const provider = resolveHostedProvider(hosting)
  return {
    blob: normalizeBlobOptions(undefined, { hosting }),
    db: resolveDBViteConfig({
      connection: {
        authToken: process.env.TURSO_AUTH_TOKEN,
        url: process.env.TURSO_DATABASE_URL,
      },
      databases: {
        analytics: {
          connection: {
            authToken: process.env.TURSO_AUTH_TOKEN,
            url: process.env.TURSO_ANALYTICS_DATABASE_URL || process.env.TURSO_DATABASE_URL,
          },
          cloudflare: {
            binding: "DB_ANALYTICS",
            databaseName: process.env.VITEHUB_D1_ANALYTICS_DATABASE_NAME || "vitehub-playground-analytics",
            databaseId: process.env.VITEHUB_D1_ANALYTICS_DATABASE_ID,
            previewDatabaseId: process.env.VITEHUB_D1_ANALYTICS_PREVIEW_DATABASE_ID,
          },
        },
      },
      cloudflare: {
        binding: "DB",
        databaseName: process.env.VITEHUB_D1_DATABASE_NAME || "vitehub-playground-db",
        databaseId: process.env.VITEHUB_D1_DATABASE_ID,
        previewDatabaseId: process.env.VITEHUB_D1_PREVIEW_DATABASE_ID,
      },
    }, rootDir),
    hosting: provider,
    kv: normalizeKVOptions(undefined, { hosting }),
    queue: normalizeQueueOptions({}, { hosting }) || false,
    schedule: true,
    sandbox: resolveSandboxFeatureConfig({}, hosting),
    workspace: normalizeWorkspaceOptions({}, { env: process.env, hosting, rootDir }),
    workflow: normalizeWorkflowOptions({}, { hosting }) || false,
  }
}
