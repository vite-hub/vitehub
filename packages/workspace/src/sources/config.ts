import { defu } from "defu"

import { normalizeSafeWorkspacePath } from "../core/path.ts"
import { fetch } from "./fetch.ts"
import { file } from "./file.ts"
import { github } from "./github.ts"
import { glob } from "./glob.ts"
import { getLiveWorkspaceSourcePaths } from "./live.ts"
import { mcpResources } from "./mcp-resources.ts"

import type {
  SourceContext,
  WorkspaceCacheOptions,
  WorkspaceDefinition,
  WorkspaceMaterializeMode,
  WorkspaceSource,
  WorkspaceSourceInput,
  WorkspaceSourceSyncPolicy,
  WorkspaceValidateMode,
} from "../core/types.ts"

export interface ResolvedWorkspaceSource {
  key: string
  source: WorkspaceSource
  mountPath: string
  materialize: WorkspaceMaterializeMode
  cache: false | WorkspaceCacheOptions
  sync: false | WorkspaceSourceSyncPolicy
  validate: WorkspaceValidateMode
  instructions?: WorkspaceSource["instructions"]
  livePaths?: Record<string, string>
  readonly: true
}

export function createSourceContext(definition: WorkspaceDefinition, source?: { key: string, mountPath: string }): SourceContext {
  return {
    mountPath: source?.mountPath,
    rootDir: definition.rootDir || process.cwd(),
    source: source?.key,
    sourceRootDir: definition.sourceRootDir,
    workspace: definition.name,
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
  const mount = normalizeSourceMount(source)
  const cache = mount.cache ?? normalizeSourceCache(source) ?? false
  const sync = normalizeSourceSync(source.sync)
  const mountPath = typeof mount.path === "string" ? mount.path : key
  return {
    key,
    source,
    mountPath: normalizeSafeWorkspacePath(mountPath, { allowEmpty: true }),
    materialize: mount.materialize || source.materialize || (cache ? "lazy" : sync ? "none" : "build"),
    cache,
    sync,
    validate: mount.validate ?? source.validate ?? false,
    instructions: source.instructions,
    livePaths: getLiveWorkspaceSourcePaths(source),
    readonly: true,
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

function toWorkspaceSource(input: WorkspaceSourceInput): WorkspaceSource {
  if (typeof input === "string") return file(input)
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

  const families: string[] = []
  if (hasOwn(input, "repo")) families.push("github")
  if (hasOwn(input, "url")) families.push("fetch")
  if (hasOwn(input, "server")) families.push("mcpResources")
  if (!families.length && hasOwn(input, "include")) families.push("glob")
  if (!families.length && (hasOwn(input, "path") || hasOwn(input, "workspacePath") || hasOwn(input, "content"))) families.push("file")

  if (families.length === 0) return input
  if (families.length > 1) {
    throw new TypeError(`[vitehub] Workspace source configuration is ambiguous. Matched ${families.join(", ")}. Use { source: ... } or source.custom(...) to make the source kind explicit.`)
  }

  const family = families[0]
  if (family === "github") return github(input as never)
  if (family === "fetch") return fetch(input as never)
  if (family === "glob") return glob(input as never)
  if (family === "mcpResources") return mcpResources(input as never)
  if (family === "file") return file(input as never)
  return input
}

function applyWorkspaceBinding(source: WorkspaceSource, input: WorkspaceSourceInput): WorkspaceSource {
  if (!isPlainRecord(input)) return source
  const next: WorkspaceSource = { ...source }
  copyDefinedWorkspaceBindingOption(next, input, "cache")
  copyDefinedWorkspaceBindingOption(next, input, "instructions")
  copyDefinedWorkspaceBindingOption(next, input, "materialize")
  copyDefinedWorkspaceBindingOption(next, input, "mount")
  copyDefinedWorkspaceBindingOption(next, input, "sync")
  copyDefinedWorkspaceBindingOption(next, input, "validate")
  return next
}

function copyDefinedWorkspaceBindingOption<TKey extends "cache" | "instructions" | "materialize" | "mount" | "sync" | "validate">(
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
