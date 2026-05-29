import { workspaceOverrideSymbol } from "../access-runtime.ts"
import { defineCapability } from "../capability-runtime.ts"
import { createWorkspaceTools } from "@vitehub/workspace"

import type {
  AgentCapabilityDefinition,
  AgentCapabilityRuntimeContext,
  AgentRuntimeConfig,
  MaybePromise,
} from "../types.ts"
import type {
  ListOptions,
  ReadonlyWorkspaceFacade,
  WorkspaceDefinition,
  WorkspaceEntry,
  WorkspaceFacadeToolOptions,
  WorkspaceName,
  WorkspaceSearchHit,
  WorkspaceSearchQuery,
} from "@vitehub/workspace"
import type { WorkspaceOverrideRuntime } from "../access-runtime.ts"

export type AccessRoleName = "viewer" | "admin" | (string & {})

export interface AccessWorkspaceScopeGrant {
  path?: string
  paths?: string[]
  source?: string
  sources?: string[]
}

export interface AccessWorkspaceScopeDefinition {
  all?: boolean
  grants?: AccessWorkspaceScopeGrant[]
  path?: string
  paths?: string[]
  source?: string
  sources?: string[]
}

export interface AccessWorkspaceScopeSelection {
  role?: AccessRoleName
  scope: string
}

export type AccessWorkspaceScopeSelectionInput =
  | string
  | AccessWorkspaceScopeSelection

export type AccessWorkspaceScopeResolver<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> = (
  context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>,
) => MaybePromise<AccessWorkspaceScopeSelectionInput | undefined>

export interface AccessWorkspaceOptions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> {
  defaultScope?: string
  resolve?: AccessWorkspaceScopeSelectionInput | AccessWorkspaceScopeResolver<TRuntimeConfig, Name>
  scopes: Record<string, AccessWorkspaceScopeDefinition>
}

export interface AccessCapabilityOptions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> {
  workspace: AccessWorkspaceOptions<TRuntimeConfig, Name>
}

interface ResolvedWorkspaceScope {
  all: boolean
  paths: string[]
  role: AccessRoleName
  scope: string
}

function setWorkspaceOverride<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>,
  workspace: ReadonlyWorkspaceFacade<Name>,
): void {
  const override = (context as AgentCapabilityRuntimeContext<TRuntimeConfig, Name> & Partial<WorkspaceOverrideRuntime<Name>>)[workspaceOverrideSymbol]
  if (!override) {
    throw new Error("[vitehub] access() could not apply Workspace Scope.")
  }
  override(workspace)
}

export function access<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
>(options: AccessCapabilityOptions<TRuntimeConfig, Name>): AgentCapabilityDefinition<TRuntimeConfig, Name> {
  if (!options || typeof options !== "object" || !options.workspace) {
    throw new TypeError("[vitehub] access() requires workspace options.")
  }
  return defineCapability({
    id: "access",
    metadata: { kind: "access", workspace: true },
    requires: [{ primitive: "workspace", workspace: { required: true } }],
    async prepare(context) {
      if (!context.workspace) {
        throw new Error("[vitehub] access({ workspace }) requires an explicit workspace.")
      }
      if ("diff" in context.workspace) {
        throw new Error("[vitehub] access({ workspace }) is read-only in the first version and requires workspace.mode: \"read\".")
      }
      const scope = await resolveWorkspaceScope(options.workspace, context)
      const scopedWorkspace = scope.all
        ? context.workspace
        : createScopedWorkspaceFacade(context.workspace, scope)
      context.context.set("access.workspaceScope", {
        all: scope.all,
        role: scope.role,
        scope: scope.scope,
      })
      setWorkspaceOverride(context, scopedWorkspace)
    },
  })
}

async function resolveWorkspaceScope<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  options: AccessWorkspaceOptions<TRuntimeConfig, Name>,
  context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>,
): Promise<ResolvedWorkspaceScope> {
  const selection = normalizeSelection(await resolveSelection(options, context))
  if (!selection) {
    throw new Error("[vitehub] access({ workspace }) could not resolve a Workspace Scope. Configure defaultScope or resolve().")
  }

  const definition = options.scopes[selection.scope]
  if (!definition) {
    throw new Error(`[vitehub] access({ workspace }) resolved unknown Workspace Scope "${selection.scope}".`)
  }

  const role = selection.role || "viewer"
  const all = definition.all === true
  if (all && role !== "admin") {
    throw new Error(`[vitehub] Workspace Scope "${selection.scope}" requires the admin role.`)
  }

  return {
    all,
    paths: all ? [""] : scopePaths(definition, context.workspaceDefinition),
    role,
    scope: selection.scope,
  }
}

async function resolveSelection<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  options: AccessWorkspaceOptions<TRuntimeConfig, Name>,
  context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>,
): Promise<AccessWorkspaceScopeSelectionInput | undefined> {
  if (options.resolve !== undefined) {
    const resolved = typeof options.resolve === "function"
      ? await options.resolve(context)
      : options.resolve
    return normalizeSelection(resolved) || options.defaultScope
  }
  return options.defaultScope
}

function normalizeSelection(value: unknown): AccessWorkspaceScopeSelection | undefined {
  if (typeof value === "string" && value.trim()) return { scope: value }
  if (!value || typeof value !== "object") return undefined
  const candidate = value as { role?: unknown, scope?: unknown }
  if (typeof candidate.scope !== "string" || !candidate.scope.trim()) return undefined
  return {
    ...(typeof candidate.role === "string" && candidate.role.trim() ? { role: candidate.role } : {}),
    scope: candidate.scope,
  }
}

function scopePaths(definition: AccessWorkspaceScopeDefinition, workspaceDefinition?: WorkspaceDefinition): string[] {
  const paths = [
    ...normalizeStringList(definition.path, definition.paths),
    ...sourcePaths(normalizeStringList(definition.source, definition.sources), workspaceDefinition),
  ]
  for (const grant of definition.grants || []) {
    paths.push(...normalizeStringList(grant.path, grant.paths))
    paths.push(...sourcePaths(normalizeStringList(grant.source, grant.sources), workspaceDefinition))
  }
  const normalized = [...new Set(paths.map(path => normalizeScopePath(path)))]
  if (!normalized.length) {
    throw new Error("[vitehub] Workspace Scope must grant at least one path or source.")
  }
  return normalized.sort((left, right) => left.length - right.length || left.localeCompare(right))
}

function normalizeStringList(single: string | undefined, multiple: string[] | undefined): string[] {
  return [
    ...(single ? [single] : []),
    ...(multiple || []),
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0)
}

function sourcePaths(sources: string[], workspaceDefinition?: WorkspaceDefinition): string[] {
  return sources.map(source => sourceMountPath(source, workspaceDefinition))
}

function sourceMountPath(source: string, workspaceDefinition?: WorkspaceDefinition): string {
  if (!workspaceDefinition) {
    throw new Error(`[vitehub] Workspace Scope source grant "${source}" requires a Workspace Definition.`)
  }
  const definition = workspaceDefinition?.sources?.[source]
  if (!definition) {
    throw new Error(`[vitehub] Workspace Scope source grant references unknown source "${source}".`)
  }
  const mount = definition?.mount
  const mountPath = typeof mount === "string"
    ? mount
    : mount && typeof mount === "object" && typeof mount.path === "string" ? mount.path : source
  if (normalizeScopePath(mountPath) === "") {
    throw new Error(`[vitehub] Workspace Scope source grant "${source}" is root-mounted; grant explicit paths instead.`)
  }
  return mountPath
}

function normalizeScopePath(path = ""): string {
  const raw = path.replace(/\\/g, "/")
  const normalized = raw.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\/+/g, "/")
  const parts = normalized.split("/").filter(Boolean)
  if (raw.startsWith("/") || parts.some(part => part === "." || part === "..")) {
    throw new Error(`[vitehub] Workspace Scope path must stay inside the workspace: "${path}".`)
  }
  return normalized
}

function pathContains(container: string, path: string): boolean {
  return !container || path === container || path.startsWith(`${container}/`)
}

function pathIntersects(left: string, right: string): boolean {
  return pathContains(left, right) || pathContains(right, left)
}

function isReadablePath(scope: ResolvedWorkspaceScope, path: string): boolean {
  return scope.all || scope.paths.some(prefix => pathContains(prefix, path))
}

function isVisiblePath(scope: ResolvedWorkspaceScope, path: string): boolean {
  return scope.all || scope.paths.some(prefix => pathIntersects(prefix, path))
}

function notFound(path: string): Error {
  return new Error(`[vitehub] Workspace path does not exist: ${path || "."}.`)
}

function filterEntries(scope: ResolvedWorkspaceScope, entries: WorkspaceEntry[]): WorkspaceEntry[] {
  return scope.all ? entries : entries.filter(entry => isVisiblePath(scope, entry.path))
}

function filterHits(scope: ResolvedWorkspaceScope, hits: WorkspaceSearchHit[]): WorkspaceSearchHit[] {
  return scope.all ? hits : hits.filter(hit => isReadablePath(scope, hit.path))
}

function scopedSearchQuery(scope: ResolvedWorkspaceScope, query: WorkspaceSearchQuery): WorkspaceSearchQuery | undefined {
  if (scope.all) return query
  const requested = query.paths?.length
    ? query.paths
    : [query.cwd || ""]
  const paths = new Set<string>()
  for (const rawPath of requested) {
    const path = normalizeScopePath(rawPath)
    for (const prefix of scope.paths) {
      if (pathContains(prefix, path)) paths.add(path)
      else if (pathContains(path, prefix)) paths.add(prefix)
    }
  }
  if (!paths.size) return undefined
  return {
    ...query,
    cwd: undefined,
    paths: [...paths],
  }
}

function createScopedWorkspaceFacade<Name extends WorkspaceName>(
  workspace: ReadonlyWorkspaceFacade<Name>,
  scope: ResolvedWorkspaceScope,
): ReadonlyWorkspaceFacade<Name> {
  const fs: ReadonlyWorkspaceFacade<Name>["fs"] = {
    async readFile(path, options) {
      const normalized = normalizeScopePath(path)
      if (!isReadablePath(scope, normalized)) throw notFound(normalized)
      return await workspace.fs.readFile(path, options as never)
    },
    async stat(path) {
      const normalized = normalizeScopePath(path)
      if (!isVisiblePath(scope, normalized)) throw notFound(normalized)
      return await workspace.fs.stat(path)
    },
    async exists(path) {
      const normalized = normalizeScopePath(path)
      return isVisiblePath(scope, normalized) && await workspace.fs.exists(path)
    },
    async list(path, options) {
      const normalized = normalizeScopePath(path || "")
      if (!isVisiblePath(scope, normalized)) return []
      return filterEntries(scope, await workspace.fs.list(path, options as ListOptions))
    },
    async glob(pattern, options) {
      return filterEntries(scope, await workspace.fs.glob(pattern as never, options))
    },
    async search(query) {
      const scopedQuery = scopedSearchQuery(scope, query)
      if (!scopedQuery) return []
      return filterHits(scope, await workspace.fs.search(scopedQuery))
    },
  }

  const createTools = (options?: WorkspaceFacadeToolOptions) => createWorkspaceTools(fs, {
    broadSearchPaths: options?.broadSearchPaths,
    cwd: options?.cwd,
    maxShellCalls: options?.maxShellCalls,
    maxOutputLength: options?.maxOutputLength,
    operations: {
      list: options?.list,
      materialize: false,
      read: options?.read,
      search: options?.search,
    },
    timeout: options?.timeout,
  })
  const tools = createTools() as ReadonlyWorkspaceFacade<Name>["tools"]
  tools.inspect = createTools as ReadonlyWorkspaceFacade<Name>["tools"]["inspect"]
  tools.none = () => ({})

  return {
    fs,
    tools,
  }
}
