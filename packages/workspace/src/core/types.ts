import type { Source as SourcePackageSource } from "@vite-hub/source"
import type { FileSourceOptions as SourcePackageFileSourceOptions } from "@vite-hub/source/file"
import type { GitHubSourceOptions as SourcePackageGitHubSourceOptions } from "@vite-hub/source/github"
import type { GlobSourceOptions as SourcePackageGlobSourceOptions } from "@vite-hub/source/glob"
import type { McpResourcesSourceOptions as SourcePackageMcpResourcesSourceOptions } from "@vite-hub/source/mcp"
import type { ExecutionAuthority } from "@vite-hub/runtime"

export type WorkspaceContent = string | Uint8Array
export type WorkspaceContentStream = ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>

export interface ReadFileOptions {
  encoding?: "utf8" | "binary"
}

export type ReadFileResult<TOptions extends ReadFileOptions | undefined = undefined> =
  TOptions extends { encoding: "binary" } ? Uint8Array : string

export interface WriteFileOptions {
  ifDigest?: string | null
  mediaType?: string
  metadata?: Record<string, unknown>
  preservePath?: boolean
}

export type WorkspaceSessionWriteFileOptions = Omit<WriteFileOptions, "ifDigest" | "preservePath">

export interface ListOptions {
  exclude?: string[]
  recursive?: boolean
}

export interface GlobOptions {
  cwd?: string
}

export interface WorkspaceSearchQuery {
  pattern: string
  cwd?: string
  paths?: string[]
  regex?: boolean
  caseSensitive?: boolean
  limit?: number
}

export interface WorkspaceSearchHit {
  path: string
  line: number
  column: number
  text: string
}

export interface MkdirOptions {
  recursive?: boolean
}

export interface RmOptions {
  recursive?: boolean
  force?: boolean
}

export type WorkspaceWriteOperation = "writeFile" | "mkdir" | "rm"

export type WorkspaceWriteMode = boolean | "create" | "update" | "delete"

export interface WorkspaceWriteInput {
  workspace: string
  operation: WorkspaceWriteOperation
  path: string
  content?: WorkspaceContent
  mediaType?: string
  metadata?: Record<string, unknown>
  previous?: WorkspaceStat
  rule?: ResolvedWorkspaceRule
}

export type WorkspaceWriteValidatorResult = boolean | void | WorkspaceWriteInput

export type WorkspaceWriteValidator =
  (input: WorkspaceWriteInput) => WorkspaceWriteValidatorResult | Promise<WorkspaceWriteValidatorResult>

export interface WorkspaceRule {
  commit?: boolean | string
  read?: boolean
  write?: WorkspaceWriteMode
  maxBytes?: number | `${number}kb` | `${number}mb`
  mediaType?: string | string[]
  validate?: WorkspaceWriteValidator | WorkspaceWriteValidator[]
}

export type WorkspaceRules = Record<string, WorkspaceRule>

export interface ResolvedWorkspaceRule extends Omit<WorkspaceRule, "maxBytes" | "validate"> {
  maxBytes?: number
  pattern: string
  validate: WorkspaceWriteValidator[]
}

export interface WorkspaceHookContext extends WorkspaceWriteInput {}

export interface WorkspaceHooks {
  "write:before"?: WorkspaceWriteHook | WorkspaceWriteHook[]
  "write:validate"?: WorkspaceWriteHook | WorkspaceWriteHook[]
  "write:after"?: WorkspaceWriteHook | WorkspaceWriteHook[]
  "write:error"?: WorkspaceWriteErrorHook | WorkspaceWriteErrorHook[]
}

export type WorkspaceWriteHook = (ctx: WorkspaceHookContext) => void | Promise<void>
export type WorkspaceWriteErrorHook = (ctx: WorkspaceHookContext & { error: unknown }) => void | Promise<void>

export interface WorkspacePlugin {
  id: string
  rules?: WorkspaceRules
  hooks?: WorkspaceHooks
}

export interface SnapshotOptions {
  name?: string
}

export interface WorkspacePublishOptions {
  name?: string
}

export interface DiffOptions {
  from?: WorkspaceSnapshot
}

export type WorkspaceSourceSelection = "all" | readonly string[]

export type WorkspaceSyncResultDetails = "counts" | "paths"

export interface WorkspaceSyncSnapshotOptions extends SnapshotOptions {
  message?: string
}

export interface WorkspaceSyncOptions {
  details?: WorkspaceSyncResultDetails
  publish?: boolean
  publishPartial?: boolean
  snapshot?: boolean | WorkspaceSyncSnapshotOptions
  sources: WorkspaceSourceSelection
}

export interface WorkspaceSessionOptions {
  abortSignal?: AbortSignal
  attach?: boolean
  host?: WorkspaceSessionHost
  onProgress?: (event: WorkspacePrepareSessionProgressEvent) => void | Promise<void>
  paths?: readonly string[]
  target?: string
  writeBack?: {
    exclude?: readonly string[]
  }
}

export interface WorkspaceSessionHostFileEntry {
  executable?: boolean
  path: string
  size?: number
  type: "directory" | "file" | "symlink"
}

export interface WorkspaceSessionHostFiles {
  exists(path: string): Promise<boolean>
  list(path: string, options?: { recursive?: boolean }): Promise<readonly WorkspaceSessionHostFileEntry[]>
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>
  read(path: string): Promise<Uint8Array | null>
  remove(path: string, options?: { recursive?: boolean }): Promise<void>
  write(path: string, content: Uint8Array): Promise<void>
}

export interface WorkspaceSessionHost {
  readonly executionAuthority: ExecutionAuthority
  detachAbortSignal?(): void
  files: WorkspaceSessionHostFiles
  exec(
    command: string,
    args?: readonly string[],
    options?: {
    cwd?: string
    env?: Readonly<Record<string, string>>
    signal?: AbortSignal
    timeout?: number
    },
  ): Promise<{ code: number, stderr: string, stdout: string }>
}

export interface ExecOptions {
  abortSignal?: AbortSignal
  cwd?: string
  env?: Record<string, string>
  timeout?: number
}

export interface ExecResult {
  command: string
  args: string[]
  exitCode: number
  stdout: string
  stderr: string
}

export interface WorkspaceSession {
  readonly executionAuthority: ExecutionAuthority
  readFile<TOptions extends ReadFileOptions | undefined = undefined>(path: string, options?: TOptions): Promise<ReadFileResult<TOptions>>
  writeFile(path: string, content: WorkspaceContent, options?: WorkspaceSessionWriteFileOptions): Promise<void>
  mkdir(path: string, options?: MkdirOptions): Promise<void>
  rm(path: string, options?: RmOptions): Promise<void>
  list(path?: string, options?: ListOptions): Promise<WorkspaceEntry[]>
  glob(pattern: string | string[], options?: GlobOptions): Promise<WorkspaceEntry[]>
  search(query: WorkspaceSearchQuery): Promise<WorkspaceSearchHit[]>
  diff(): Promise<WorkspaceDiff>
  commit(options?: { message?: string }): Promise<void>
  exec(command: string, args?: string[], options?: ExecOptions): Promise<ExecResult>
  tools?: {
    aiSdk?(): Promise<Record<string, unknown>>
  }
  close(): Promise<void>
}

declare global {
  interface ViteHubWorkspaceNameMap {}
  interface ViteHubWorkspaceAssetMap {}
  interface ViteHubWorkspaceSourceResolutionContextMap {}
  interface ViteHubWorkspaceScopeNameMap {}
}

export interface WorkspaceNameMap extends ViteHubWorkspaceNameMap {}
export interface WorkspaceSourceResolutionContextMap extends ViteHubWorkspaceSourceResolutionContextMap {}

export type WorkspaceName = [keyof ViteHubWorkspaceNameMap] extends [never] ? string : Extract<keyof ViteHubWorkspaceNameMap, string>
export type WorkspaceScopeName = [keyof ViteHubWorkspaceScopeNameMap] extends [never] ? string : Extract<keyof ViteHubWorkspaceScopeNameMap, string>

export type WorkspaceAssetPath<Name extends WorkspaceName = WorkspaceName> =
  Name extends keyof ViteHubWorkspaceAssetMap
    ? Extract<ViteHubWorkspaceAssetMap[Name], string>
    : string

export interface WorkspaceAssets<TKey extends string = string> {
  readFile<TOptions extends ReadFileOptions | undefined = undefined>(path: TKey, options?: TOptions): Promise<ReadFileResult<TOptions>>
  stat(path: TKey): Promise<WorkspaceStat>
  exists(path: TKey): Promise<boolean>
  list(path?: TKey | (string & {}) | "", options?: ListOptions): Promise<WorkspaceEntry[]>
  glob(pattern: TKey | (string & {}) | Array<TKey | (string & {})>, options?: GlobOptions): Promise<WorkspaceEntry[]>
  search(query: WorkspaceSearchQuery): Promise<WorkspaceSearchHit[]>
  materializeSources?(options?: WorkspaceMaterializeSourcesOptions): Promise<WorkspaceMaterializeSourcesResult>
}

export type WorkspaceAssetsRegistry = Record<string, WorkspaceAssets>

export interface WorkspaceFile {
  path: string
  content: WorkspaceContent
  mediaType?: string
  metadata?: Record<string, unknown>
}

export interface WorkspaceStreamFile {
  path: string
  content: WorkspaceContentStream
  mediaType?: string
  metadata?: Record<string, unknown>
}

export interface WorkspaceEntry {
  path: string
  type: "file" | "directory"
  size?: number
  mtime?: number
  mediaType?: string
  metadata?: Record<string, unknown>
  digest?: string
}

export interface WorkspaceStat extends WorkspaceEntry {
  type: "file" | "directory"
}

export interface WorkspaceSnapshot {
  id: string
  name?: string
  createdAt: string
  entries: Record<string, {
    type: "file" | "directory"
    digest?: string
    metadata?: Record<string, unknown>
    size?: number
  }>
}

export interface WorkspaceDiffEntry {
  path: string
  type: "added" | "modified" | "removed"
  before?: WorkspaceSnapshot["entries"][string]
  after?: WorkspaceSnapshot["entries"][string]
}

export interface WorkspaceDiff {
  from?: string
  to: string
  entries: WorkspaceDiffEntry[]
}

export interface WorkspaceAutoCommitPlan {
  message: string
  paths: string[]
}

export interface WorkspaceRebaseOptions {
  takeRemote?: string[]
}

export interface WorkspaceStore {
  readFile(path: string): Promise<WorkspaceFile | undefined>
  writeFile(path: string, file: WorkspaceFile): Promise<void>
  writeFileConditional?(path: string, file: WorkspaceFile, ifDigest: string | null): Promise<void>
  writeFileStream?(path: string, file: WorkspaceStreamFile): Promise<WorkspaceStat>
  list(prefix?: string, options?: ListOptions): Promise<WorkspaceEntry[]>
  glob(pattern: string | string[], options?: GlobOptions): Promise<WorkspaceEntry[]>
  stat(path: string): Promise<WorkspaceStat | undefined>
  mkdir(path: string, options?: MkdirOptions): Promise<void>
  rm(path: string, options?: RmOptions): Promise<void>
  snapshot(options?: SnapshotOptions): Promise<WorkspaceSnapshot>
  rebase?(options?: WorkspaceRebaseOptions): Promise<void>
  diff(options?: DiffOptions): Promise<WorkspaceDiff>
  getMeta?(key: string): Promise<unknown>
  setMeta?(key: string, value: unknown): Promise<void>
}

export interface SourceContextWorkspaceFiles {
  readFile<TOptions extends ReadFileOptions | undefined = undefined>(path: string, options?: TOptions): Promise<ReadFileResult<TOptions>>
  stat(path: string): Promise<WorkspaceStat | undefined>
  exists(path: string): Promise<boolean>
}

export interface SourceContext {
  abortSignal?: AbortSignal
  mountPath?: string
  rootDir: string
  selectedWorkspaceScope?: WorkspaceSelectedScope
  source?: string
  sourceRootDir?: string
  workspace: string
  workspaceFiles?: SourceContextWorkspaceFiles
}

export type MaybePromise<T> = T | Promise<T>

export interface WorkspaceSourceResolutionContextValueReader<TContextMap extends object = WorkspaceSourceResolutionContextMap> {
  entries(): IterableIterator<[string, unknown]>
  get<K extends Extract<keyof TContextMap, string>>(id: K): TContextMap[K] | undefined
  get<T = unknown>(id: string): T | undefined
  has(id: string): boolean
  toJSON?(): Record<string, unknown>
}

export interface WorkspaceSelectedScope<TScopeName extends string = string> {
  all: boolean
  name: TScopeName
  paths?: readonly string[]
  role?: string
  sources?: readonly string[]
}

export interface WorkspaceSourceResolutionInvocation<TContextMap extends object = WorkspaceSourceResolutionContextMap> {
  context: WorkspaceSourceResolutionContextValueReader<TContextMap>
  run?: {
    channelId?: string
    messageId?: string
    origin?: string
    runId?: string
    threadId?: string
  }
}

export type WorkspaceSourceResolutionContext<
  TContextMap extends object = WorkspaceSourceResolutionContextMap,
  TScopeName extends string = WorkspaceScopeName,
> = Partial<TContextMap> & {
  invocation: WorkspaceSourceResolutionInvocation<TContextMap>
  selectedWorkspaceScope?: WorkspaceSelectedScope<TScopeName>
  source: {
    key: string
    mountPath: string
  }
  workspace: Pick<WorkspaceDefinition, "name" | "rootDir" | "sourceRootDir">
}

export type WorkspaceSourceResolutionResult = WorkspaceSource | false | null | undefined
export type WorkspaceSourceResolver<
  TContextMap extends object = WorkspaceSourceResolutionContextMap,
  TScopeName extends string = WorkspaceScopeName,
> = (context: WorkspaceSourceResolutionContext<TContextMap, TScopeName>) => MaybePromise<WorkspaceSourceResolutionResult>

export type WorkspaceMaterializeMode = "build" | "lazy" | "none"

export type WorkspaceValidateMode = false | "request"

export interface WorkspaceCacheOptions {
  maxAge?: number
}

export interface WorkspaceSourceMountOptions {
  path?: string
  materialize?: WorkspaceMaterializeMode
  cache?: false | WorkspaceCacheOptions
  validate?: WorkspaceValidateMode
}

export type WorkspaceSourceMount = string | WorkspaceSourceMountOptions

export interface WorkspaceSourceItem {
  key: string
  path?: string
  content?: WorkspaceContent
  contentStream?: WorkspaceContentStream
  data?: unknown
  mediaType?: string
  metadata?: Record<string, unknown>
}

export type WorkspaceInstructionBindingValue = string | number | boolean | null

export type WorkspaceInstructionBinding =
  | WorkspaceInstructionBindingValue
  | { path: string }

export type WorkspaceSourceRequestMethod = "GET" | "HEAD" | "POST"

export interface WorkspaceSourceRequestDescriptor {
  cache?: false | WorkspaceCacheOptions
  credentials?: {
    cookies?: string[] | "dynamic"
    headers?: string[] | "dynamic"
  }
  description?: string
  method: WorkspaceSourceRequestMethod
  request?: {
    body?: unknown
    bodySchema?: Record<string, unknown>
    query?: Record<string, unknown>
    querySchema?: Record<string, unknown>
  }
  responseType?: "json" | "text"
  sourceKey?: string
  url: string
  workspacePath?: string
}

export interface WorkspaceSourceRequestExecutionInput {
  body?: unknown
  method: WorkspaceSourceRequestMethod
  url: string
}

export interface WorkspaceSourceRequestExecutionResult {
  content: WorkspaceContent
  mediaType?: string
  metadata?: Record<string, unknown>
  status?: number
}

export type WorkspaceSourceRequestExecutor = (
  input: WorkspaceSourceRequestExecutionInput,
  context: SourceContext,
) => MaybePromise<WorkspaceSourceRequestExecutionResult>

export interface WorkspaceSource {
  mount?: WorkspaceSourceMount
  materialize?: WorkspaceMaterializeMode
  cache?: false | WorkspaceCacheOptions
  validate?: WorkspaceValidateMode
  sync?: WorkspaceSourceSyncConfig
  probeKeys?: string[]
  fingerprint?: unknown
  resolve?: WorkspaceSourceResolver
  prepare?(ctx: SourceContext): Promise<void>
  getKeys(ctx: SourceContext): Promise<string[]>
  getItem(key: string, ctx: SourceContext): Promise<WorkspaceSourceItem>
  getItems?(ctx: SourceContext): Promise<WorkspaceSourceItem[]>
  getMeta?(key: string, ctx: SourceContext): Promise<Record<string, unknown> | undefined>
  search?(query: WorkspaceSearchQuery, ctx: SourceContext): Promise<WorkspaceSearchHit[]>
  watch?: unknown[]
}

export interface WorkspaceSourceSyncPolicy {
  concurrency?: "skip" | "queue"
  stale?: "keep" | "remove"
}

export type WorkspaceSourceSyncConfig = boolean | WorkspaceSourceSyncPolicy

export type WorkspaceSourceDefinition = WorkspaceSource | SourcePackageSource

type WorkspaceSourceBindingOptions = Pick<
  WorkspaceSource,
  "cache" | "materialize" | "mount" | "probeKeys" | "sync" | "validate"
>

export interface WorkspaceSourceBindingInput extends WorkspaceSourceBindingOptions {
  source: WorkspaceSourceInput
}

export type WorkspaceCustomSourceInput = WorkspaceSourceDefinition & WorkspaceSourceBindingOptions

export type WorkspaceFileSourceInput<TKey extends string = string> =
  | TKey
  | (SourcePackageFileSourceOptions<TKey> & WorkspaceSourceBindingOptions)

export interface WorkspaceFetchSourceRequestOptions {
  body?: unknown
  headers?: Record<string, string>
  method?: "GET" | "HEAD" | "POST"
  query?: Record<string, unknown>
  timeout?: number
}

export interface WorkspaceFetchSourceInput<TResponse = unknown, TOutput = TResponse> extends WorkspaceSourceBindingOptions {
  method?: "GET" | "HEAD" | "POST"
  path?: string
  request?: WorkspaceFetchSourceRequestOptions | (() => WorkspaceFetchSourceRequestOptions | Promise<WorkspaceFetchSourceRequestOptions>)
  responseType?: "json" | "text"
  schema?: unknown
  transform?: (data: TResponse) => TOutput | Promise<TOutput>
  url: string | URL
}

export type WorkspaceGlobSourceInput = SourcePackageGlobSourceOptions & WorkspaceSourceBindingOptions

export type WorkspaceGitHubSourceInput = SourcePackageGitHubSourceOptions & WorkspaceSourceBindingOptions

export type WorkspaceMcpResourcesSourceInput<TKey extends string = string> =
  Omit<SourcePackageMcpResourcesSourceOptions<TKey>, "cache"> & WorkspaceSourceBindingOptions

export type WorkspaceSourceInput =
  | WorkspaceSourceBindingInput
  | WorkspaceCustomSourceInput
  | WorkspaceFileSourceInput
  | WorkspaceFetchSourceInput
  | WorkspaceGlobSourceInput
  | WorkspaceGitHubSourceInput
  | WorkspaceMcpResourcesSourceInput

export interface WorkspaceLoaderSource extends WorkspaceSource {
  key: string
}

export interface LoaderContext {
  workspace: string
  rootDir: string
  sourceRootDir?: string
  sources: WorkspaceLoaderSource[]
  store: WorkspaceStore
  parseData(input: { id: string, data: unknown, filePath?: string }): Promise<unknown>
  generateDigest(input: unknown): string
  logger: Logger
  watcher?: unknown
}

export interface WorkspaceLoader {
  name: string
  schema?: unknown
  load(ctx: LoaderContext): Promise<void>
}

export interface PublishContext {
  durable: boolean
  workspace: WorkspaceDefinition
  store: WorkspaceStore
  rootDir: string
  snapshot?: WorkspaceSnapshot
}

export interface WorkspacePublisher {
  name: string
  clientSafe?: boolean
  publish(ctx: PublishContext): Promise<void>
}

export interface Logger {
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

export interface LocalWorkspaceStoreOptions {
  provider?: "local"
  root?: string
}

export interface MemoryWorkspaceStoreOptions {
  provider: "memory"
}

export interface CloudflareArtifactsWorkspaceStoreOptions {
  provider: "cloudflare-artifacts"
  binding?: string
  namespace?: string
  repo?: string
  repoPrefix?: string
  branch?: string
}

export interface VercelBlobWorkspaceStoreOptions {
  provider: "vercel-blob"
  token?: string
  prefix?: string
  access?: "private" | "public"
}

export type GitHubWorkspaceOption = string | (() => string | undefined)

export interface GitHubWorkspaceStoreOptions {
  provider: "github"
  branch?: GitHubWorkspaceOption
  repo?: GitHubWorkspaceOption
  repository?: GitHubWorkspaceOption
  root?: GitHubWorkspaceOption
  token?: GitHubWorkspaceOption
}

export type WorkspaceStoreOptions =
  | LocalWorkspaceStoreOptions
  | MemoryWorkspaceStoreOptions
  | CloudflareArtifactsWorkspaceStoreOptions
  | VercelBlobWorkspaceStoreOptions
  | GitHubWorkspaceStoreOptions
  | WorkspaceStore

export interface WorkspaceDefinition {
  name: string
  commit?: boolean | string
  rootDir?: string
  sourceRootDir?: string
  store?: WorkspaceStoreOptions
  bindings?: Record<string, WorkspaceInstructionBinding>
  sources?: Record<string, WorkspaceSourceInput>
  loaders?: WorkspaceLoader[]
  publish?: WorkspacePublisher[]
  plugins?: WorkspacePlugin[]
  rules?: WorkspaceRules
  hooks?: WorkspaceHooks
}

export type WorkspaceDefinitionInput = Omit<WorkspaceDefinition, "name"> & {
  name?: never
}

export interface WorkspaceModuleOptions {
  root?: string
  projectRoot?: string
  assets?: boolean | string[]
  store?: WorkspaceStoreOptions
}

export interface ResolvedWorkspaceModuleOptions {
  root: string
  assets?: boolean | string[]
  store: Exclude<WorkspaceStoreOptions, WorkspaceStore>
}

export interface WorkspaceCapabilities {
  conditionalWrites: boolean
}

export interface Workspace {
  name: string
  capabilities?(): Promise<WorkspaceCapabilities>
  sync(options: WorkspaceSyncOptions): Promise<WorkspaceSourceSyncResult>
  materializeSources?(options?: WorkspaceMaterializeSourcesOptions): Promise<WorkspaceMaterializeSourcesResult>
  getMeta?(key: string): Promise<unknown>
  setMeta?(key: string, value: unknown): Promise<void>
  readFile<TOptions extends ReadFileOptions | undefined = undefined>(path: string, options?: TOptions): Promise<ReadFileResult<TOptions>>
  writeFile(path: string, content: WorkspaceContent, options?: WriteFileOptions): Promise<string>
  list(path?: string, options?: ListOptions): Promise<WorkspaceEntry[]>
  glob(pattern: string | string[], options?: GlobOptions): Promise<WorkspaceEntry[]>
  search(query: WorkspaceSearchQuery): Promise<WorkspaceSearchHit[]>
  stat(path: string): Promise<WorkspaceStat>
  exists(path: string): Promise<boolean>
  mkdir(path: string, options?: MkdirOptions): Promise<void>
  rm(path: string, options?: RmOptions): Promise<void>
  publish(options?: WorkspacePublishOptions): Promise<void>
  snapshot(options?: SnapshotOptions): Promise<WorkspaceSnapshot>
  rebase(options?: WorkspaceRebaseOptions): Promise<void>
  diff(options?: DiffOptions): Promise<WorkspaceDiff>
  startSession(options?: WorkspaceSessionOptions): Promise<WorkspaceSession>
}

export interface WorkspaceSourceSyncCounts {
  added: number
  removed: number
  unchanged: number
  updated: number
}

export interface WorkspaceSourceSyncPathResult {
  path: string
  sourcePath: string
  status: "added" | "removed" | "unchanged" | "updated"
}

export interface WorkspaceSourceSyncStatus {
  counts: WorkspaceSourceSyncCounts
  error?: string
  mountPath: string
  paths?: WorkspaceSourceSyncPathResult[]
  source: string
  status: "error" | "ready" | "skipped"
}

export interface WorkspaceSourceSyncResult {
  durationMs: number
  published: boolean
  snapshot?: WorkspaceSnapshot
  sources: WorkspaceSourceSyncStatus[]
  status: "error" | "partial" | "ready" | "skipped"
}

export interface WorkspaceSourceMaterializationStatus {
  source: string
  mountPath: string
  status: "lazy" | "updating" | "ready" | "error"
  commit?: string
  materializedAt?: string
  files?: number
  bytes?: number
  error?: string
}

export interface WorkspaceMaterializeSourcesProgressEvent {
  bytes?: number
  directories?: number
  durationMs?: number
  error?: string
  files?: number
  mountPath: string
  path: string
  source: string
  status: "started" | "updating" | "completed" | "failed"
}

export interface WorkspaceMaterializeSourcesOptions {
  abortSignal?: AbortSignal
  onProgress?: (event: WorkspaceMaterializeSourcesProgressEvent) => void | Promise<void>
  sources?: string[]
  path?: string
}

export interface WorkspacePrepareSessionProgressEvent {
  data?: Record<string, unknown>
  durationMs?: number
  error?: string
  id: string
  label: string
  status: "started" | "updating" | "completed" | "failed"
}

export interface WorkspaceMaterializeSourcesResult {
  bytes: number
  directories: number
  durationMs: number
  files: number
  path: string
  sources: WorkspaceSourceMaterializationStatus[]
}
