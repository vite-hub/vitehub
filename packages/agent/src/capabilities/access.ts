import { workspaceOverrideSymbol } from "../access-runtime.ts"
import { defineCapability } from "../capability-runtime.ts"
import { normalizeAgentWorkspaceSource } from "../workspace-source-metadata.ts"
import {
  attachWorkspaceSourceRequestExecution,
  createWorkspaceSourceResolutionFacade,
  createWorkspaceTools,
  getWorkspaceSourceRequestExecution,
  getWorkspaceSourceRequestDescriptor,
  isWorkspaceSourceRequestOnly,
  workspaceSourceRequestDescriptorPath,
} from "@vite-hub/workspace"

import type {
  AgentCallbackContext,
  AgentCapabilityDefinition,
  AgentCapabilityRuntimeContext,
  AgentCapabilityTypeContract,
  AgentRunInput,
  AgentRuntimeConfig,
  AgentWebhookRegistrationDefinition,
  MaybePromise,
} from "../types.ts"
import type {
  ListOptions,
  ReadonlyWorkspaceFacade,
  WorkspaceDefinition,
  WorkspaceEntry,
  WorkspaceFacadeToolOptions,
  WorkspaceMaterializeSourcesOptions,
  WorkspaceMaterializeSourcesResult,
  WorkspaceName,
  WorkspaceSearchHit,
  WorkspaceSearchQuery,
  WorkspaceSourceInput,
} from "@vite-hub/workspace"
import type { WorkspaceOverrideRuntime } from "../access-runtime.ts"

export type AccessRoleName = "viewer" | "admin" | (string & {})

export type AccessCapabilityTypeContract<
  TSourceName extends string = string,
  TInputContext extends object = Record<string, unknown>,
> = AgentCapabilityTypeContract & {
  inputContext: TInputContext
  workspaceSources: TSourceName
}

type AccessGrantSourceName<TGrant> =
  (TGrant extends { source?: infer TSource }
    ? TSource
    : never)
  | (TGrant extends { sources?: readonly (infer TSource)[] }
    ? TSource
    : never)

type AccessScopeDefinitionSourceName<TDefinition> =
  AccessGrantSourceName<TDefinition>
  | (TDefinition extends { grants?: readonly (infer TGrant)[] }
    ? AccessGrantSourceName<TGrant>
    : never)

type AccessResolvedScopeSelection<TResolve> =
  TResolve extends (...args: any[]) => infer TResult
    ? Awaited<TResult>
    : TResolve

export type AccessWorkspaceScopeSourceName<TWorkspace> =
  Extract<
    (TWorkspace extends { scopes?: infer TScopes }
      ? { [Scope in keyof NonNullable<TScopes>]: AccessScopeDefinitionSourceName<NonNullable<TScopes>[Scope]> }[keyof NonNullable<TScopes>]
      : never)
    | (TWorkspace extends { resolve?: infer TResolve }
      ? AccessScopeDefinitionSourceName<AccessResolvedScopeSelection<NonNullable<TResolve>>>
      : never),
    string
  >

export interface AccessWorkspaceScopeGrant<TSourceName extends string = string> {
  path?: string
  paths?: readonly string[]
  source?: TSourceName
  sources?: readonly TSourceName[]
}

export interface AccessWorkspaceScopeDefinition<TSourceName extends string = string> {
  all?: boolean
  grants?: readonly AccessWorkspaceScopeGrant<TSourceName>[]
  path?: string
  paths?: readonly string[]
  source?: TSourceName
  sources?: readonly TSourceName[]
}

export interface AccessWorkspaceScopeSelection<TSourceName extends string = string> extends AccessWorkspaceScopeDefinition<TSourceName> {
  role?: AccessRoleName
  scope: string
}

export type AccessWorkspaceScopeSelectionInput<TSourceName extends string = string> =
  | string
  | AccessWorkspaceScopeSelection<TSourceName>

export type AccessWorkspaceResolverContext<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
  TInputContext extends object = Record<string, unknown>,
> = Omit<AgentCapabilityRuntimeContext<TRuntimeConfig, Name>, "input"> & {
  input: Omit<AgentCapabilityRuntimeContext<TRuntimeConfig, Name>["input"], "get"> & {
    get: () => AgentRunInput<unknown, TInputContext>
  }
}

export type AccessWorkspaceScopeResolver<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
  TInputContext extends object = Record<string, unknown>,
  TSourceName extends string = string,
> = (
  context: AccessWorkspaceResolverContext<TRuntimeConfig, Name, TInputContext>,
) => MaybePromise<AccessWorkspaceScopeSelectionInput<TSourceName> | undefined>

export interface AccessWorkspaceOptions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
  TSourceName extends string = string,
  TInputContext extends object = Record<string, unknown>,
> {
  defaultScope?: string
  resolve?: AccessWorkspaceScopeSelectionInput<TSourceName> | AccessWorkspaceScopeResolver<TRuntimeConfig, Name, TInputContext, TSourceName>
  scopes?: Record<string, AccessWorkspaceScopeDefinition<TSourceName>>
}

export interface AccessChatIdentity {
  id?: string
  metadata?: Record<string, unknown>
  name?: string
  provider: string
  username?: string
}

export interface AccessChatContext<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>
  extends AgentCallbackContext<TRuntimeConfig> {
  identity?: AccessChatIdentity
  input?: unknown
  provider: string
  request: Request
  webhook: AgentWebhookRegistrationDefinition
}

export type AccessDecision = boolean | void
export type AccessChatResolver<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> =
  (context: AccessChatContext<TRuntimeConfig>) => MaybePromise<AccessDecision>

export interface AccessChatOptions<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> {
  resolve: AccessChatResolver<TRuntimeConfig>
}

export interface AccessCapabilityOptions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
  TSourceName extends string = string,
  TInputContext extends object = Record<string, unknown>,
> {
  chat?: AccessChatOptions<TRuntimeConfig>
  workspace?: AccessWorkspaceOptions<TRuntimeConfig, Name, TSourceName, TInputContext>
}

export type AccessWorkspaceSourceName<TWorkspace extends { sources?: Record<string, WorkspaceSourceInput> }> =
  Extract<keyof NonNullable<TWorkspace["sources"]>, string>

export type AccessWorkspaceOptionsFor<
  TWorkspace extends { sources?: Record<string, WorkspaceSourceInput> },
  TInputContext extends object = Record<string, unknown>,
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> = AccessWorkspaceOptions<TRuntimeConfig, Name, AccessWorkspaceSourceName<TWorkspace>, TInputContext>

interface ResolvedWorkspaceScope {
  all: boolean
  definition: AccessWorkspaceScopeDefinition
  materializeGrants: ResolvedWorkspaceMaterializeGrant[]
  paths: string[]
  role: AccessRoleName
  scope: string
}

interface ResolvedWorkspaceMaterializeGrant {
  path: string
  sources?: string[]
}

interface NormalizedWorkspaceScopeSelection<TSourceName extends string = string> {
  definition?: AccessWorkspaceScopeDefinition<TSourceName>
  role?: AccessRoleName
  scope: string
}

interface AccessCapabilityMetadata<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> {
  access: AccessCapabilityOptions<TRuntimeConfig>
  chat: boolean
  kind: "access"
  workspace: boolean
}

function isAccessMetadata(value: unknown): value is AccessCapabilityMetadata {
  return typeof value === "object"
    && value !== null
    && (value as { kind?: unknown }).kind === "access"
    && typeof (value as { access?: unknown }).access === "object"
    && (value as { access?: unknown }).access !== null
}

export function getAccessCapabilityOptions<TRuntimeConfig extends AgentRuntimeConfig>(
  capabilities: AgentCapabilityDefinition[],
): AccessCapabilityOptions<TRuntimeConfig>[] {
  return capabilities
    .map(capability => capability.id === "access" && isAccessMetadata(capability.metadata) ? capability.metadata.access : undefined)
    .filter((options): options is AccessCapabilityOptions<TRuntimeConfig> => !!options)
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
  TInputContext extends object = Record<string, unknown>,
  const TWorkspace extends AccessWorkspaceOptions<TRuntimeConfig, Name, string, TInputContext> = AccessWorkspaceOptions<TRuntimeConfig, Name, string, TInputContext>,
>(options: { chat?: AccessChatOptions<TRuntimeConfig>, input?: undefined, workspace: TWorkspace }): AgentCapabilityDefinition<TRuntimeConfig, Name, AccessCapabilityTypeContract<AccessWorkspaceScopeSourceName<TWorkspace>, TInputContext>>
export function access<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
>(options: { chat: AccessChatOptions<TRuntimeConfig>, input?: undefined }): AgentCapabilityDefinition<TRuntimeConfig, Name>
export function access(options: AccessCapabilityOptions): AgentCapabilityDefinition {
  if (!options || typeof options !== "object") {
    throw new TypeError("[vitehub] access() requires options.")
  }
  if (!options.chat && !options.workspace) {
    throw new TypeError("[vitehub] access() requires at least one access surface.")
  }
  return defineCapability({
    id: "access",
    metadata: {
      access: options,
      chat: !!options.chat,
      kind: "access",
      workspace: !!options.workspace,
    } satisfies AccessCapabilityMetadata,
    requires: options.workspace
      ? [{ primitive: "workspace", workspace: { required: true } }]
      : undefined,
    async prepare(context) {
      if (!options.workspace) return
      if (!context.workspace) {
        throw new Error("[vitehub] access({ workspace }) requires an explicit workspace.")
      }
      if ("diff" in context.workspace) {
        throw new Error("[vitehub] access({ workspace }) is read-only in the first version and requires workspace.mode: \"read\".")
      }
      const scope = await resolveWorkspaceScope(options.workspace, context)
      const sourceResolution = context.workspaceDefinition
        ? await createWorkspaceSourceResolutionFacade(context.workspace, context.workspaceDefinition, {
            invocation: {
              context: context.context,
              run: context.run,
            },
            selectedWorkspaceScope: {
              all: scope.all,
              paths: scope.paths,
              role: scope.role,
              scope: scope.scope,
            },
          })
        : { definition: context.workspaceDefinition, workspace: context.workspace }
      const finalScope = finalizeResolvedWorkspaceScope(scope, sourceResolution.definition)
      const scopedWorkspace = finalScope.all
        ? sourceResolution.workspace
        : createScopedWorkspaceFacade(sourceResolution.workspace, finalScope)
      context.context.set("access.workspaceScope", {
        all: finalScope.all,
        paths: finalScope.paths,
        role: finalScope.role,
        scope: finalScope.scope,
      })
      if (sourceResolution.definition && sourceResolution.definition !== context.workspaceDefinition) {
        context.context.set("workspace.sourceResolution.definition", sourceResolution.definition)
      }
      setWorkspaceOverride(context, scopedWorkspace)
    },
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function resolveWorkspaceScope<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
  TSourceName extends string,
  TInputContext extends object,
>(
  options: AccessWorkspaceOptions<TRuntimeConfig, Name, TSourceName, TInputContext>,
  context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>,
): Promise<ResolvedWorkspaceScope> {
  const selection = normalizeSelection(await resolveSelection(options, context))
  if (!selection) {
    throw new Error("[vitehub] access({ workspace }) could not resolve a Workspace Scope. Configure defaultScope or resolve().")
  }

  const definition = selection.definition || options.scopes?.[selection.scope]
  if (!definition) {
    throw new Error(`[vitehub] access({ workspace }) resolved unknown Workspace Scope "${selection.scope}". Configure scopes.${selection.scope} or return an inline scope definition.`)
  }

  const role = selection.role || "viewer"
  const all = definition.all === true
  if (all && role !== "admin") {
    throw new Error(`[vitehub] Workspace Scope "${selection.scope}" requires the admin role.`)
  }

  return {
    all,
    definition,
    materializeGrants: all ? [{ path: "" }] : scopeMaterializeGrants(definition, context.workspaceDefinition),
    paths: all ? [""] : scopePaths(definition, context.workspaceDefinition),
    role,
    scope: selection.scope,
  }
}

function finalizeResolvedWorkspaceScope(scope: ResolvedWorkspaceScope, workspaceDefinition: WorkspaceDefinition | undefined): ResolvedWorkspaceScope {
  if (scope.all) return scope
  return {
    ...scope,
    materializeGrants: scopeMaterializeGrants(scope.definition, workspaceDefinition),
    paths: scopePaths(scope.definition, workspaceDefinition),
  }
}

async function resolveSelection<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
  TSourceName extends string,
  TInputContext extends object,
>(
  options: AccessWorkspaceOptions<TRuntimeConfig, Name, TSourceName, TInputContext>,
  context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>,
): Promise<AccessWorkspaceScopeSelectionInput<TSourceName> | undefined> {
  if (options.resolve !== undefined) {
    const resolved = typeof options.resolve === "function"
      ? await options.resolve(context as AccessWorkspaceResolverContext<TRuntimeConfig, Name, TInputContext>)
      : options.resolve
    return normalizeSelection(resolved) ? resolved : options.defaultScope
  }
  return options.defaultScope
}

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0
}

function hasNonEmptyStringList(value: unknown): boolean {
  return Array.isArray(value) && value.some(hasNonEmptyString)
}

function hasNonEmptyScopeGrant(value: unknown): boolean {
  return isRecord(value)
    && (hasNonEmptyString(value.path)
      || hasNonEmptyStringList(value.paths)
      || hasNonEmptyString(value.source)
      || hasNonEmptyStringList(value.sources))
}

function hasInlineScopeDefinition(value: Record<string, unknown>): boolean {
  return value.all === true
    || (Array.isArray(value.grants) && value.grants.some(hasNonEmptyScopeGrant))
    || hasNonEmptyScopeGrant(value)
}

function normalizeSelection<TSourceName extends string>(value: unknown): NormalizedWorkspaceScopeSelection<TSourceName> | undefined {
  if (typeof value === "string" && value.trim()) return { scope: value }
  if (!value || typeof value !== "object") return undefined
  const candidate = value as { role?: unknown, scope?: unknown }
  if (typeof candidate.scope !== "string" || !candidate.scope.trim()) return undefined
  return {
    ...(hasInlineScopeDefinition(value as Record<string, unknown>)
      ? { definition: value as AccessWorkspaceScopeDefinition<TSourceName> }
      : {}),
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

function scopeMaterializeGrants(definition: AccessWorkspaceScopeDefinition, workspaceDefinition?: WorkspaceDefinition): ResolvedWorkspaceMaterializeGrant[] {
  const grants: ResolvedWorkspaceMaterializeGrant[] = []
  const add = (path: string, sources?: string[]) => {
    grants.push({
      path: normalizeScopePath(path),
      ...(sources?.length ? { sources } : {}),
    })
  }
  const addSource = (source: string) => {
    const path = sourceMaterializePath(source, workspaceDefinition)
    if (path !== undefined) add(path, [source])
  }
  for (const path of normalizeStringList(definition.path, definition.paths)) add(path)
  for (const source of normalizeStringList(definition.source, definition.sources)) addSource(source)
  for (const grant of definition.grants || []) {
    const paths = normalizeStringList(grant.path, grant.paths)
    const sources = normalizeStringList(grant.source, grant.sources)
    for (const path of paths) add(path)
    for (const source of sources) addSource(source)
  }
  return dedupeMaterializeGrants(grants)
}

function dedupeMaterializeGrants(grants: ResolvedWorkspaceMaterializeGrant[]): ResolvedWorkspaceMaterializeGrant[] {
  const seen = new Set<string>()
  return grants.filter((grant) => {
    const key = `${grant.path}\0${grant.sources?.join("\0") || ""}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function normalizeStringList(single: string | undefined, multiple: readonly string[] | undefined): string[] {
  return [
    ...(single ? [single] : []),
    ...(multiple || []),
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0)
}

function sourcePaths(sources: string[], workspaceDefinition?: WorkspaceDefinition): string[] {
  return sources.flatMap(source => sourceScopePaths(source, workspaceDefinition))
}

function sourceMaterializePath(source: string, workspaceDefinition?: WorkspaceDefinition): string | undefined {
  const paths = sourceScopePaths(source, workspaceDefinition).filter(path => !path.startsWith(".vitehub/sources/"))
  return paths[0]
}

function sourceScopePaths(source: string, workspaceDefinition?: WorkspaceDefinition): string[] {
  if (!workspaceDefinition) {
    throw new Error(`[vitehub] Workspace Scope source grant "${source}" requires a Workspace Definition.`)
  }
  const definition = workspaceDefinition?.sources?.[source]
  if (!definition) {
    throw new Error(`[vitehub] Workspace Scope source grant references unknown source "${source}".`)
  }
  const metadata = normalizeAgentWorkspaceSource(source, definition)
  const descriptorSource = metadata.source
  const descriptorPath = descriptorSource && getWorkspaceSourceRequestDescriptor(descriptorSource)
    ? workspaceSourceRequestDescriptorPath(source)
    : undefined
  if (descriptorSource && isWorkspaceSourceRequestOnly(descriptorSource)) {
    return descriptorPath ? [descriptorPath] : []
  }
  const mountPath = metadata.mountPath
  if (normalizeScopePath(mountPath) === "") {
    throw new Error(`[vitehub] Workspace Scope source grant "${source}" is root-mounted; grant explicit paths instead.`)
  }
  return [
    mountPath,
    ...(descriptorPath ? [descriptorPath] : []),
  ]
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

function filterMaterializedSources(scope: ResolvedWorkspaceScope, result: WorkspaceMaterializeSourcesResult): WorkspaceMaterializeSourcesResult {
  return scope.all
    ? result
    : {
        ...result,
        sources: result.sources.filter(source => isVisiblePath(scope, normalizeScopePath(source.mountPath))),
      }
}

function scopedMaterializeSourceRequests(scope: ResolvedWorkspaceScope, options: WorkspaceMaterializeSourcesOptions): WorkspaceMaterializeSourcesOptions[] {
  if (scope.all) return [options]
  const requested = normalizeScopePath(options.path || "")
  const requests: WorkspaceMaterializeSourcesOptions[] = []
  const seen = new Set<string>()
  for (const grant of scope.materializeGrants) {
    const path = options.path && pathContains(grant.path, requested)
      ? requested
      : !options.path || pathContains(requested, grant.path)
        ? grant.path
        : undefined
    if (path === undefined) continue
    const sources = scopedMaterializeSources(grant, options)
    if (sources === false) continue
    const key = `${path}\0${sources?.join("\0") || ""}`
    if (seen.has(key)) continue
    seen.add(key)
    requests.push({
      ...options,
      path,
      ...(sources ? { sources } : {}),
    })
  }
  return requests
}

function scopedMaterializeSources(grant: ResolvedWorkspaceMaterializeGrant, options: WorkspaceMaterializeSourcesOptions): string[] | false | undefined {
  if (!grant.sources?.length) return options.sources
  if (!options.sources?.length) return grant.sources
  const allowed = new Set(grant.sources)
  const sources = options.sources.filter(source => allowed.has(source))
  return sources.length ? sources : false
}

function mergeMaterializedSources(path: string, results: WorkspaceMaterializeSourcesResult[]): WorkspaceMaterializeSourcesResult {
  return {
    bytes: results.reduce((total, result) => total + result.bytes, 0),
    directories: results.reduce((total, result) => total + result.directories, 0),
    durationMs: results.reduce((total, result) => total + result.durationMs, 0),
    files: results.reduce((total, result) => total + result.files, 0),
    path,
    sources: results.flatMap(result => result.sources),
  }
}

function emptyMaterializedSources(path = ""): WorkspaceMaterializeSourcesResult {
  return {
    bytes: 0,
    directories: 0,
    durationMs: 0,
    files: 0,
    path,
    sources: [],
  }
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
  const fs = attachWorkspaceSourceRequestExecution({
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
    async materializeSources(options = {}) {
      const normalized = normalizeScopePath(options.path || "")
      if (options.path && !isVisiblePath(scope, normalized)) throw notFound(normalized)
      const requests = scopedMaterializeSourceRequests(scope, options)
      const results = await Promise.all(requests.map(async (request) => {
        const result = workspace.fs.materializeSources
          ? await workspace.fs.materializeSources(request)
          : emptyMaterializedSources(request.path)
        return filterMaterializedSources(scope, result)
      }))
      return mergeMaterializedSources(options.path || "", results)
    },
  } satisfies ReadonlyWorkspaceFacade<Name>["fs"], getWorkspaceSourceRequestExecution(workspace.fs))

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
