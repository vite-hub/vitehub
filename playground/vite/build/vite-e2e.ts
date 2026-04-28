import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { normalizeBlobOptions } from "../../../packages/blob/src/config.ts"
import { resolveDBViteConfig } from "../../../packages/db/src/config.ts"
import { configureCloudflareKV } from "../../../packages/kv/src/integrations/cloudflare.ts"
import { normalizeKVOptions } from "../../../packages/kv/src/config.ts"
import { normalizeQueueOptions } from "../../../packages/queue/src/config.ts"
import { discoverQueueDefinitions } from "../../../packages/queue/src/discovery.ts"
import { getCloudflareQueueBindingName, getCloudflareQueueDefinitionName, getCloudflareQueueName } from "../../../packages/queue/src/integrations/cloudflare.ts"
import { getVercelQueueTopicName } from "../../../packages/queue/src/integrations/vercel.ts"
import { defaultCloudflareSandboxBinding, defaultCloudflareSandboxClassName, defaultCloudflareSandboxMigrationTag, configureCloudflareSandbox, writeCloudflareSandboxDockerfile } from "../../../packages/sandbox/src/cloudflare.ts"
import { extractSandboxDefinitionOptions } from "../../../packages/sandbox/src/definition-options.ts"
import { discoverNitroSandboxDefinitions } from "../../../packages/sandbox/src/discovery.ts"
import { bundleSandboxDefinition } from "../../../packages/sandbox/src/bundle.ts"
import { resolveSandboxFeatureConfig } from "../../../packages/sandbox/src/feature.ts"
import { finalizeCloudflareWranglerConfig } from "../../../packages/sandbox/src/internal/shared/cloudflare-wrangler.ts"
import { normalizeWorkflowOptions } from "../../../packages/workflow/src/config.ts"
import { discoverWorkflowDefinitions } from "../../../packages/workflow/src/discovery.ts"
import { createCloudflareWorkflowBindings, getCloudflareWorkflowClassName } from "../../../packages/workflow/src/integrations/cloudflare.ts"
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
import type { ResolvedWorkflowOptions } from "../../../packages/workflow/src/types.ts"
import type { Plugin } from "vite"

const currentDir = dirname(fileURLToPath(import.meta.url))
const workspaceDir = resolve(currentDir, "../../..")
const packagesDir = resolve(workspaceDir, "packages")
const blobPackageDir = resolve(packagesDir, "blob")
const dbPackageDir = resolve(packagesDir, "db")
const kvPackageDir = resolve(packagesDir, "kv")
const queuePackageDir = resolve(packagesDir, "queue")
const sandboxPackageDir = resolve(packagesDir, "sandbox")
const workflowPackageDir = resolve(packagesDir, "workflow")
const viteE2EProductName = "vite-e2e"

type HostedProvider = "cloudflare" | "vercel"

export interface ViteE2EComposerOptions {
  blob?: false | ResolvedBlobModuleOptions
  clientOutDir: string
  db?: ResolvedDBViteConfig
  hosting: string
  kv?: false | ResolvedKVModuleOptions
  rootDir: string
  sandbox?: false | AgentSandboxConfig
  queue?: false | ResolvedQueueOptions
  workflow?: false | ResolvedWorkflowOptions
}

interface CloudflareWranglerConfig {
  assets?: { directory?: string, run_worker_first: string[] }
  compatibility_date: string
  compatibility_flags: string[]
  containers?: Array<Record<string, unknown>>
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
  workflows?: Array<{ binding: string, class_name: string, name: string }>
}

interface GeneratedFeatureArtifacts {
  alias: Record<string, string>
  generatedDir: string
  queueDefinitions: Array<{ name: string, handler: string }>
  queueRegistryFile?: string
  sandboxConfig?: false | AgentSandboxConfig
  workflowBindings: Array<{ binding: string, class_name: string, name: string }>
  workflowRegistryFile?: string
}

function resolveHostedProvider(hosting: string): HostedProvider {
  if (hosting.includes("cloudflare")) return "cloudflare"
  if (hosting.includes("vercel")) return "vercel"
  throw new TypeError(`[vitehub] Unsupported hosted e2e provider: ${hosting || "<empty>"}`)
}

function resolvePackageRuntime(packageDir: string, modulePath: string) {
  return resolve(packageDir, "src", `${modulePath}.ts`)
}

function resolvePackageDependency(packageDir: string, specifier: string) {
  return createRequire(resolve(packageDir, "package.json")).resolve(specifier)
}

function serializeDbSchemaModule(schemaPaths: string[]) {
  const imports = schemaPaths.map((file, index) => `import * as schema${index} from ${JSON.stringify(file)};`)
  const exports = schemaPaths.map(file => `export * from ${JSON.stringify(file)};`)
  const refs = schemaPaths.map((_, index) => `schema${index}`)

  return [
    ...imports,
    ...exports,
    `const schema = Object.assign({}, ${refs.join(", ")});`,
    "export { schema };",
    "export default schema;",
    "",
  ].join("\n")
}

function renderDbRuntimeModule(file: string, config: ResolvedDBViteConfig) {
  return [
    `import { createHostedDrizzleDb } from ${JSON.stringify(createImportPath(file, resolvePackageRuntime(dbPackageDir, "runtime/hosted")))}`,
    "",
    serializeDbSchemaModule(config.schemaPaths),
    `const dbConfig = ${JSON.stringify(config.db, null, 2)}`,
    "",
    "export const db = createHostedDrizzleDb(dbConfig, schema)",
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

function renderSandboxRuntimeModule(file: string) {
  return [
    `export { defineSandbox } from ${JSON.stringify(createImportPath(file, resolvePackageRuntime(sandboxPackageDir, "runtime/registry")))}`,
    `export { runSandbox } from ${JSON.stringify(createImportPath(file, resolvePackageRuntime(sandboxPackageDir, "runtime/public")))}`,
    `export { readValidatedPayload, validatePayload } from ${JSON.stringify(createImportPath(file, resolvePackageRuntime(sandboxPackageDir, "runtime/validation")))}`,
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
  const workflowDefinitions = options.workflow
    ? discoverWorkflowDefinitions({ mode: "nitro-server-workflows", scanDirs: [resolve(options.rootDir, "server")] })
    : []
  const sandboxDefinitions = options.sandbox
    ? discoverNitroSandboxDefinitions([resolve(options.rootDir, "server")])
    : []

  let queueRegistryFile: string | undefined
  if (queueDefinitions.length) {
    queueRegistryFile = resolve(generatedDir, "queue-registry.mjs")
    await writeFile(queueRegistryFile, createRuntimeRegistryContents(queueRegistryFile, queueDefinitions), "utf8")
  }

  let workflowRegistryFile: string | undefined
  if (workflowDefinitions.length) {
    workflowRegistryFile = resolve(generatedDir, "workflow-registry.mjs")
    await writeFile(workflowRegistryFile, createRuntimeRegistryContents(workflowRegistryFile, workflowDefinitions), "utf8")
  }

  if (options.db) {
    const dbRuntimeFile = resolve(generatedDir, "db-runtime.mjs")
    await writeFile(dbRuntimeFile, renderDbRuntimeModule(dbRuntimeFile, options.db), "utf8")
    alias["@vitehub/db/drizzle"] = dbRuntimeFile
  }

  if (typeof options.blob !== "undefined") {
    const blobRuntimeFile = resolve(generatedDir, "blob-runtime.mjs")
    await writeFile(blobRuntimeFile, renderBlobRuntimeModule(blobRuntimeFile, options.blob), "utf8")
    alias["@vitehub/blob"] = blobRuntimeFile
  }

  if (typeof options.kv !== "undefined") {
    const kvRuntimeFile = resolve(generatedDir, "kv-runtime.mjs")
    await writeFile(kvRuntimeFile, renderKvRuntimeModule(kvRuntimeFile, options.kv), "utf8")
    alias["@vitehub/kv"] = kvRuntimeFile
  }

  if (typeof options.queue !== "undefined") {
    const queueRuntimeFile = resolve(generatedDir, "queue-runtime.mjs")
    await writeFile(queueRuntimeFile, renderQueueRuntimeModule(queueRuntimeFile), "utf8")
    alias["@vitehub/queue"] = queueRuntimeFile
  }

  if (typeof options.sandbox !== "undefined") {
    const sandboxRuntimeFile = resolve(generatedDir, "sandbox-runtime.mjs")
    await writeFile(sandboxRuntimeFile, renderSandboxRuntimeModule(sandboxRuntimeFile), "utf8")
    alias["@vitehub/sandbox"] = sandboxRuntimeFile
  }

  if (typeof options.workflow !== "undefined") {
    const workflowRuntimeFile = resolve(generatedDir, "workflow-runtime.mjs")
    await writeFile(workflowRuntimeFile, renderWorkflowRuntimeModule(workflowRuntimeFile), "utf8")
    alias["@vitehub/workflow"] = workflowRuntimeFile
  }

  let sandboxConfig: false | AgentSandboxConfig | undefined
  if (options.sandbox) {
    sandboxConfig = resolveSandboxFeatureConfig(options.sandbox, options.hosting)
    const sandboxProvider = sandboxConfig.provider === "vercel" ? "vercel" : "cloudflare"
    const emittedDefinitions: Array<{ file: string, name: string }> = []

    for (const definition of sandboxDefinitions) {
      const source = await readFile(definition._meta.sourcePath, "utf8")
      const bundle = await bundleSandboxDefinition(source, definition._meta.sourcePath)
      const file = resolve(generatedDir, "runtime", "sandbox-definitions", `${toSandboxArtifactName(definition.name)}.mjs`)
      const definitionOptions = await extractSandboxDefinitionOptions(definition.handler)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, `export default ${JSON.stringify({ bundle, options: definitionOptions ?? undefined })}\n`, "utf8")
      emittedDefinitions.push({ file, name: definition.name })
    }

    const sandboxRegistryFile = resolve(generatedDir, "runtime", "sandbox-registry.mjs")
    await writeFile(sandboxRegistryFile, renderSandboxRegistryModule(emittedDefinitions), "utf8")

    const sandboxProviderLoaderFile = resolve(generatedDir, "runtime", "sandbox-provider-loader.mjs")
    await writeFile(sandboxProviderLoaderFile, renderSandboxProviderLoaderModule(sandboxProviderLoaderFile, sandboxProvider), "utf8")

    alias["virtual:vitehub-sandbox-registry"] = sandboxRegistryFile
    alias["#vitehub-sandbox-registry"] = sandboxRegistryFile
    alias["virtual:vitehub-sandbox-provider-loader"] = sandboxProviderLoaderFile
    alias["#vitehub-sandbox-provider-loader"] = sandboxProviderLoaderFile

    if (sandboxProvider === "cloudflare") {
      alias["@cloudflare/sandbox"] = resolvePackageDependency(sandboxPackageDir, "@cloudflare/sandbox")
    }
  }

  return {
    alias,
    generatedDir,
    queueDefinitions,
    queueRegistryFile,
    sandboxConfig,
    workflowBindings: createCloudflareWorkflowBindings(workflowDefinitions, options.workflow) || [],
    workflowRegistryFile,
  } satisfies GeneratedFeatureArtifacts
}

function renderCloudflareEntry(file: string, options: ViteE2EComposerOptions, artifacts: GeneratedFeatureArtifacts) {
  const appEntry = resolve(options.rootDir, "src/server.e2e.ts")
  const resolveApp = resolve(packagesDir, "internal/src/runtime/app.ts")
  const cloudflareEnv = resolve(packagesDir, "internal/src/runtime/cloudflare-env.ts")

  const imports = [
    `import { H3, toWebHandler } from "h3"`,
    `import { resolveAppFetch } from ${JSON.stringify(createImportPath(file, resolveApp))}`,
    `import { clearActiveCloudflareEnv, createCloudflareRuntimeEvent, runWithActiveCloudflareEnv, setActiveCloudflareEnv } from ${JSON.stringify(createImportPath(file, cloudflareEnv))}`,
    `import app from ${JSON.stringify(createImportPath(file, appEntry))}`,
    `import { createCloudflareQueueBatchHandler } from ${JSON.stringify(createImportPath(file, resolve(queuePackageDir, "src/providers/cloudflare.ts")))}`,
    `import { getCloudflareQueueDefinitionName } from ${JSON.stringify(createImportPath(file, resolve(queuePackageDir, "src/integrations/cloudflare.ts")))}`,
    `import { createQueueJob } from ${JSON.stringify(createImportPath(file, resolve(queuePackageDir, "src/runtime/cloudflare-shared.ts")))}`,
    `import { loadQueueDefinition, runWithQueueRuntimeEvent, setQueueRuntimeConfig, setQueueRuntimeRegistry } from ${JSON.stringify(createImportPath(file, resolve(queuePackageDir, "src/runtime/state.ts")))}`,
    `import { runCloudflareWorkflow } from ${JSON.stringify(createImportPath(file, resolve(workflowPackageDir, "src/runtime/cloudflare-runner.ts")))}`,
    `import { runWithWorkflowRuntimeEvent, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from ${JSON.stringify(createImportPath(file, resolve(workflowPackageDir, "src/runtime/state.ts")))}`,
    `import { setBlobRuntimeConfig } from ${JSON.stringify(createImportPath(file, resolve(blobPackageDir, "src/runtime/state.ts")))}`,
    `import { setSandboxRuntimeConfig, setSandboxRuntimeRegistry } from ${JSON.stringify(createImportPath(file, resolve(sandboxPackageDir, "src/runtime/state.ts")))}`,
  ]

  if (artifacts.queueRegistryFile) {
    imports.push(`import queueRegistry from ${JSON.stringify(createImportPath(file, artifacts.queueRegistryFile))}`)
  }
  if (artifacts.workflowRegistryFile) {
    imports.push(`import workflowRegistry from ${JSON.stringify(createImportPath(file, artifacts.workflowRegistryFile))}`)
  }
  if (artifacts.alias["virtual:vitehub-sandbox-registry"]) {
    imports.push(`import sandboxRegistry from ${JSON.stringify(createImportPath(file, artifacts.alias["virtual:vitehub-sandbox-registry"]))}`)
  }
  if (artifacts.workflowBindings.length) {
    imports.push(`import { WorkflowEntrypoint } from "cloudflare:workers"`)
  }
  if (artifacts.sandboxConfig && options.sandbox) {
    imports.push(`import { Sandbox as CloudflareSandbox } from "@cloudflare/sandbox"`)
  }

  const workflowClassExports = artifacts.workflowBindings.map((binding) => [
    `export class ${binding.class_name || getCloudflareWorkflowClassName(binding.name)} extends WorkflowEntrypoint {`,
    "  async run(event, step) {",
    `    return await runCloudflareWorkflow({ config: workflowConfig, env: this.env || {}, event, name: ${JSON.stringify(binding.name)}, registry: workflowRegistry, step })`,
    "  }",
    "}",
    "",
  ].join("\n"))

  return [
    ...imports,
    "",
    `const queueConfig = ${JSON.stringify(options.queue || false, null, 2)}`,
    `const workflowConfig = ${JSON.stringify(options.workflow || false, null, 2)}`,
    `const blobConfig = ${JSON.stringify(options.blob || false, null, 2)}`,
    `const sandboxConfig = ${JSON.stringify(artifacts.sandboxConfig || false, null, 2)}`,
    "setQueueRuntimeConfig(queueConfig)",
    `setQueueRuntimeRegistry(${artifacts.queueRegistryFile ? "queueRegistry" : "undefined"})`,
    "setWorkflowRuntimeConfig(workflowConfig)",
    `setWorkflowRuntimeRegistry(${artifacts.workflowRegistryFile ? "workflowRegistry" : "undefined"})`,
    "setBlobRuntimeConfig(blobConfig)",
    "setSandboxRuntimeConfig(sandboxConfig)",
    `setSandboxRuntimeRegistry(${artifacts.alias["virtual:vitehub-sandbox-registry"] ? "sandboxRegistry" : "undefined"})`,
    "const defaultHandler = toWebHandler(new H3())",
    "const appHandler = resolveAppFetch('vitehub', app)",
    "",
    ...workflowClassExports,
    artifacts.sandboxConfig && options.sandbox
      ? `export class ${typeof (artifacts.sandboxConfig as { className?: string }).className === "string" ? (artifacts.sandboxConfig as { className?: string }).className : defaultCloudflareSandboxClassName} extends CloudflareSandbox {}`
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
    "}",
    "",
    "export default worker",
    "",
  ].filter(Boolean).join("\n")
}

function renderVercelEntry(file: string, options: ViteE2EComposerOptions, artifacts: GeneratedFeatureArtifacts) {
  const appEntry = resolve(options.rootDir, "src/server.e2e.ts")
  const resolveApp = resolve(packagesDir, "internal/src/runtime/app.ts")

  const imports = [
    `import { waitUntil as vercelWaitUntil } from ${JSON.stringify(createImportPath(file, resolvePackageDependency(queuePackageDir, "@vercel/functions")))}`,
    `import { H3, fromWebHandler } from "h3"`,
    `import { toNodeHandler } from "h3/node"`,
    `import { resolveAppFetch } from ${JSON.stringify(createImportPath(file, resolveApp))}`,
    `import { setQueueRuntimeConfig, setQueueRuntimeRegistry, runWithQueueRuntimeEvent } from ${JSON.stringify(createImportPath(file, resolve(queuePackageDir, "src/runtime/state.ts")))}`,
    `import { setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry, runWithWorkflowRuntimeEvent } from ${JSON.stringify(createImportPath(file, resolve(workflowPackageDir, "src/runtime/state.ts")))}`,
    `import { setBlobRuntimeConfig } from ${JSON.stringify(createImportPath(file, resolve(blobPackageDir, "src/runtime/state.ts")))}`,
    `import { setSandboxRuntimeConfig, setSandboxRuntimeRegistry } from ${JSON.stringify(createImportPath(file, resolve(sandboxPackageDir, "src/runtime/state.ts")))}`,
    `import app from ${JSON.stringify(createImportPath(file, appEntry))}`,
  ]

  if (artifacts.queueRegistryFile) {
    imports.push(`import queueRegistry from ${JSON.stringify(createImportPath(file, artifacts.queueRegistryFile))}`)
  }
  if (artifacts.workflowRegistryFile) {
    imports.push(`import workflowRegistry from ${JSON.stringify(createImportPath(file, artifacts.workflowRegistryFile))}`)
  }
  if (artifacts.alias["virtual:vitehub-sandbox-registry"]) {
    imports.push(`import sandboxRegistry from ${JSON.stringify(createImportPath(file, artifacts.alias["virtual:vitehub-sandbox-registry"]))}`)
  }

  return [
    ...imports,
    "",
    `const queueConfig = ${JSON.stringify(options.queue || false, null, 2)}`,
    `const workflowConfig = ${JSON.stringify(options.workflow || false, null, 2)}`,
    `const blobConfig = ${JSON.stringify(options.blob || false, null, 2)}`,
    `const sandboxConfig = ${JSON.stringify(artifacts.sandboxConfig || false, null, 2)}`,
    "setQueueRuntimeConfig(queueConfig)",
    `setQueueRuntimeRegistry(${artifacts.queueRegistryFile ? "queueRegistry" : "undefined"})`,
    "setWorkflowRuntimeConfig(workflowConfig)",
    `setWorkflowRuntimeRegistry(${artifacts.workflowRegistryFile ? "workflowRegistry" : "undefined"})`,
    "setBlobRuntimeConfig(blobConfig)",
    "setSandboxRuntimeConfig(sandboxConfig)",
    `setSandboxRuntimeRegistry(${artifacts.alias["virtual:vitehub-sandbox-registry"] ? "sandboxRegistry" : "undefined"})`,
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
  ].join("\n")
}

function renderVercelQueueWrapper(file: string, queueRegistryFile: string, definitionName: string, queueConfig: false | ResolvedQueueOptions | undefined) {
  return [
    "import { H3 } from 'h3'",
    "import { toNodeHandler } from 'h3/node'",
    `import { handleHostedVercelQueueCallback, hostedVercelWaitUntil } from ${JSON.stringify(createImportPath(file, resolve(queuePackageDir, "src/runtime/hosted.ts")))}`,
    `import { loadQueueDefinition, runWithQueueRuntimeEvent, setQueueRuntimeConfig, setQueueRuntimeRegistry } from ${JSON.stringify(createImportPath(file, resolve(queuePackageDir, "src/runtime/state.ts")))}`,
    `import queueRegistry from ${JSON.stringify(createImportPath(file, queueRegistryFile))}`,
    "",
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
  ].join("\n")
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

async function writeCloudflareOutput(options: ViteE2EComposerOptions, artifacts: GeneratedFeatureArtifacts) {
  const clientDir = resolve(options.rootDir, options.clientOutDir)
  const outputRoot = resolve(options.rootDir, "dist", toSafeAppName(options.rootDir))
  const workerEntry = resolve(artifacts.generatedDir, "cloudflare-entry.mjs")
  const staticIndex = hasStaticIndex(clientDir)

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
      "cloudflare:workers",
      "node:async_hooks",
      "node:path/posix",
      "workflow",
      "workflow/api",
      "workflow/runtime",
    ],
    format: "esm",
    platform: "neutral",
  })

  const wranglerConfig: CloudflareWranglerConfig = {
    compatibility_date: "2026-04-20",
    compatibility_flags: ["nodejs_compat"],
    main: "index.js",
    name: toSafeAppName(options.rootDir),
    observability: { enabled: true },
    ...(staticIndex ? { assets: { directory: "../client", run_worker_first: ["/api/*"] } } : {}),
    ...(createCloudflareQueueBindings(artifacts.queueDefinitions) ? { queues: createCloudflareQueueBindings(artifacts.queueDefinitions) } : {}),
    ...(artifacts.workflowBindings.length ? { workflows: artifacts.workflowBindings } : {}),
    ...(createCloudflareR2Bindings(options.blob) ? { r2_buckets: createCloudflareR2Bindings(options.blob) } : {}),
  }

  if (options.kv) {
    configureCloudflareKV({ cloudflare: { wrangler: wranglerConfig } as never }, options.kv)
  }

  if (artifacts.sandboxConfig && artifacts.sandboxConfig.provider === "cloudflare") {
    configureCloudflareSandbox({ cloudflare: { wrangler: wranglerConfig } as never }, {
      binding: typeof artifacts.sandboxConfig.binding === "string" ? artifacts.sandboxConfig.binding : defaultCloudflareSandboxBinding,
      className: typeof artifacts.sandboxConfig.className === "string" ? artifacts.sandboxConfig.className : defaultCloudflareSandboxClassName,
      migrationTag: typeof artifacts.sandboxConfig.migrationTag === "string" ? artifacts.sandboxConfig.migrationTag : defaultCloudflareSandboxMigrationTag,
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
  const sourceEntry = resolve(artifacts.generatedDir, "vercel-entry.mjs")
  const staticIndex = hasStaticIndex(clientDir)

  await writeFile(sourceEntry, renderVercelEntry(sourceEntry, options, artifacts), "utf8")
  await rm(outputRoot, { force: true, recursive: true })
  await mkdir(serverDir, { recursive: true })

  await bundleEsmEntry(sourceEntry, resolve(serverDir, "index.mjs"), {
    alias: artifacts.alias,
    external: [
      "cloudflare:workers",
      "workflow",
      "workflow/api",
      "workflow/runtime",
    ],
    format: "esm",
    platform: "node",
  })

  await writeFile(resolve(serverDir, ".vc-config.json"), `${JSON.stringify(createNodeFunctionConfig(), null, 2)}\n`, "utf8")
  await writeFile(resolve(outputRoot, "config.json"), `${JSON.stringify(createVercelConfigJson(), null, 2)}\n`, "utf8")

  if (staticIndex) {
    await copyClientOutput(clientDir, resolve(outputRoot, "static"))
  }

  if (!artifacts.queueDefinitions.length || !artifacts.queueRegistryFile) return

  const queueRoot = resolve(outputRoot, "functions", "api", "vitehub", "queues", "vercel")
  const functionDirs = new Set<string>()

  for (const definition of artifacts.queueDefinitions) {
    const safeName = definition.name.replace(/[^a-z0-9/_-]+/gi, "_")
    const segments = safeName.split("/")
    const functionDir = resolve(queueRoot, ...segments, `${segments.at(-1)}.func`)
    if (functionDirs.has(functionDir)) {
      throw new Error(`[vitehub] Conflicting Vercel queue callback output for "${definition.name}".`)
    }
    functionDirs.add(functionDir)

    const functionSource = resolve(functionDir, "index.source.mjs")
    await mkdir(functionDir, { recursive: true })
    await writeFile(functionSource, renderVercelQueueWrapper(functionSource, artifacts.queueRegistryFile, definition.name, options.queue), "utf8")
    await bundleEsmEntry(functionSource, resolve(functionDir, "index.mjs"), {
      format: "esm",
      platform: "node",
    })
    await rm(functionSource, { force: true })
    await writeFile(resolve(functionDir, ".vc-config.json"), `${JSON.stringify(createNodeFunctionConfig({
      memory: 1024,
      supportsResponseStreaming: false,
      ...(options.queue && options.queue.provider === "vercel"
        ? { topics: [{ name: getVercelQueueTopicName(definition.name) }] }
        : {}),
    }), null, 2)}\n`, "utf8")
  }
}

export async function generateViteE2EOutputs(options: ViteE2EComposerOptions): Promise<void> {
  const provider = resolveHostedProvider(options.hosting)
  const artifacts = await prepareFeatureArtifacts(options)

  if (provider === "cloudflare") {
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
  return {
    blob: normalizeBlobOptions(undefined, { hosting }),
    db: resolveDBViteConfig({
      connection: {
        authToken: process.env.TURSO_AUTH_TOKEN,
        url: process.env.TURSO_DATABASE_URL,
      },
    }, rootDir),
    kv: normalizeKVOptions(undefined, { hosting }),
    queue: normalizeQueueOptions({}, { hosting }) || false,
    sandbox: resolveSandboxFeatureConfig({}, hosting),
    workflow: normalizeWorkflowOptions({}, { hosting }) || false,
  }
}
