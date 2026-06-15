import type {
  WorkspaceCacheOptions,
  WorkspaceDefinition,
  WorkspaceMaterializeMode,
  WorkspaceSource,
  WorkspaceSourceInput,
  WorkspaceSourceInstructions,
  WorkspaceSourceMount,
  WorkspaceSourceSyncConfig,
} from "@vite-hub/workspace"

type WorkspaceSourceFamily = "fetch" | "file" | "github" | "glob" | "mcpResources"

interface WorkspaceSourceMetadataDescriptor {
  cache?: false | WorkspaceCacheOptions
  defaultMaterialize?: WorkspaceMaterializeMode
  instructions?: WorkspaceSourceInstructions
  materialize?: WorkspaceMaterializeMode
  mount?: WorkspaceSourceMount
  probeKeys?: string[]
  source?: WorkspaceSource
  sync?: WorkspaceSourceSyncConfig
}

export interface AgentWorkspaceSourceMetadata {
  cache: false | WorkspaceCacheOptions
  instructions?: WorkspaceSourceInstructions
  key: string
  materialize: WorkspaceMaterializeMode
  mountPath: string
  probeKeys?: string[]
  source?: WorkspaceSource
  sync: false | WorkspaceSourceSyncConfig
}

export function normalizeAgentWorkspaceSources(sources: WorkspaceDefinition["sources"]): AgentWorkspaceSourceMetadata[] {
  if (!sources) return []

  return Object.entries(sources)
    .map(([key, source]) => normalizeAgentWorkspaceSource(key, source))
    .sort((left, right) => right.mountPath.length - left.mountPath.length || left.key.localeCompare(right.key))
}

export function normalizeAgentWorkspaceSource(key: string, input: WorkspaceSourceInput): AgentWorkspaceSourceMetadata {
  const descriptor = describeWorkspaceSourceInput(input)
  const mount = normalizeSourceMount(descriptor.mount)
  const cache = normalizeSourceCache(mount.cache ?? descriptor.cache) ?? false
  const sync = normalizeSourceSync(descriptor.sync)
  const mountPath = typeof mount.path === "string" ? mount.path : key

  return {
    cache,
    ...(descriptor.instructions ? { instructions: descriptor.instructions } : {}),
    key,
    materialize: mount.materialize || descriptor.materialize || descriptor.defaultMaterialize || (cache ? "lazy" : sync ? "none" : "build"),
    mountPath: normalizeAgentWorkspacePath(mountPath, { allowEmpty: true }),
    ...(descriptor.probeKeys?.length ? { probeKeys: descriptor.probeKeys } : {}),
    ...(descriptor.source ? { source: descriptor.source } : {}),
    sync,
  }
}

function describeWorkspaceSourceInput(input: WorkspaceSourceInput): WorkspaceSourceMetadataDescriptor {
  if (typeof input === "string") {
    return {
      mount: "",
      probeKeys: [fileSourceKey({ path: input })],
    }
  }

  if (!isPlainRecord(input)) return {}

  if (isExplicitSourceBinding(input)) {
    return applyWorkspaceSourceBinding(describeWorkspaceSourceInput(input.source), input)
  }

  if (hasSourceMethods(input)) {
    return copySourceRuntimeOptions(input, { source: input as unknown as WorkspaceSource })
  }

  const family = inferWorkspaceSourceFamily(input)
  if (family === "file") return copySourceRuntimeOptions(input, fileSourceDefaults(input))
  if (family === "fetch") return copySourceRuntimeOptions(input, fetchSourceDefaults(input))
  if (family === "github") return copySourceRuntimeOptions(input, githubSourceDefaults(input))
  if (family === "mcpResources") return copySourceRuntimeOptions(input, mcpResourcesSourceDefaults(input))

  return copySourceRuntimeOptions(input)
}

function inferWorkspaceSourceFamily(input: Record<string, unknown>): WorkspaceSourceFamily | undefined {
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
    return providerFamilies[0]
  }

  const localFamilies: WorkspaceSourceFamily[] = []
  if (hasOwn(input, "include")) localFamilies.push("glob")
  if (hasOwn(input, "path") || hasOwn(input, "workspacePath") || hasOwn(input, "content")) localFamilies.push("file")

  if (localFamilies.length > 1) {
    throw ambiguousSourceConfiguration(localFamilies)
  }

  return localFamilies[0]
}

function ambiguousSourceConfiguration(families: WorkspaceSourceFamily[]): TypeError {
  return new TypeError(`[vitehub] Workspace source configuration is ambiguous. Matched ${families.join(", ")}. Use { source: ... } or source.custom(...) to make the source kind explicit.`)
}

function fileSourceDefaults(input: Record<string, unknown>): WorkspaceSourceMetadataDescriptor {
  const mount = typeof input.mount === "object" && input.mount && !hasOwn(input.mount as Record<string, unknown>, "path")
    ? { ...input.mount as object, path: "" } as WorkspaceSourceMount
    : input.mount as WorkspaceSourceMount | undefined ?? ""
  return {
    mount,
    probeKeys: [fileSourceKey(input)],
  }
}

function fetchSourceDefaults(input: Record<string, unknown>): WorkspaceSourceMetadataDescriptor {
  const workspacePath = inferFetchWorkspacePath(input)
  const mountPath = dirname(workspacePath)
  const key = mountPath ? workspacePath.slice(mountPath.length + 1) : workspacePath
  return {
    cache: input.cache as WorkspaceCacheOptions | false | undefined ?? false,
    materialize: input.materialize as WorkspaceMaterializeMode | undefined || (input.sync ? "none" : "lazy"),
    mount: mountPath,
    probeKeys: [key],
  }
}

function githubSourceDefaults(input: Record<string, unknown>): WorkspaceSourceMetadataDescriptor {
  return {
    mount: input.mount as WorkspaceSourceMount | undefined ?? inferRepositoryMount(input.repo),
  }
}

function mcpResourcesSourceDefaults(input: Record<string, unknown>): WorkspaceSourceMetadataDescriptor {
  return {
    materialize: input.materialize as WorkspaceMaterializeMode | undefined || (input.sync ? "none" : "lazy"),
  }
}

function copySourceRuntimeOptions(
  input: Record<string, unknown>,
  defaults: WorkspaceSourceMetadataDescriptor = {},
): WorkspaceSourceMetadataDescriptor {
  return {
    ...defaults,
    cache: input.cache as WorkspaceSourceMetadataDescriptor["cache"] ?? defaults.cache,
    instructions: input.instructions as WorkspaceSourceInstructions | undefined ?? defaults.instructions,
    materialize: input.materialize as WorkspaceMaterializeMode | undefined ?? defaults.materialize,
    mount: input.mount as WorkspaceSourceMount | undefined ?? defaults.mount,
    sync: input.sync as WorkspaceSourceSyncConfig | undefined ?? defaults.sync,
  }
}

function applyWorkspaceSourceBinding(
  descriptor: WorkspaceSourceMetadataDescriptor,
  input: Record<string, unknown>,
): WorkspaceSourceMetadataDescriptor {
  return {
    ...descriptor,
    cache: hasOwn(input, "cache") ? input.cache as WorkspaceSourceMetadataDescriptor["cache"] : descriptor.cache,
    instructions: hasOwn(input, "instructions") ? input.instructions as WorkspaceSourceInstructions | undefined : descriptor.instructions,
    materialize: hasOwn(input, "materialize") ? input.materialize as WorkspaceMaterializeMode | undefined : descriptor.materialize,
    mount: hasOwn(input, "mount") ? input.mount as WorkspaceSourceMount | undefined : descriptor.mount,
    sync: hasOwn(input, "sync") ? input.sync as WorkspaceSourceSyncConfig | undefined : descriptor.sync,
  }
}

function normalizeSourceMount(mount: WorkspaceSourceMount | undefined): { path?: string, materialize?: WorkspaceMaterializeMode, cache?: false | WorkspaceCacheOptions } {
  if (typeof mount === "string") return { path: mount }
  return mount || {}
}

function normalizeSourceCache(cache: false | WorkspaceCacheOptions | undefined): false | WorkspaceCacheOptions | undefined {
  if (cache === false) return false
  if (cache) return cache
}

function normalizeSourceSync(sync: WorkspaceSourceSyncConfig | undefined): false | WorkspaceSourceSyncConfig {
  if (!sync) return false
  return sync
}

function isExplicitSourceBinding(input: Record<string, unknown>): input is Record<string, unknown> & { source: WorkspaceSourceInput } {
  return hasOwn(input, "source")
}

function hasSourceMethods(input: Record<string, unknown>) {
  return typeof input.getKeys === "function"
}

function fileSourceKey(input: Record<string, unknown>): string {
  if (typeof input.workspacePath === "string") return normalizeAgentSourcePath(input.workspacePath, { allowEmpty: false })
  if (typeof input.path === "string") return normalizeAgentSourcePath(basename(normalizeAgentSourcePath(input.path, { allowEmpty: false })), { allowEmpty: false })
  throw new TypeError("[vitehub] source.file requires a path or workspacePath.")
}

function inferFetchWorkspacePath(input: Record<string, unknown>) {
  const responseType = input.responseType === "text" ? "text" : "json"
  const explicitPath = typeof input.path === "string" ? input.path : undefined
  if (explicitPath) return normalizeAgentWorkspacePath(explicitPath, { allowEmpty: false })

  const url = input.url instanceof URL ? input.url : new URL(String(input.url))
  if (url.search) {
    throw new Error("[vitehub] source.fetch() requires an explicit path when the URL includes query parameters.")
  }

  let path = normalizeAgentWorkspacePath(decodeURI(url.pathname).replace(/^\/+/, ""), { allowEmpty: false })
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
  return path.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) || ""
}

function normalizeAgentWorkspacePath(path: string, options: { allowEmpty: boolean }): string {
  return normalizeSafePath(path, "Workspace path", options)
}

function normalizeAgentSourcePath(path: string, options: { allowEmpty: boolean }): string {
  return normalizeSafePath(path, "Source path", options)
}

function normalizeSafePath(path: string, label: string, options: { allowEmpty: boolean }): string {
  const raw = path.replace(/\\/g, "/")
  const normalized = raw.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\/+/g, "/")
  const parts = normalized.split("/").filter(Boolean)
  if (raw.startsWith("/") || parts.some(part => part === "." || part === "..")) {
    throw new Error(`[vitehub] ${label} must stay inside the workspace: "${path}".`)
  }
  if (!options.allowEmpty && !normalized) {
    throw new Error(`[vitehub] ${label} must not be empty.`)
  }
  return normalized
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return !!input && typeof input === "object" && !Array.isArray(input)
}

function hasOwn(input: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(input, key)
}
