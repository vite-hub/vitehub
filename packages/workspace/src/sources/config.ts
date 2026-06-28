import { defu } from "defu"

import { WorkspaceError } from "../core/errors.ts"
import { decodeFile, normalizeSafeWorkspacePath } from "../core/path.ts"
import { fetch as fetchSource } from "./fetch.ts"
import { getLiveWorkspaceSourcePaths, markLiveWorkspaceSource } from "./live.ts"
import {
  copyWorkspaceSourceRequestMetadata,
  assertWorkspaceSourceRequestDescriptorKey,
  getWorkspaceSourceRequestDescriptor,
  isWorkspaceSourceRequestOnly,
} from "./request-metadata.ts"

import type {
  ReadFileOptions,
  ReadFileResult,
  SourceContext,
  SourceContextWorkspaceFiles,
  WorkspaceCacheOptions,
  WorkspaceDefinition,
  WorkspaceMaterializeMode,
  WorkspaceSelectedScope,
  WorkspaceSourceRequestDescriptor,
  WorkspaceSource,
  WorkspaceStore,
  WorkspaceSourceInput,
  WorkspaceSourceSyncPolicy,
  WorkspaceValidateMode,
} from "../core/types.ts"

type WorkspaceSourceFamily = "fetch" | "file" | "github" | "glob" | "mcpResources"

export interface ResolvedWorkspaceSource {
  key: string
  source: WorkspaceSource
  mountPath: string
  materialize: WorkspaceMaterializeMode
  cache: false | WorkspaceCacheOptions
  sync: false | WorkspaceSourceSyncPolicy
  validate: WorkspaceValidateMode
  livePaths?: Record<string, string>
  readonly: true
  requestDescriptor?: WorkspaceSourceRequestDescriptor
  requestOnly?: boolean
  scopes?: readonly string[]
}

export {
  getWorkspaceSourceRequestDescriptor,
  getWorkspaceSourceRequestExecutor,
  isWorkspaceSourceRequestOnly,
  markWorkspaceSourceRequestDescriptor,
  markWorkspaceSourceRequestExecutor,
  workspaceSourceRequestDescriptorPath,
} from "./request-metadata.ts"

export function copyWorkspaceSourceMetadata(source: WorkspaceSource, target: WorkspaceSource): WorkspaceSource {
  const livePaths = getLiveWorkspaceSourcePaths(source)
  if (livePaths) markLiveWorkspaceSource(target, livePaths)

  copyWorkspaceSourceRequestMetadata(source, target)

  return target
}

export function createSourceContext(
  definition: WorkspaceDefinition,
  source?: { key: string, mountPath: string },
  store?: WorkspaceStore,
  options: { selectedWorkspaceScope?: WorkspaceSelectedScope } = {},
): SourceContext {
  return {
    mountPath: source?.mountPath,
    rootDir: definition.rootDir || process.cwd(),
    selectedWorkspaceScope: options.selectedWorkspaceScope,
    source: source?.key,
    sourceRootDir: definition.sourceRootDir,
    workspace: definition.name,
    workspaceFiles: store ? createSourceContextWorkspaceFiles(store) : undefined,
  }
}

function createSourceContextWorkspaceFiles(store: WorkspaceStore): SourceContextWorkspaceFiles {
  async function readFile<TOptions extends ReadFileOptions | undefined = undefined>(path: string, options?: TOptions): Promise<ReadFileResult<TOptions>> {
    const workspacePath = normalizeSafeWorkspacePath(path)
    const file = await store.readFile(workspacePath)
    if (!file) throw new WorkspaceError(`[vitehub] Workspace file does not exist: ${path}.`)
    return decodeFile(file.content, options)
  }

  async function stat(path: string) {
    return await store.stat(normalizeSafeWorkspacePath(path, { allowEmpty: true }))
  }

  return {
    readFile,
    stat,
    async exists(path) {
      return Boolean(await stat(path))
    },
  }
}

export function normalizeWorkspaceSources(sources: WorkspaceDefinition["sources"]): ResolvedWorkspaceSource[] {
  if (!sources) return []

  return Object.entries(sources)
    .map(([key, source]) => normalizeWorkspaceSource(key, source))
    .sort((left, right) => right.mountPath.length - left.mountPath.length || left.key.localeCompare(right.key))
}

export function normalizeWorkspaceSource(key: string, input: WorkspaceSourceInput): ResolvedWorkspaceSource {
  const source = toWorkspaceSource(input)
  if (source && typeof source === "object" && "instructions" in source) {
    throw new TypeError(`[vitehub] Workspace source "${key}" instructions were removed. Put model-facing guidance in Agent Driver Instructions with ::source coverage.`)
  }
  const mount = normalizeSourceMount(source)
  const cache = mount.cache ?? normalizeSourceCache(source) ?? false
  const sync = normalizeSourceSync(source.sync)
  const mountPath = typeof mount.path === "string" ? mount.path : key
  const requestDescriptor = getWorkspaceSourceRequestDescriptor(source)
  const scopes = normalizeSourceScopes(key, source.scopes)
  if (requestDescriptor) assertWorkspaceSourceRequestDescriptorKey(key)
  return {
    key,
    source,
    mountPath: normalizeSafeWorkspacePath(mountPath, { allowEmpty: true }),
    materialize: mount.materialize || source.materialize || (cache ? "lazy" : sync ? "none" : "build"),
    cache,
    sync,
    validate: mount.validate ?? source.validate ?? false,
    livePaths: getLiveWorkspaceSourcePaths(source),
    readonly: true,
    requestDescriptor,
    requestOnly: isWorkspaceSourceRequestOnly(source),
    ...(scopes.length ? { scopes } : {}),
  }
}

export function sourceMountContainsPath(source: Pick<ResolvedWorkspaceSource, "mountPath">, workspacePath: string): boolean {
  return workspacePath === source.mountPath || !!source.mountPath && workspacePath.startsWith(`${source.mountPath}/`)
}

export function sourceMountIntersectsPath(source: Pick<ResolvedWorkspaceSource, "mountPath">, workspacePath: string): boolean {
  return !workspacePath || !source.mountPath || sourceMountContainsPath(source, workspacePath) || source.mountPath.startsWith(`${workspacePath}/`)
}

function normalizeSourceMount(source: WorkspaceSource) {
  if (typeof source.mount === "string") {
    return { path: source.mount }
  }
  return source.mount || {}
}

function normalizeSourceCache(source: Pick<WorkspaceSource, "cache">): false | WorkspaceCacheOptions | undefined {
  if (source.cache === false) return false
  if (source.cache) return defu(source.cache, {})
}

function normalizeSourceSync(sync: WorkspaceSource["sync"]): false | WorkspaceSourceSyncPolicy {
  if (!sync) return false
  if (sync === true) return { stale: "keep" }
  return {
    concurrency: sync.concurrency,
    stale: sync.stale || "keep",
  }
}

function normalizeSourceScopes(key: string, scopes: unknown): readonly string[] {
  if (scopes === undefined) return []
  if (!Array.isArray(scopes) || scopes.some(scope => typeof scope !== "string")) {
    throw new TypeError(`[vitehub] Workspace source "${key}" scopes must be an array of strings.`)
  }
  return scopes.map(scope => scope.trim()).filter(Boolean)
}

function toWorkspaceSource(input: WorkspaceSourceInput): WorkspaceSource {
  if (typeof input === "string") return createInferredWorkspaceSource("file", input)
  if (isExplicitSourceBinding(input)) {
    return applyWorkspaceBinding(toWorkspaceSource(input.source), input)
  }

  const inferred = inferWorkspaceSource(input)
  if (inferred !== input) return applyWorkspaceBinding(inferred as WorkspaceSource, input)
  return input as WorkspaceSource
}

function inferWorkspaceSource(input: WorkspaceSourceInput): WorkspaceSourceInput {
  if (!isPlainRecord(input)) return input
  if (hasSourceMethods(input)) return input

  const providerFamilies: WorkspaceSourceFamily[] = []
  if (hasOwn(input, "repo")) providerFamilies.push("github")
  if (hasOwn(input, "url")) providerFamilies.push("fetch")
  if (hasOwn(input, "server")) providerFamilies.push("mcpResources")

  if (providerFamilies.length > 1) {
    throw ambiguousSourceConfiguration(providerFamilies)
  }

  if (providerFamilies[0]) {
    if (providerFamilies[0] === "github" && (hasOwn(input, "path") || hasOwn(input, "workspacePath") || hasOwn(input, "content"))) {
      throw ambiguousSourceConfiguration(["github", "file"])
    }
    if (providerFamilies[0] === "fetch") return createInferredFetchSource(input)
    return createInferredWorkspaceSource(providerFamilies[0], input)
  }

  const localFamilies: WorkspaceSourceFamily[] = []
  if (hasOwn(input, "include")) localFamilies.push("glob")
  if (hasOwn(input, "path") || hasOwn(input, "workspacePath") || hasOwn(input, "content")) localFamilies.push("file")

  if (localFamilies.length === 0) return input
  if (localFamilies.length > 1) {
    throw ambiguousSourceConfiguration(localFamilies)
  }

  const family = localFamilies[0]
  if (family) return createInferredWorkspaceSource(family, input)
  return input
}

function ambiguousSourceConfiguration(families: WorkspaceSourceFamily[]): TypeError {
  return new TypeError(`[vitehub] Workspace source configuration is ambiguous. Matched ${families.join(", ")}. A { source: ... } wrapper or custom(...) call makes the source kind explicit.`)
}

function createInferredFetchSource(input: WorkspaceSourceInput): WorkspaceSource {
  if (!isPlainRecord(input)) return fetchSource(input as never)
  const record = input as Record<string, unknown>
  const workspacePath = typeof record.workspacePath === "string" ? record.workspacePath : inferFetchWorkspacePath(record)
  return fetchSource({ ...input, workspacePath } as never)
}

function createInferredWorkspaceSource(family: WorkspaceSourceFamily, input: WorkspaceSourceInput): WorkspaceSource {
  let sourcePromise: Promise<WorkspaceSource> | undefined
  const livePaths = inferredLivePaths(family, input)

  async function loadSource() {
    sourcePromise ||= loadInferredWorkspaceSource(family, input)
    return await sourcePromise
  }

  const source: WorkspaceSource = {
    ...inferredSourceDefaults(family, input),
    fingerprint: {
      inferredSource: family,
      options: input,
    },
    async prepare(ctx) {
      const loaded = await loadSource()
      await loaded.prepare?.(ctx)
      copyLivePaths(livePaths, getLiveWorkspaceSourcePaths(loaded))
    },
    async getKeys(ctx) {
      return await (await loadSource()).getKeys(ctx)
    },
    async getItem(key, ctx) {
      return await (await loadSource()).getItem(key, ctx)
    },
    async getItems(ctx) {
      const source = await loadSource()
      return await source.getItems?.(ctx) ?? await Promise.all((await source.getKeys(ctx)).map(async key => await source.getItem(key, ctx)))
    },
    async getMeta(key, ctx) {
      return await (await loadSource()).getMeta?.(key, ctx)
    },
    async search(query, ctx) {
      return await (await loadSource()).search?.(query, ctx) ?? []
    },
  }

  return livePaths ? markLiveWorkspaceSource(source, livePaths) : source
}

async function loadInferredWorkspaceSource(family: WorkspaceSourceFamily, input: WorkspaceSourceInput): Promise<WorkspaceSource> {
  if (family === "fetch" && isPlainRecord(input)) {
    return createInferredFetchSource(input)
  }
  if (family === "fetch") return createInferredFetchSource(input)
  if (family === "file") return (await import("./file.ts")).file(input as never)
  if (family === "github") return (await import("./github.ts")).github(input as never)
  if (family === "glob") return (await import("./glob.ts")).glob(input as never)
  return (await import("./mcp-resources.ts")).mcpResources(input as never)
}

function inferredSourceDefaults(family: WorkspaceSourceFamily, input: WorkspaceSourceInput): Partial<WorkspaceSource> {
  if (!isPlainRecord(input)) {
    return family === "file" ? { mount: "" } : {}
  }

  if (family === "file") {
    const mount = typeof input.mount === "object" && input.mount && !("path" in input.mount)
      ? { ...input.mount, path: "" }
      : input.mount ?? ""
    return copySourceRuntimeOptions(input, { mount })
  }

  if (family === "fetch") {
    const workspacePath = inferFetchWorkspacePath(input)
    const mountPath = dirname(workspacePath)
    return copySourceRuntimeOptions(input, {
      cache: input.cache ?? false,
      materialize: input.materialize || (input.sync ? "none" : "lazy"),
      mount: mountPath,
    })
  }

  if (family === "github") {
    const record = input as Record<string, unknown>
    return copySourceRuntimeOptions(input, {
      mount: input.mount ?? inferRepositoryMount(record.repo),
    })
  }

  if (family === "mcpResources") {
    return copySourceRuntimeOptions(input, {
      materialize: input.materialize || (input.sync ? "none" : "lazy"),
    })
  }

  return copySourceRuntimeOptions(input)
}

function copySourceRuntimeOptions(input: Record<string, unknown>, defaults: Partial<WorkspaceSource> = {}): Partial<WorkspaceSource> {
  return {
    ...defaults,
    cache: input.cache as WorkspaceSource["cache"] ?? defaults.cache,
    materialize: input.materialize as WorkspaceSource["materialize"] ?? defaults.materialize,
    mount: input.mount as WorkspaceSource["mount"] ?? defaults.mount,
    scopes: input.scopes as WorkspaceSource["scopes"] ?? defaults.scopes,
    sync: input.sync as WorkspaceSource["sync"] ?? defaults.sync,
    validate: input.validate as WorkspaceSource["validate"] ?? defaults.validate,
  }
}

function inferredLivePaths(family: WorkspaceSourceFamily, input: WorkspaceSourceInput): Record<string, string> | undefined {
  if (family === "mcpResources") return {}
  if (family !== "fetch" || !isPlainRecord(input)) return undefined

  const workspacePath = inferFetchWorkspacePath(input)
  const mountPath = dirname(workspacePath)
  const key = mountPath ? workspacePath.slice(mountPath.length + 1) : workspacePath
  return { [workspacePath]: key }
}

function copyLivePaths(target: Record<string, string> | undefined, source: Record<string, string> | undefined) {
  if (!target || !source) return
  for (const key of Object.keys(target)) delete target[key]
  for (const [key, value] of Object.entries(source)) target[key] = value
}

function inferFetchWorkspacePath(input: Record<string, unknown>) {
  const responseType = input.responseType === "text" ? "text" : "json"
  const explicitPath = typeof input.path === "string" ? input.path : undefined
  if (explicitPath) return normalizeSafeWorkspacePath(explicitPath, { allowEmpty: false })

  const url = input.url instanceof URL ? input.url : new URL(String(input.url))
  if (url.search) {
    throw new Error("[vitehub] fetch() requires an explicit path when the URL includes query parameters.")
  }

  let path = normalizeSafeWorkspacePath(decodeURI(url.pathname).replace(/^\/+/, ""), { allowEmpty: false })
  if (!basename(path).includes(".")) {
    path = `${path}.${responseType === "json" ? "json" : "txt"}`
  }
  return path
}

function inferRepositoryMount(repo: unknown) {
  return typeof repo === "string" ? repo.split("/").filter(Boolean).at(-1) : undefined
}

function dirname(path: string) {
  const parts = path.split("/").filter(Boolean)
  parts.pop()
  return parts.join("/")
}

function basename(path: string) {
  return path.split("/").filter(Boolean).at(-1) || ""
}

function applyWorkspaceBinding(source: WorkspaceSource, input: WorkspaceSourceInput): WorkspaceSource {
  if (!isPlainRecord(input)) return source
  const next: WorkspaceSource = { ...source }
  copyWorkspaceSourceMetadata(source, next)
  copyDefinedWorkspaceBindingOption(next, input, "cache")
  copyDefinedWorkspaceBindingOption(next, input, "materialize")
  copyDefinedWorkspaceBindingOption(next, input, "mount")
  copyDefinedWorkspaceBindingOption(next, input, "scopes")
  copyDefinedWorkspaceBindingOption(next, input, "sync")
  copyDefinedWorkspaceBindingOption(next, input, "validate")
  return next
}

function copyDefinedWorkspaceBindingOption<TKey extends "cache" | "materialize" | "mount" | "scopes" | "sync" | "validate">(
  target: WorkspaceSource,
  input: Record<string, unknown>,
  key: TKey,
) {
  if (input[key] !== undefined) {
    target[key] = input[key] as never
  }
}

function isExplicitSourceBinding(input: WorkspaceSourceInput): input is WorkspaceSourceInput & { source: WorkspaceSourceInput } {
  return isPlainRecord(input) && hasOwn(input, "source")
}

function hasSourceMethods(input: Record<string, unknown>) {
  return typeof input.getKeys === "function" && typeof input.getItem === "function"
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return !!input && typeof input === "object" && !Array.isArray(input)
}

function hasOwn(input: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(input, key)
}
