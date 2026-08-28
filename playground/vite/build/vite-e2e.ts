import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { normalizeBlobOptions } from "../../../packages/blob/src/config.ts"
import { resolveDBViteConfig } from "../../../packages/database/src/config.ts"
import { resolveCloudflareD1Bindings } from "../../../packages/database/src/internal/cloudflare.ts"
import { configureCloudflareKV } from "../../../packages/kv/src/integrations/cloudflare.ts"
import { normalizeKVOptions } from "../../../packages/kv/src/config.ts"
import { normalizeQueueOptions } from "../../../packages/queue/src/config.ts"
import { discoverQueueDefinitions } from "../../../packages/queue/src/discovery.ts"
import { getCloudflareQueueBindingName } from "../../../packages/queue/src/integrations/cloudflare.ts"
import { getCloudflareQueueName } from "../../../packages/queue/src/internal/cloudflare-resource-name.ts"
import { getVercelQueueTopicName } from "../../../packages/queue/src/integrations/vercel.ts"
import { discoverRateLimitCatalog } from "../../../packages/rate-limit/src/discovery.ts"
import { createCloudflareRateLimitBindings } from "../../../packages/rate-limit/src/internal/provider-output.ts"
import { discoverScheduleDefinitions } from "../../../packages/schedule/src/discovery.ts"
import { getVercelSchedulePath } from "../../../packages/schedule/src/integrations/vercel.ts"
import { readDefinitionCrons } from "../../../packages/schedule/src/internal/provider-output.ts"
import { defaultCloudflareSandboxBinding, defaultCloudflareSandboxClassName, defaultCloudflareSandboxMigrationTag, configureCloudflareSandbox, writeCloudflareSandboxDockerfile } from "../../../packages/sandbox/src/cloudflare.ts"
import { resolveSandboxProject } from "../../../packages/sandbox/src/project.ts"
import { discoverServerSandboxDefinitions } from "../../../packages/sandbox/src/discovery.ts"
import { bundleSandboxDefinition } from "../../../packages/sandbox/src/bundle.ts"
import { resolveSandboxFeatureConfig, sandboxProviderRuntimeExport } from "../../../packages/sandbox/src/feature.ts"
import { finalizeCloudflareWranglerConfig } from "../../../packages/sandbox/src/internal/shared/cloudflare-wrangler.ts"
import { normalizeWorkspaceOptions } from "../../../packages/workspace/src/config.ts"
import { discoverViteWorkspaceDefinitions } from "../../../packages/workspace/src/build/discovery.ts"
import { configureCloudflareArtifacts } from "../../../packages/workspace/src/integrations/cloudflare.ts"
import { normalizeWorkflowOptions } from "../../../packages/workflow/src/config.ts"
import { discoverWorkflowDefinitions } from "../../../packages/workflow/src/discovery.ts"
import { createWorkflowRegistryContents } from "../../../packages/workflow/src/internal/vite-build.ts"
import { createCloudflareWorkflowBindings, getCloudflareWorkflowClassName } from "../../../packages/workflow/src/integrations/cloudflare.ts"
import { defaultCloudflareCompatibilityDate } from "@vite-hub/internal/build/cloudflare"
import { copyClientOutput, hasStaticIndex } from "@vite-hub/internal/build/client-output"
import { bundleEsmEntry } from "@vite-hub/internal/build/esbuild"
import { createImportPath, ensureGeneratedDir } from "@vite-hub/internal/build/paths"
import { toSafeAppName } from "@vite-hub/internal/build/user-entry"
import { createNodeFunctionConfig, createVercelConfigJson } from "@vite-hub/internal/build/vercel-config"
import { createRuntimeRegistryContents } from "@vite-hub/internal/definition-discovery"
import { readProvisionStateSync } from "@vite-hub/internal/provision-state"

import type { ResolvedBlobModuleOptions } from "../../../packages/blob/src/types.ts"
import type { ResolvedDBViteConfig } from "../../../packages/database/src/types.ts"
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
const dbPackageDir = resolve(packagesDir, "database")
const kvPackageDir = resolve(packagesDir, "kv")
const queuePackageDir = resolve(packagesDir, "queue")
const rateLimitPackageDir = resolve(packagesDir, "rate-limit")
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
  rateLimit?: false | { namespace: string }
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
  ratelimits?: Array<Record<string, unknown>>
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
  rateLimitDeclarations: ReturnType<typeof discoverRateLimitCatalog>["declarations"]
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

function resolveIsomorphicGitDependency(specifier: string) {
  return createRequire(resolveIsomorphicGitEsmEntry()).resolve(specifier)
}

function resolveSandboxClassName(config: { className?: unknown } | undefined) {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The playground accepts provider configuration at this runtime boundary.
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
  const schemaImports = config.databaseNames.map((name, index) =>
    `import schema_${index} from ${JSON.stringify(createImportPath(file, config.generatedSchemaFilesByDatabase[name]!))}`)
  const databaseEntries = config.databaseNames.map((name, index) => [
    `  ${JSON.stringify(name)}: {`,
    `    db: createHostedDrizzleDb(${JSON.stringify(config.databases[name], null, 4)}, schema_${index}),`,
    `    schema: schema_${index},`,
    "  },",
  ].join("\n"))

  return [
    `import { createHostedDrizzleDb } from ${JSON.stringify(createImportPath(file, resolvePackageRuntime(dbPackageDir, "runtime/hosted")))}`,
    "",
    ...schemaImports,
    "export const databases = {",
    ...databaseEntries,
    "}",
    "export function useDatabase(name) { return databases[name] }",
    "",
    ...(config.databaseNames.includes("default")
      ? [
          "export const db = databases.default.db",
          "export const schema = databases.default.schema",
        ]
      : []),
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
    imports.push(`import { createBundledVercelBlobDriver } from ${JSON.stringify(createImportPath(file, resolve(blobPackageDir, "src/drivers/vercel-bundled.ts")))}`)
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
      ? "createBlobStorage(createBundledVercelBlobDriver(resolveRuntimeVercelBlobStore(blobConfig.store, process.env)))"
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
      "const disabled = async () => { throw new Error('[vitehub] `@vite-hub/kv` runtime is disabled.') }",
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
    `import { kvResult } from ${JSON.stringify(createImportPath(file, resolve(kvPackageDir, "src/errors.ts")))}`,
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
    "  async clear(base, options) { return kvResult(\"clear\", \"default\", async () => { await storage.clear(base, options) }) },",
    "  async del(key, options) { return kvResult(\"del\", \"default\", async () => { await storage.removeItem(key, options) }) },",
    "  async get(key, options) { return kvResult(\"get\", \"default\", () => storage.getItem(key, options)) },",
    "  async has(key, options) { return kvResult(\"has\", \"default\", () => storage.hasItem(key, options)) },",
    "  async keys(base, options) { return kvResult(\"keys\", \"default\", () => storage.getKeys(base, options)) },",
    "  async set(key, value, options) { return kvResult(\"set\", \"default\", async () => { await storage.setItem(key, value, options) }) },",
    "}",
    "",
  ].join("\n")
}

function renderQueueRuntimeModule(file: string) {
  return [
    `export { defineQueue } from ${JSON.stringify(createImportPath(file, resolve(queuePackageDir, "src/definition.ts")))}`,
    `export { createQueueMessageId } from ${JSON.stringify(createImportPath(file, resolve(queuePackageDir, "src/enqueue.ts")))}`,
    `export { deferQueue, getQueue, runQueue } from ${JSON.stringify(createImportPath(file, resolve(queuePackageDir, "src/runtime/client.ts")))}`,
    `export { createQueueClient } from ${JSON.stringify(createImportPath(file, resolve(queuePackageDir, "src/runtime/create-client.ts")))}`,
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
    `export { createWorkflow, deferWorkflow, getWorkflowRun, runWorkflow } from ${JSON.stringify(createImportPath(file, resolve(workflowPackageDir, "src/runtime/client.ts")))}`,
    `export { readRequestPayload, readValidatedPayload, validatePayload } from ${JSON.stringify(createImportPath(file, resolve(workflowPackageDir, "src/runtime/payload.ts")))}`,
    "",
  ].join("\n")
}

function renderWorkspaceAssetsRuntimeModule() {
  return [
    "function normalizePath(path = '', allowEmpty = true) {",
    "  const raw = String(path).replace(/\\\\/g, '/')",
    "  const normalized = raw.replace(/^\\/+/, '').replace(/\\/+$/, '').replace(/\\/+/g, '/')",
    "  const parts = normalized.split('/').filter(Boolean)",
    "  if (raw.startsWith('/') || parts.some(part => part === '.' || part === '..')) throw new Error(`[vitehub] Workspace path must stay inside the workspace: ${path}.`)",
    "  if (!allowEmpty && !normalized) throw new Error('[vitehub] Workspace path must not be empty.')",
    "  return normalized",
    "}",
    "function contentSize(content) { return typeof content === 'string' ? new TextEncoder().encode(content).byteLength : content.byteLength }",
    "function decodeFile(content, options = {}) { return options.encoding === null ? content : typeof content === 'string' ? content : new TextDecoder().decode(content) }",
    "function parentDirs(path) {",
    "  const parts = path.split('/').filter(Boolean)",
    "  const dirs = []",
    "  for (let index = 1; index < parts.length; index++) dirs.push(parts.slice(0, index).join('/'))",
    "  return dirs",
    "}",
    "function entryVisible(path, prefix, recursive) {",
    "  if (!prefix) return recursive || !path.includes('/')",
    "  if (path === prefix) return true",
    "  if (!path.startsWith(`${prefix}/`)) return false",
    "  return recursive || !path.slice(prefix.length + 1).includes('/')",
    "}",
    "function escapeRegExp(value) { return value.replace(/[.+^${}()|[\\]\\\\]/g, '\\\\$&') }",
    "function globToRegExp(pattern) {",
    "  const normalized = normalizePath(pattern)",
    "  const source = escapeRegExp(normalized).replace(/\\*\\*\\//g, '(?:.*/)?').replace(/\\*\\*/g, '.*').replace(/\\*/g, '[^/]*')",
    "  return new RegExp(`^${source}$`)",
    "}",
    "function matchesGlob(path, pattern) {",
    "  const patterns = Array.isArray(pattern) ? pattern : [pattern]",
    "  return patterns.some(item => globToRegExp(item).test(path))",
    "}",
    "async function sha256(content) {",
    "  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content",
    "  const digest = await crypto.subtle.digest('SHA-256', bytes)",
    "  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')",
    "}",
    "export function createWorkspaceAssets(files) {",
    "  const pathMap = new Map(Object.entries(files).map(([path, file]) => [normalizePath(path, false), file]))",
    "  const paths = [...pathMap.keys()].sort()",
    "  const dirs = new Set(paths.flatMap(path => parentDirs(path)))",
    "  const contentCache = new Map()",
    "  const statCache = new Map()",
    "  async function readContent(path) {",
    "    const file = pathMap.get(path)",
    "    if (!file) throw new Error(`[vitehub] Workspace file does not exist: ${path}.`)",
    "    const cached = contentCache.get(path)",
    "    if (cached) return await cached",
    "    const next = file.load()",
    "    contentCache.set(path, next)",
    "    return await next",
    "  }",
    "  async function statFile(path) {",
    "    const cached = statCache.get(path)",
    "    if (cached) return await cached",
    "    const file = pathMap.get(path)",
    "    if (!file) throw new Error(`[vitehub] Workspace file does not exist: ${path}.`)",
    "    const next = (async () => {",
    "      const content = await readContent(path)",
    "      return { digest: await sha256(content), mediaType: file.mediaType, path, size: contentSize(content), type: 'file' }",
    "    })()",
    "    statCache.set(path, next)",
    "    return await next",
    "  }",
    "  async function statPath(path) {",
    "    if (pathMap.has(path)) return await statFile(path)",
    "    if (!path || dirs.has(path)) return { path, type: 'directory' }",
    "    throw new Error(`[vitehub] Workspace path does not exist: ${path}.`)",
    "  }",
    "  async function listEntries(path = '', options = {}) {",
    "    const prefix = normalizePath(path)",
    "    const result = new Map()",
    "    for (const dir of dirs) if (dir && dir !== prefix && entryVisible(dir, prefix, options.recursive)) result.set(dir, { path: dir, type: 'directory' })",
    "    for (const filePath of paths) if (filePath !== prefix && entryVisible(filePath, prefix, options.recursive)) result.set(filePath, await statFile(filePath))",
    "    return [...result.values()].sort((left, right) => left.path.localeCompare(right.path))",
    "  }",
    "  return {",
    "    async readFile(path, options) { return decodeFile(await readContent(normalizePath(path, false)), options) },",
    "    async stat(path) { return await statPath(normalizePath(path)) },",
    "    async exists(path) { try { await statPath(normalizePath(path)); return true } catch { return false } },",
    "    async list(path = '', options = {}) { return await listEntries(path, options) },",
    "    async glob(pattern) { return (await listEntries('', { recursive: true })).filter(entry => entry.type === 'file' && matchesGlob(entry.path, pattern)) },",
    "    async search(query = {}) {",
    "      const entries = await listEntries('', { recursive: true })",
    "      const term = String(query.text || query.query || '')",
    "      if (!term) return []",
    "      const hits = []",
    "      for (const entry of entries.filter(entry => entry.type === 'file')) {",
    "        if (query.paths?.length && !query.paths.some(path => entry.path === path || entry.path.startsWith(`${path}/`))) continue",
    "        const content = await readContent(entry.path)",
    "        const text = typeof content === 'string' ? content : new TextDecoder().decode(content)",
    "        const index = text.indexOf(term)",
    "        if (index >= 0) hits.push({ path: entry.path, line: 1, column: index + 1, text })",
    "        if (hits.length >= (query.limit || 100)) break",
    "      }",
    "      return hits.slice(0, query.limit || 100)",
    "    },",
    "  }",
    "}",
    "",
  ].join("\n")
}

function renderWorkspaceRuntimeModule(file: string, assetsRegistryFile: string) {
  return [
    `import assetsRegistry from ${JSON.stringify(createImportPath(file, assetsRegistryFile))}`,
    "",
    `export const defineWorkspace = definition => definition`,
    `export const source = { custom: source => source, fetch: options => createHostedSourceStub("fetch", options), file: input => createHostedSourceStub("file", input), github: options => createHostedSourceStub("github", options), glob: options => createHostedSourceStub("glob", options), markdown: options => createHostedSourceStub("markdown", options), mcpResources: options => createHostedSourceStub("mcpResources", options) }`,
    "const stores = new Map()",
    "function normalizePath(path = '', allowEmpty = true) {",
    "  const raw = String(path).replace(/\\\\/g, '/')",
    "  const normalized = raw.replace(/^\\/+/, '').replace(/\\/+$/, '').replace(/\\/+/g, '/')",
    "  const parts = normalized.split('/').filter(Boolean)",
    "  if (raw.startsWith('/') || parts.some(part => part === '.' || part === '..')) throw new Error(`[vitehub] Workspace path must stay inside the workspace: ${path}.`)",
    "  if (!allowEmpty && !normalized) throw new Error('[vitehub] Workspace path must not be empty.')",
    "  return normalized",
    "}",
    "function getStore(name) {",
    "  let store = stores.get(name)",
    "  if (!store) {",
    "    store = { files: new Map(), dirs: new Set() }",
    "    stores.set(name, store)",
    "  }",
    "  return store",
    "}",
    "function contentSize(content) { return typeof content === 'string' ? new TextEncoder().encode(content).byteLength : content.byteLength }",
    "function parentDirs(path) {",
    "  const parts = path.split('/').filter(Boolean)",
    "  const dirs = []",
    "  for (let index = 1; index < parts.length; index++) dirs.push(parts.slice(0, index).join('/'))",
    "  return dirs",
    "}",
    "function entryVisible(path, prefix, recursive) {",
    "  if (!prefix) return recursive || !path.includes('/')",
    "  if (path === prefix) return true",
    "  if (!path.startsWith(`${prefix}/`)) return false",
    "  return recursive || !path.slice(prefix.length + 1).includes('/')",
    "}",
    "function storedEntries(store, path = '', options = {}) {",
    "  const prefix = normalizePath(path)",
    "  const result = new Map()",
    "  const dirs = new Set(store.dirs)",
    "  for (const filePath of store.files.keys()) for (const dir of parentDirs(filePath)) dirs.add(dir)",
    "  for (const dir of dirs) if (dir && dir !== prefix && entryVisible(dir, prefix, options.recursive)) result.set(dir, { path: dir, type: 'directory' })",
    "  for (const [filePath, file] of store.files) {",
    "    if (!entryVisible(filePath, prefix, options.recursive)) continue",
    "    result.set(filePath, { path: filePath, type: 'file', mediaType: file.mediaType, size: contentSize(file.content) })",
    "  }",
    "  return [...result.values()].sort((left, right) => left.path.localeCompare(right.path))",
    "}",
    "function escapeRegExp(value) { return value.replace(/[.+^${}()|[\\]\\\\]/g, '\\\\$&') }",
    "function globToRegExp(pattern) {",
    "  const normalized = normalizePath(pattern)",
    "  const source = escapeRegExp(normalized).replace(/\\*\\*\\//g, '(?:.*/)?').replace(/\\*\\*/g, '.*').replace(/\\*/g, '[^/]*')",
    "  return new RegExp(`^${source}$`)",
    "}",
    "function matchesGlob(path, pattern) {",
    "  const patterns = Array.isArray(pattern) ? pattern : [pattern]",
    "  return patterns.some(item => globToRegExp(item).test(path))",
    "}",
    "async function readWorkspaceFile(name, store, path, options) {",
    "  const normalized = normalizePath(path, false)",
    "  const stored = store.files.get(normalized)",
    "  if (stored) return stored.content",
    "  const assets = assetsRegistry[name]",
    "  if (assets) return await assets.readFile(normalized, options)",
    "  throw new Error(`[vitehub] Workspace file does not exist: ${normalized}.`)",
    "}",
    "async function statWorkspacePath(name, store, path) {",
    "  const normalized = normalizePath(path)",
    "  const stored = store.files.get(normalized)",
    "  if (stored) return { path: normalized, type: 'file', mediaType: stored.mediaType, size: contentSize(stored.content) }",
    "  const entries = storedEntries(store, normalized, { recursive: false })",
    "  if (!normalized || entries.length || store.dirs.has(normalized)) return { path: normalized, type: 'directory' }",
    "  const assets = assetsRegistry[name]",
    "  if (assets) return await assets.stat(normalized)",
    "  throw new Error(`[vitehub] Workspace path does not exist: ${normalized}.`)",
    "}",
    "async function listWorkspaceEntries(name, store, path = '', options = {}) {",
    "  const normalized = normalizePath(path)",
    "  const assets = assetsRegistry[name]",
    "  const result = new Map()",
    "  if (assets) {",
    "    try {",
    "      for (const entry of await assets.list(normalized, options)) result.set(entry.path, entry)",
    "    } catch {}",
    "  }",
    "  for (const entry of storedEntries(store, normalized, options)) result.set(entry.path, entry)",
    "  return [...result.values()].sort((left, right) => left.path.localeCompare(right.path))",
    "}",
    "function createTools() { return {} }",
    "createTools.inspect = () => ({})",
    "createTools.none = () => ({})",
    "createTools.write = () => ({})",
    `export const useWorkspace = (name, options = {}) => {`,
    "  const store = getStore(name)",
    "  const fs = {",
    "    async readFile(path, readOptions) { return await readWorkspaceFile(name, store, path, readOptions) },",
    "    async writeFile(path, content, writeOptions = {}) {",
    "      const normalized = normalizePath(path, false)",
    "      store.files.set(normalized, { content, mediaType: writeOptions.mediaType })",
    "      for (const dir of parentDirs(normalized)) store.dirs.add(dir)",
    "    },",
    "    async appendFile(path, content) {",
    "      const existing = await this.exists(path) ? await this.readFile(path) : ''",
    "      await this.writeFile(path, `${existing}${content}`)",
    "    },",
    "    async stat(path) { return await statWorkspacePath(name, store, path) },",
    "    async exists(path) {",
    "      try { await statWorkspacePath(name, store, path); return true } catch { return false }",
    "    },",
    "    async list(path = '', listOptions = {}) { return await listWorkspaceEntries(name, store, path, listOptions) },",
    "    async glob(pattern, globOptions = {}) {",
    "      return (await listWorkspaceEntries(name, store, '', { recursive: true })).filter(entry => entry.type === 'file' && matchesGlob(entry.path, pattern))",
    "    },",
    "    async search(query = {}) {",
    "      const entries = await listWorkspaceEntries(name, store, query.cwd || '', { recursive: true })",
    "      const term = String(query.text || query.query || '')",
    "      if (!term) return []",
    "      const hits = []",
    "      for (const entry of entries.filter(entry => entry.type === 'file')) {",
    "        const content = await readWorkspaceFile(name, store, entry.path)",
    "        const text = typeof content === 'string' ? content : new TextDecoder().decode(content)",
    "        const index = text.indexOf(term)",
    "        if (index >= 0) hits.push({ path: entry.path, line: 1, column: index + 1, text })",
    "      }",
    "      return hits.slice(0, query.limit || 100)",
    "    },",
    "    async mkdir(path) { store.dirs.add(normalizePath(path, false)) },",
    "    async rm(path, rmOptions = {}) {",
    "      const normalized = normalizePath(path)",
    "      store.files.delete(normalized)",
    "      store.dirs.delete(normalized)",
    "      if (rmOptions.recursive) {",
    "        for (const filePath of [...store.files.keys()]) if (filePath.startsWith(`${normalized}/`)) store.files.delete(filePath)",
    "        for (const dir of [...store.dirs]) if (dir.startsWith(`${normalized}/`)) store.dirs.delete(dir)",
    "      }",
    "    },",
    "    async movePath(from, to) {",
    "      const content = await this.readFile(from)",
    "      await this.writeFile(to, content)",
    "      await this.rm(from)",
    "    },",
    "    async copyPath(from, to) { await this.writeFile(to, await this.readFile(from)) },",
    "    async materializeSources(materializeOptions = {}) { return { bytes: 0, directories: 0, durationMs: 0, files: 0, path: materializeOptions.path || '', sources: [] } },",
    "  }",
    "  const facade = { fs, tools: createTools }",
    "  if (options.mode === 'write') {",
    "    facade.diff = async () => ({ files: [] })",
    "    facade.snapshot = async snapshotOptions => ({ id: `hosted-${Date.now()}`, name: snapshotOptions?.name || 'snapshot' })",
    "    facade.startSession = async () => { throw new Error('[vitehub] Workspace sessions are not available in the hosted Vite e2e runtime.') }",
    "    facade.sync = async () => ({ counts: { added: 0, removed: 0, unchanged: 0, updated: 0 }, durationMs: 0, sources: [], status: 'ready' })",
    "  }",
    "  return facade",
    "}",
    "export const createWorkspace = definition => {",
    "  const workspace = useWorkspace(definition.name, { mode: 'write' })",
    "  workspace.startSession = async ({ host, target }) => {",
    "    const entries = await workspace.fs.list('', { recursive: true })",
    "    for (const entry of entries) {",
    "      const path = `${target}/${entry.path}`",
    "      if (entry.type === 'directory') await host.files.mkdir(path, { recursive: true })",
    "      else {",
    "        const parent = path.slice(0, path.lastIndexOf('/'))",
    "        if (parent) await host.files.mkdir(parent, { recursive: true })",
    "        const content = await workspace.fs.readFile(entry.path)",
    "        await host.files.write(path, typeof content === 'string' ? new TextEncoder().encode(content) : content)",
    "      }",
    "    }",
    "    return { async close() {} }",
    "  }",
    "  return workspace",
    "}",
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

async function rewriteWorkspaceAssetsRegistryForHostedRuntime(registryFile: string, assetsRuntimeFile: string) {
  let contents: string
  try {
    contents = await readFile(registryFile, "utf8")
  }
  catch (error) {
    // SAFETY: Node filesystem failures expose their stable error code through ErrnoException.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }

  const hostedImport = `import { createWorkspaceAssets } from ${JSON.stringify(createImportPath(registryFile, assetsRuntimeFile))}`
  const updated = contents.replace(/^import \{ createWorkspaceAssets \} from .+$/m, hostedImport)
  if (updated !== contents) await writeFile(registryFile, updated, "utf8")
}

function renderWorkspaceStateRuntimeModule() {
  return [
    "let workspaceRuntimeConfig = false",
    "let workspaceHostedStoreLoader",
    "export function getWorkspaceRuntimeConfig() { return workspaceRuntimeConfig }",
    "export function setWorkspaceRuntimeConfig(config) { workspaceRuntimeConfig = config }",
    "export function getWorkspaceHostedStoreLoader() { return workspaceHostedStoreLoader }",
    "export function setWorkspaceHostedStoreLoader(loader) { workspaceHostedStoreLoader = loader }",
    "export function setWorkspaceRuntimeRegistry() {}",
    "export function setWorkspaceRuntimeAssetsRegistry() {}",
    "export function resetWorkspaceStoreCache() {}",
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
  const providerExport = sandboxProviderRuntimeExport(provider)
  const runtimeProviderFile = resolvePackageRuntime(sandboxPackageDir, `runtime/providers/${provider}`)

  return [
    `import { ${providerExport} as resolveSandboxBox } from ${JSON.stringify(createImportPath(file, runtimeProviderFile))}`,
    "",
    "export async function loadSandboxRuntimeProvider(selectedProvider) {",
    `  if (selectedProvider !== ${JSON.stringify(provider)})`,
    "    throw new Error(`[vitehub] Unsupported sandbox provider for this hosted build: ${selectedProvider}`)",
    "  return {",
    "    resolveSandboxBox,",
    "  }",
    "}",
    "",
  ].join("\n")
}

export async function prepareFeatureArtifacts(options: ViteE2EComposerOptions) {
  const generatedDir = ensureGeneratedDir(options.rootDir, viteE2EProductName)
  await rm(generatedDir, { force: true, recursive: true })
  await mkdir(generatedDir, { recursive: true })

  const alias: Record<string, string> = {}
  let workspaceAssetsRegistryFile: string | undefined
  let workspaceAssetsRuntimeFile: string | undefined
  const queueDefinitions = options.queue
    ? discoverQueueDefinitions({ mode: "server-queues", scanDirs: [resolve(options.rootDir, "server")] })
    : []
  const rateLimitDeclarations = options.rateLimit
    ? discoverRateLimitCatalog({ rootDir: options.rootDir, scanDirs: [resolve(options.rootDir, "src")] }).declarations
    : []
  const scheduleDefinitions = options.schedule
    ? discoverScheduleDefinitions({ rootDir: options.rootDir })
    : []
  const workflowDefinitions = options.workflow
    ? discoverWorkflowDefinitions({ mode: "server-workflows", scanDirs: [resolve(options.rootDir, "server")] })
    : []
  const sandboxDefinitions = options.sandbox
    ? discoverServerSandboxDefinitions([resolve(options.rootDir, "server")])
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
    runtimeWrites.push(writeFile(workflowRegistryFile, createWorkflowRegistryContents(workflowRegistryFile, workflowDefinitions), "utf8"))
  }

  if (options.db) {
    const dbRuntimeFile = resolve(generatedDir, "database-runtime.mjs")
    alias["@vite-hub/database/drizzle"] = dbRuntimeFile
    runtimeWrites.push(writeFile(dbRuntimeFile, renderDbRuntimeModule(dbRuntimeFile, options.db), "utf8"))
  }

  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The compatibility composer distinguishes omitted provider configuration.
  if (typeof options.blob !== "undefined") {
    const blobRuntimeFile = resolve(generatedDir, "blob-runtime.mjs")
    alias["@vite-hub/blob"] = blobRuntimeFile
    runtimeWrites.push(writeFile(blobRuntimeFile, renderBlobRuntimeModule(blobRuntimeFile, options.blob), "utf8"))
  }

  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The compatibility composer distinguishes omitted provider configuration.
  if (typeof options.kv !== "undefined") {
    const kvRuntimeFile = resolve(generatedDir, "kv-runtime.mjs")
    alias["@vite-hub/kv"] = kvRuntimeFile
    runtimeWrites.push(writeFile(kvRuntimeFile, renderKvRuntimeModule(kvRuntimeFile, options.kv), "utf8"))
  }

  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The compatibility composer distinguishes omitted provider configuration.
  if (typeof options.queue !== "undefined") {
    const queueRuntimeFile = resolve(generatedDir, "queue-runtime.mjs")
    alias["@vite-hub/queue"] = queueRuntimeFile
    runtimeWrites.push(writeFile(queueRuntimeFile, renderQueueRuntimeModule(queueRuntimeFile), "utf8"))
  }

  if (options.rateLimit) {
    alias["@vite-hub/rate-limit"] = resolve(rateLimitPackageDir, "src/index.ts")
  }

  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The compatibility composer distinguishes omitted provider configuration.
  if (typeof options.schedule !== "undefined") {
    const scheduleRuntimeFile = resolve(generatedDir, "schedule-runtime.mjs")
    alias["@vite-hub/schedule"] = scheduleRuntimeFile
    runtimeWrites.push(writeFile(scheduleRuntimeFile, renderScheduleRuntimeModule(scheduleRuntimeFile), "utf8"))
  }

  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The compatibility composer distinguishes omitted provider configuration.
  if (typeof options.sandbox !== "undefined") {
    const sandboxRuntimeFile = resolve(generatedDir, "sandbox-runtime.mjs")
    alias["@vite-hub/sandbox/runtime/state"] = resolve(sandboxPackageDir, "src/runtime/state.ts")
    alias["@vite-hub/sandbox"] = sandboxRuntimeFile
    runtimeWrites.push(writeFile(sandboxRuntimeFile, renderSandboxRuntimeModule(sandboxRuntimeFile), "utf8"))
  }

  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The compatibility composer distinguishes omitted provider configuration.
  if (typeof options.workflow !== "undefined") {
    const workflowRuntimeFile = resolve(generatedDir, "workflow-runtime.mjs")
    alias["@vite-hub/workflow"] = workflowRuntimeFile
    runtimeWrites.push(writeFile(workflowRuntimeFile, renderWorkflowRuntimeModule(workflowRuntimeFile), "utf8"))
  }

  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The compatibility composer distinguishes omitted provider configuration.
  if (typeof options.workspace !== "undefined") {
    const workspaceRuntimeFile = resolve(generatedDir, "workspace-runtime.mjs")
    const workspaceStateRuntimeFile = resolve(generatedDir, "workspace-state-runtime.mjs")
    const workspaceShellRuntimeFile = resolve(generatedDir, "workspace-shell-runtime.mjs")
    workspaceAssetsRuntimeFile = resolve(generatedDir, "workspace-assets-runtime.mjs")
    workspaceAssetsRegistryFile = resolve(options.rootDir, ".vitehub/vite-runtime/workspace/assets/registry.mjs")
    alias["#vitehub-workspace-assets-registry"] = workspaceAssetsRegistryFile
    alias["@vite-hub/workspace/internal/runtime/assets"] = workspaceAssetsRuntimeFile
    alias["@vite-hub/workspace/internal/runtime/workspace"] = workspaceRuntimeFile
    alias["@vite-hub/workspace/runtime"] = workspaceStateRuntimeFile
    alias["@vite-hub/workspace/loader"] = resolve(workspacePackageDir, "src/loader.ts")
    alias["@vite-hub/workspace/publish"] = resolve(workspacePackageDir, "src/publish.ts")
    alias["@vite-hub/workspace/test"] = resolve(workspacePackageDir, "src/test.ts")
    alias["@vite-hub/workspace"] = workspaceRuntimeFile
    alias["@vite-hub/shell/workspace"] = workspaceShellRuntimeFile
    alias["@vite-hub/shell"] = workspaceShellRuntimeFile
    alias["isomorphic-git/http/web"] = resolveIsomorphicGitHttpWebEsmEntry()
    alias["isomorphic-git"] = resolveIsomorphicGitEsmEntry()
    for (const dependency of ["async-lock", "clean-git-ref", "crc-32", "diff3", "ignore", "inherits", "minimisted", "pako", "pify", "readable-stream", "sha.js/sha1.js", "simple-get"]) {
      alias[dependency] = resolveIsomorphicGitDependency(dependency)
    }
    runtimeWrites.push(
      writeFile(workspaceAssetsRuntimeFile, renderWorkspaceAssetsRuntimeModule(), "utf8"),
      writeFile(workspaceRuntimeFile, renderWorkspaceRuntimeModule(workspaceRuntimeFile, workspaceAssetsRegistryFile), "utf8"),
      writeFile(workspaceStateRuntimeFile, renderWorkspaceStateRuntimeModule(), "utf8"),
      writeFile(workspaceShellRuntimeFile, renderWorkspaceShellRuntimeModule(), "utf8"),
    )
  }

  await Promise.all(runtimeWrites)
  if (workspaceAssetsRegistryFile && workspaceAssetsRuntimeFile) {
    await rewriteWorkspaceAssetsRegistryForHostedRuntime(workspaceAssetsRegistryFile, workspaceAssetsRuntimeFile)
  }
  const scheduleCrons = await readDefinitionCrons(scheduleDefinitions)

  let sandboxConfig: false | AgentSandboxConfig | undefined
  if (options.sandbox) {
    sandboxConfig = resolveSandboxFeatureConfig(options.sandbox, options.hosting)
    const sandboxProvider = sandboxConfig.provider === "vercel" ? "vercel" : "cloudflare"

    const emittedDefinitions = await Promise.all(sandboxDefinitions.map(async (definition) => {
      const file = resolve(generatedDir, "runtime", "sandbox-definitions", `${toSandboxArtifactName(definition.name)}.mjs`)
      const [source, project] = await Promise.all([
        readFile(definition._meta.sourcePath, "utf8"),
        resolveSandboxProject(definition.handler, options.rootDir, { readSandboxOptions: true }),
      ])
      const bundle = await bundleSandboxDefinition(source, definition._meta.sourcePath, {
        execution: "module",
        project,
      })
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, `export default ${JSON.stringify({ bundle, options: project.options })}\n`, "utf8")
      return { file, name: definition.name }
    }))

    const sandboxRegistryFile = resolve(generatedDir, "runtime", "sandbox-registry.mjs")
    const sandboxProviderLoaderFile = resolve(generatedDir, "runtime", "sandbox-provider-loader.mjs")

    await Promise.all([
      writeFile(sandboxRegistryFile, renderSandboxRegistryModule(emittedDefinitions), "utf8"),
      writeFile(sandboxProviderLoaderFile, renderSandboxProviderLoaderModule(sandboxProviderLoaderFile, sandboxProvider), "utf8"),
    ])

    alias["#vitehub-sandbox-registry"] = sandboxRegistryFile
    for (const key of [
      "vitehub-sandbox-provider-loader",
      "@vite-hub/sandbox/runtime/provider-loader",
      "virtual:vitehub-sandbox-provider-loader",
      "#vitehub-sandbox-provider-loader",
    ]) {
      alias[key] = sandboxProviderLoaderFile
    }

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
    rateLimitDeclarations,
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
  const workspaceRuntimeState = artifacts.alias["@vite-hub/workspace/runtime"] || resolve(workspacePackageDir, "src/runtime/state.ts")
  const queueNamePrefix = options.queue ? options.queue.namePrefix : ""
  const queueDefinitionNames = Object.fromEntries(artifacts.queueDefinitions.map(definition => [getCloudflareQueueName(definition.name, queueNamePrefix), definition.name]))

  const imports = [
    `import { H3, toWebHandler } from "h3"`,
    `import { resolveAppFetch } from ${JSON.stringify(createImportPath(file, resolveApp))}`,
    `import { clearActiveCloudflareEnv, createCloudflareRuntimeEvent, runWithActiveCloudflareEnv, setActiveCloudflareEnv } from ${JSON.stringify(createImportPath(file, cloudflareEnv))}`,
    `import app from ${JSON.stringify(createImportPath(file, appEntry))}`,
    `import { createCloudflareQueueBatchHandler } from ${JSON.stringify(createImportPath(file, resolve(queuePackageDir, "src/providers/cloudflare.ts")))}`,
    `import { createCloudflareQueueRuntimeClient } from ${JSON.stringify(createImportPath(file, resolve(queuePackageDir, "src/internal/runtime/cloudflare-client.ts")))}`,
    `import { createQueueJob } from ${JSON.stringify(createImportPath(file, resolve(queuePackageDir, "src/runtime/cloudflare-shared.ts")))}`,
    `import { loadQueueDefinition, runWithQueueRuntimeEvent, setQueueRuntimeConfig, setQueueRuntimeRegistry } from ${JSON.stringify(createImportPath(file, resolve(queuePackageDir, "src/internal/runtime/state.ts")))}`,
    `import { executeStaticSchedule } from ${JSON.stringify(createImportPath(file, resolve(schedulePackageDir, "src/runtime/execute.ts")))}`,
    `import { runCloudflareWorkflow } from ${JSON.stringify(createImportPath(file, resolve(workflowPackageDir, "src/runtime/cloudflare-runner.ts")))}`,
    `import { runWithWorkflowRuntimeEvent, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from ${JSON.stringify(createImportPath(file, resolve(workflowPackageDir, "src/runtime/state.ts")))}`,
    `import { setBlobRuntimeConfig } from ${JSON.stringify(createImportPath(file, resolve(blobPackageDir, "src/runtime/state.ts")))}`,
    `import { setRateLimitRuntimeConfig } from ${JSON.stringify(createImportPath(file, resolve(rateLimitPackageDir, "src/runtime/state.ts")))}`,
    `import { setSandboxRuntimeConfig, setSandboxRuntimeRegistry } from ${JSON.stringify(createImportPath(file, resolve(sandboxPackageDir, "src/runtime/state.ts")))}`,
    `import { setWorkspaceHostedStoreLoader, setWorkspaceRuntimeConfig, setWorkspaceRuntimeRegistry } from ${JSON.stringify(createImportPath(file, workspaceRuntimeState))}`,
  ]

  if (workspaceProvider === "cloudflare-artifacts") {
    imports.push(`import { createCloudflareArtifactsWorkspaceStore } from ${JSON.stringify(createImportPath(file, resolve(workspacePackageDir, "src/providers/cloudflare/artifacts-store.ts")))}`)
  }
  if (workspaceProvider === "github") {
    imports.push(`import { createGitHubWorkspaceStore } from ${JSON.stringify(createImportPath(file, resolve(workspacePackageDir, "src/providers/github/store.ts")))}`)
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
  if (artifacts.workflowBindings.length) {
    imports.push(`import { WorkflowEntrypoint } from "cloudflare:workers"`)
    imports.push(`import { NonRetryableError } from "cloudflare:workflows"`)
  }
  if (artifacts.sandboxConfig && options.sandbox) {
    imports.push(`import { Sandbox as CloudflareSandbox } from "@cloudflare/sandbox"`)
  }

  const workflowClassExports = artifacts.workflowDefinitions.map((definition, index) => {
    const binding = artifacts.workflowBindings[index]
    return [
      `export class ${binding?.class_name || getCloudflareWorkflowClassName(definition.name)} extends WorkflowEntrypoint {`,
      "  async run(event, step) {",
      `    return await runCloudflareWorkflow({ config: workflowConfig, createNonRetryableError: error => new NonRetryableError(error.message, error.name), env: this.env || {}, event, name: ${JSON.stringify(definition.name)}, registry: workflowRegistry, step })`,
      "  }",
      "}",
      "",
    ].join("\n")
  })

  return [
    ...imports,
    "",
    `const queueConfig = ${JSON.stringify(options.queue || false, null, 2)}`,
    `const queueDefinitionNames = ${JSON.stringify(queueDefinitionNames, null, 2)}`,
    `const workflowConfig = ${JSON.stringify(options.workflow || false, null, 2)}`,
    `const blobConfig = ${JSON.stringify(options.blob || false, null, 2)}`,
    `const sandboxConfig = ${JSON.stringify(artifacts.sandboxConfig || false, null, 2)}`,
    `const workspaceConfig = ${JSON.stringify(options.workspace || false, null, 2)}`,
    "setQueueRuntimeConfig(queueConfig, createCloudflareQueueRuntimeClient)",
    `setQueueRuntimeRegistry(${artifacts.queueRegistryFile ? "queueRegistry" : "undefined"})`,
    "setWorkflowRuntimeConfig(workflowConfig)",
    `setWorkflowRuntimeRegistry(${artifacts.workflowRegistryFile ? "workflowRegistry" : "undefined"})`,
    "setBlobRuntimeConfig(blobConfig)",
    ...(options.rateLimit ? ["setRateLimitRuntimeConfig({ provider: 'cloudflare' })"] : []),
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
      : workspaceProvider === "github"
        ? [
            "setWorkspaceHostedStoreLoader((store, workspaceName) => {",
            "  if (store.provider !== 'github') throw new Error(`[vitehub] Unsupported workspace store for Cloudflare build: ${store.provider}`)",
            "  return createGitHubWorkspaceStore(store, workspaceName)",
            "})",
          ]
      : ["setWorkspaceHostedStoreLoader(undefined)"]),
    "setWorkspaceRuntimeRegistry({})",
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
    "      const definition = await loadQueueDefinition(queueDefinitionNames[batch.queue])",
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
    "      const runtimeEvent = createCloudflareRuntimeEvent(env, context)",
    "      await Promise.all(Object.entries(scheduleRegistry).map(async ([name, loader]) => {",
    "        const loaded = await loader()",
    "        const definition = loaded?.default ?? loaded",
    "        if (!definition || definition.cron !== event.cron) return",
    "        await runWithQueueRuntimeEvent(runtimeEvent, () => runWithWorkflowRuntimeEvent(runtimeEvent, () => executeStaticSchedule({ cron: event.cron, definition, name, scheduledAt: new Date(event.scheduledTime) })))",
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
  const workspaceRuntimeState = artifacts.alias["@vite-hub/workspace/runtime"] || resolve(workspacePackageDir, "src/runtime/state.ts")

  const imports = [
    `import { waitUntil as vercelWaitUntil } from ${JSON.stringify(createImportPath(file, resolvePackageDependency(queuePackageDir, "@vercel/functions")))}`,
    `import { H3, fromWebHandler } from "h3"`,
    `import { toNodeHandler } from "h3/node"`,
    `import { resolveAppFetch } from ${JSON.stringify(createImportPath(file, resolveApp))}`,
    `import { createVercelQueueRuntimeClient } from ${JSON.stringify(createImportPath(file, resolve(queuePackageDir, "src/internal/runtime/vercel-client.ts")))}`,
    `import { setQueueRuntimeConfig, setQueueRuntimeRegistry, runWithQueueRuntimeEvent } from ${JSON.stringify(createImportPath(file, resolve(queuePackageDir, "src/internal/runtime/state.ts")))}`,
    `import { setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry, runWithWorkflowRuntimeEvent } from ${JSON.stringify(createImportPath(file, resolve(workflowPackageDir, "src/runtime/state.ts")))}`,
    `import { setBlobRuntimeConfig } from ${JSON.stringify(createImportPath(file, resolve(blobPackageDir, "src/runtime/state.ts")))}`,
    `import { setSandboxRuntimeConfig, setSandboxRuntimeRegistry } from ${JSON.stringify(createImportPath(file, resolve(sandboxPackageDir, "src/runtime/state.ts")))}`,
    `import { setWorkspaceHostedStoreLoader, setWorkspaceRuntimeConfig, setWorkspaceRuntimeRegistry } from ${JSON.stringify(createImportPath(file, workspaceRuntimeState))}`,
    `import app from ${JSON.stringify(createImportPath(file, appEntry))}`,
  ]
  if (preloadVercelQueue) {
    imports.push(`import * as __vitehubVercelQueue from ${JSON.stringify(createImportPath(file, resolvePackageDependency(queuePackageDir, "@vercel/queue")))}`)
  }

  if (workspaceProvider === "vercel-blob") {
    imports.push(`import { createVercelBlobWorkspaceStore } from ${JSON.stringify(createImportPath(file, resolve(workspacePackageDir, "src/providers/vercel/blob-store.ts")))}`)
  }
  if (workspaceProvider === "github") {
    imports.push(`import { createGitHubWorkspaceStore } from ${JSON.stringify(createImportPath(file, resolve(workspacePackageDir, "src/providers/github/store.ts")))}`)
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
  return [
    ...imports,
    "",
    preloadVercelQueue ? "globalThis.__vitehubVercelQueue = __vitehubVercelQueue" : "",
    `const queueConfig = ${JSON.stringify(options.queue || false, null, 2)}`,
    `const workflowConfig = ${JSON.stringify(options.workflow || false, null, 2)}`,
    `const blobConfig = ${JSON.stringify(options.blob || false, null, 2)}`,
    `const sandboxConfig = ${JSON.stringify(artifacts.sandboxConfig || false, null, 2)}`,
    `const workspaceConfig = ${JSON.stringify(options.workspace || false, null, 2)}`,
    "setQueueRuntimeConfig(queueConfig, createVercelQueueRuntimeClient)",
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
      : workspaceProvider === "github"
        ? [
            "setWorkspaceHostedStoreLoader((store, workspaceName) => {",
            "  if (store.provider !== 'github') throw new Error(`[vitehub] Unsupported workspace store for Vercel build: ${store.provider}`)",
            "  return createGitHubWorkspaceStore(store, workspaceName)",
            "})",
          ]
      : ["setWorkspaceHostedStoreLoader(undefined)"]),
    "setWorkspaceRuntimeRegistry({})",
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
    imports.push(`import * as __vitehubVercelQueue from ${JSON.stringify(createImportPath(file, resolvePackageDependency(queuePackageDir, "@vercel/queue")))}`)
  }

  return [
    ...imports,
    `import { createVercelQueueRuntimeClient } from ${JSON.stringify(createImportPath(file, resolve(queuePackageDir, "src/internal/runtime/vercel-client.ts")))}`,
    `import { handleHostedVercelQueueCallback, hostedVercelWaitUntil } from ${JSON.stringify(createImportPath(file, resolve(queuePackageDir, "src/runtime/hosted.ts")))}`,
    `import { loadQueueDefinition, runWithQueueRuntimeEvent, setQueueRuntimeConfig, setQueueRuntimeRegistry } from ${JSON.stringify(createImportPath(file, resolve(queuePackageDir, "src/internal/runtime/state.ts")))}`,
    `import queueRegistry from ${JSON.stringify(createImportPath(file, queueRegistryFile))}`,
    "",
    preloadVercelQueue ? "globalThis.__vitehubVercelQueue = __vitehubVercelQueue" : "",
    `setQueueRuntimeConfig(${JSON.stringify(queueConfig || false, null, 2)}, createVercelQueueRuntimeClient)`,
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
    `import { waitUntil as vercelWaitUntil } from ${JSON.stringify(createImportPath(file, resolvePackageDependency(queuePackageDir, "@vercel/functions")))}`,
    `import { runWithQueueRuntimeEvent } from ${JSON.stringify(createImportPath(file, resolve(queuePackageDir, "src/internal/runtime/state.ts")))}`,
    `import { executeStaticSchedule } from ${JSON.stringify(createImportPath(file, resolve(schedulePackageDir, "src/runtime/execute.ts")))}`,
    `import { runWithWorkflowRuntimeEvent } from ${JSON.stringify(createImportPath(file, resolve(workflowPackageDir, "src/runtime/state.ts")))}`,
    `import scheduleRegistry from ${JSON.stringify(createImportPath(file, scheduleRegistryFile))}`,
    "",
    "export default async function scheduleHandler(req, res) {",
    "  const cronSecret = process.env.CRON_SECRET",
    "  const authorization = req.headers?.authorization || req.headers?.Authorization",
    "  if (cronSecret && authorization !== `Bearer ${cronSecret}`) {",
    "    res.statusCode = 401",
    "    res.end('Unauthorized.')",
    "    return",
    "  }",
    `  const name = ${JSON.stringify(definitionName)}`,
    "  const loaded = await scheduleRegistry[name]?.()",
    "  const definition = loaded?.default ?? loaded",
    "  if (!definition) {",
    "    res.statusCode = 404",
    "    res.end('Missing schedule definition.')",
    "    return",
    "  }",
    "  const runtimeEvent = { req, res, waitUntil: vercelWaitUntil }",
    "  await runWithQueueRuntimeEvent(runtimeEvent, () => runWithWorkflowRuntimeEvent(runtimeEvent, () => executeStaticSchedule({ cron: definition.cron, definition, name, scheduledAt: new Date() })))",
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

function createCloudflareQueueBindings(definitions: Array<{ name: string }>, namePrefix = "") {
  if (!definitions.length) return undefined
  return {
    consumers: definitions.map(definition => ({ queue: getCloudflareQueueName(definition.name, namePrefix) })),
    producers: definitions.map(definition => ({
      binding: getCloudflareQueueBindingName(definition.name),
      queue: getCloudflareQueueName(definition.name, namePrefix),
    })),
  }
}

function createCloudflareR2Bindings(config: false | ResolvedBlobModuleOptions | undefined) {
  if (!config || config.store.driver !== "cloudflare-r2" || !config.store.bucketName) {
    return undefined
  }
  return [{ binding: config.store.binding, bucket_name: config.store.bucketName }]
}

function createCloudflareD1Bindings(rootDir: string, config: ResolvedDBViteConfig | undefined) {
  if (!config) {
    return undefined
  }

  const bindings = resolveCloudflareD1Bindings(config, {
    provisionState: readProvisionStateSync(rootDir),
  }).d1Databases

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
    conditions: ["vitehub-hosted", "workerd", "worker", "browser", "default"],
    external: [
      "@vercel/blob",
      "@vercel/queue",
      "@vercel/sandbox",
      "askweb",
      "cloudflare:workers",
      "cloudflare:workflows",
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
      "node:os",
      "node:path",
      "node:path/posix",
      "node:stream",
      "node:url",
      "node:util",
      "workflow",
      "workflow/api",
      "workflow/runtime",
    ],
    format: "esm",
    platform: "neutral",
  })

  const d1Databases = createCloudflareD1Bindings(options.rootDir, options.db)
  const queueBindings = createCloudflareQueueBindings(artifacts.queueDefinitions, options.queue ? options.queue.namePrefix : "")
  const rateLimitBindings = options.rateLimit
    ? createCloudflareRateLimitBindings(artifacts.rateLimitDeclarations, options.rateLimit.namespace)
    : undefined
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
    ...(rateLimitBindings?.length ? { ratelimits: rateLimitBindings } : {}),
    ...(artifacts.scheduleCrons.size ? { triggers: { crons: [...new Set(artifacts.scheduleCrons.values())] } } : {}),
    ...(artifacts.workflowBindings.length ? { workflows: artifacts.workflowBindings } : {}),
    ...(r2Buckets ? { r2_buckets: r2Buckets } : {}),
  }

  if (options.kv) {
    // SAFETY: The fixture owns the Cloudflare config object and supplies the shape expected by this integration.
    configureCloudflareKV({ cloudflare: { wrangler: wranglerConfig } as never }, options.kv)
  }
  // SAFETY: The fixture owns the Cloudflare config object and supplies the shape expected by this integration.
  configureCloudflareArtifacts({ cloudflare: { wrangler: wranglerConfig } as never }, options.workspace || false)

  if (artifacts.sandboxConfig && artifacts.sandboxConfig.provider === "cloudflare") {
    const sandboxClassName = resolveSandboxClassName(artifacts.sandboxConfig)
    // SAFETY: The fixture owns the Cloudflare config object and supplies the shape expected by this integration.
    configureCloudflareSandbox({ cloudflare: { wrangler: wranglerConfig } as never }, {
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Provider configuration is untyped until this runtime boundary validates it.
      binding: typeof artifacts.sandboxConfig.binding === "string" ? artifacts.sandboxConfig.binding : defaultCloudflareSandboxBinding,
      className: sandboxClassName,
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Provider configuration is untyped until this runtime boundary validates it.
      migrationTag: typeof artifacts.sandboxConfig.migrationTag === "string" ? artifacts.sandboxConfig.migrationTag : defaultCloudflareSandboxMigrationTag,
      name: toSafeAppName(`${workerName}-${sandboxClassName}`),
    })
    await writeCloudflareSandboxDockerfile(outputRoot)
  }

  // SAFETY: The fixture owns the Cloudflare config object and supplies the shape expected by this integration.
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
    conditions: ["vitehub-hosted", "node", "default"],
    external: [
      "askweb",
      "cloudflare:workers",
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
      "isomorphic-git",
      "isomorphic-git/http/web",
      "workflow",
      "workflow/api",
      "workflow/runtime",
    ],
    format: "esm",
    platform: "node",
  })

  // SAFETY: This extends the owned Vercel config with its supported optional cron entries.
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
    enforce: "pre",
    async config() {
      const artifacts = await prepareFeatureArtifacts(options)
      resolvedAlias = artifacts.alias
      return {
        resolve: {
          alias: resolvedAlias,
        },
      }
    },
    resolveId(id) {
      return resolvedAlias?.[id]
    },
    async closeBundle() {
      await generateViteE2EOutputs(options)
    },
  }
}

export function resolveViteE2EOptions(rootDir: string, hosting: string) {
  const provider = resolveHostedProvider(hosting)
  return {
    blob: normalizeBlobOptions(provider === "vercel" ? { access: "private", driver: "vercel-blob" } : undefined, { hosting }),
    db: resolveDBViteConfig(undefined, rootDir),
    hosting: provider,
    kv: normalizeKVOptions(undefined, { hosting }),
    queue: normalizeQueueOptions({}, { hosting }) || false,
    rateLimit: provider === "cloudflare" ? { namespace: "vitehub-playground-vite-e2e" } : false,
    schedule: true,
    sandbox: resolveSandboxFeatureConfig({}, hosting),
    workspace: normalizeWorkspaceOptions({}, { env: process.env, hosting, rootDir }),
    workflow: normalizeWorkflowOptions({}, { hosting }) || false,
  }
}
