export type WorkspaceContent = string | Uint8Array

export interface ReadFileOptions {
  encoding?: "utf8" | "binary"
}

export type ReadFileResult<TOptions extends ReadFileOptions | undefined = undefined> =
  TOptions extends { encoding: "binary" } ? Uint8Array : string

export interface WriteFileOptions {
  mediaType?: string
}

export interface ListOptions {
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

export interface DiffOptions {
  from?: WorkspaceSnapshot
}

export interface WorkspaceSyncOptions {
  force?: boolean
}

export interface WorkspaceSessionOptions {
  runtime?: never
  sandbox?: never
}

export type WorkspaceMountMode = "read-only" | "read-write" | "copy-on-write"

export interface WorkspaceMountOptions {
  mode: WorkspaceMountMode
  target?: string
}

export interface WorkspaceMount {
  workspace: Workspace
  mode: WorkspaceMountMode
  target: string
  diff(): Promise<WorkspaceDiff>
  commit(options?: { message?: string }): Promise<void>
  export(): Promise<WorkspaceSnapshot>
}

export interface ExecOptions {
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
  readFile<TOptions extends ReadFileOptions | undefined = undefined>(path: string, options?: TOptions): Promise<ReadFileResult<TOptions>>
  writeFile(path: string, content: WorkspaceContent, options?: WriteFileOptions): Promise<void>
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
}

export interface WorkspaceNameMap extends ViteHubWorkspaceNameMap {}

export type WorkspaceName = [keyof ViteHubWorkspaceNameMap] extends [never] ? string : Extract<keyof ViteHubWorkspaceNameMap, string>

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

export interface WorkspaceEntry {
  path: string
  type: "file" | "directory"
  size?: number
  mtime?: number
  mediaType?: string
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

export interface WorkspaceStore {
  readFile(path: string): Promise<WorkspaceFile | undefined>
  writeFile(path: string, file: WorkspaceFile): Promise<void>
  list(prefix?: string, options?: ListOptions): Promise<WorkspaceEntry[]>
  glob(pattern: string | string[], options?: GlobOptions): Promise<WorkspaceEntry[]>
  stat(path: string): Promise<WorkspaceStat | undefined>
  mkdir(path: string, options?: MkdirOptions): Promise<void>
  rm(path: string, options?: RmOptions): Promise<void>
  snapshot(options?: SnapshotOptions): Promise<WorkspaceSnapshot>
  diff(options?: DiffOptions): Promise<WorkspaceDiff>
  getMeta?(key: string): Promise<unknown>
  setMeta?(key: string, value: unknown): Promise<void>
}

export interface SourceContext {
  mountPath?: string
  rootDir: string
  source?: string
  sourceRootDir?: string
  workspace: string
}

export type MaybePromise<T> = T | Promise<T>

export interface WorkspaceSourceResolutionContextValueReader {
  entries(): IterableIterator<[string, unknown]>
  get<T = unknown>(id: string): T | undefined
  has(id: string): boolean
  toJSON?(): Record<string, unknown>
}

export interface WorkspaceSelectedScope {
  all: boolean
  paths?: readonly string[]
  role?: string
  scope: string
}

export interface WorkspaceSourceResolutionInvocation {
  context: WorkspaceSourceResolutionContextValueReader
  run?: {
    channelId?: string
    messageId?: string
    origin?: string
    runId?: string
    threadId?: string
  }
}

export interface WorkspaceSourceResolutionContext {
  invocation: WorkspaceSourceResolutionInvocation
  selectedWorkspaceScope?: WorkspaceSelectedScope
  source: {
    key: string
    mountPath: string
  }
  workspace: Pick<WorkspaceDefinition, "name" | "rootDir" | "sourceRootDir">
}

export type WorkspaceSourceResolutionResult = WorkspaceSource | false | null | undefined
export type WorkspaceSourceResolver = (context: WorkspaceSourceResolutionContext) => MaybePromise<WorkspaceSourceResolutionResult>

export type WorkspaceMaterializeMode = "build" | "lazy"

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
  data?: unknown
  mediaType?: string
  metadata?: Record<string, unknown>
}

export type WorkspaceSourceInstructions = string | readonly string[]

export interface WorkspaceSource {
  mount?: WorkspaceSourceMount
  materialize?: WorkspaceMaterializeMode
  cache?: false | WorkspaceCacheOptions
  validate?: WorkspaceValidateMode
  fingerprint?: unknown
  instructions?: WorkspaceSourceInstructions
  resolve?: WorkspaceSourceResolver
  prepare?(ctx: SourceContext): Promise<void>
  getKeys(ctx: SourceContext): Promise<string[]>
  getItem(key: string, ctx: SourceContext): Promise<WorkspaceSourceItem>
  getItems?(ctx: SourceContext): Promise<WorkspaceSourceItem[]>
  getMeta?(key: string, ctx: SourceContext): Promise<Record<string, unknown> | undefined>
  search?(query: WorkspaceSearchQuery, ctx: SourceContext): Promise<WorkspaceSearchHit[]>
  watch?: unknown[]
}

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

export type WorkspaceStoreOptions =
  | LocalWorkspaceStoreOptions
  | MemoryWorkspaceStoreOptions
  | CloudflareArtifactsWorkspaceStoreOptions
  | VercelBlobWorkspaceStoreOptions
  | WorkspaceStore

export interface WorkspaceDefinition {
  name: string
  rootDir?: string
  sourceRootDir?: string
  runtime?: "sandbox"
  store?: WorkspaceStoreOptions
  sources?: Record<string, WorkspaceSource>
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
  assets?: boolean | string[]
  store?: WorkspaceStoreOptions
}

export interface ResolvedWorkspaceModuleOptions {
  root: string
  assets?: boolean | string[]
  store: Exclude<WorkspaceStoreOptions, WorkspaceStore>
}

export interface Workspace {
  name: string
  sync(options?: WorkspaceSyncOptions): Promise<void>
  materializeSources?(options?: WorkspaceMaterializeSourcesOptions): Promise<WorkspaceMaterializeSourcesResult>
  readFile<TOptions extends ReadFileOptions | undefined = undefined>(path: string, options?: TOptions): Promise<ReadFileResult<TOptions>>
  writeFile(path: string, content: WorkspaceContent, options?: WriteFileOptions): Promise<void>
  list(path?: string, options?: ListOptions): Promise<WorkspaceEntry[]>
  glob(pattern: string | string[], options?: GlobOptions): Promise<WorkspaceEntry[]>
  search(query: WorkspaceSearchQuery): Promise<WorkspaceSearchHit[]>
  stat(path: string): Promise<WorkspaceStat>
  exists(path: string): Promise<boolean>
  mkdir(path: string, options?: MkdirOptions): Promise<void>
  rm(path: string, options?: RmOptions): Promise<void>
  snapshot(options?: SnapshotOptions): Promise<WorkspaceSnapshot>
  diff(options?: DiffOptions): Promise<WorkspaceDiff>
  startSession(options?: WorkspaceSessionOptions): Promise<WorkspaceSession>
  mount(options?: WorkspaceMountOptions): WorkspaceMount
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

export interface WorkspaceMaterializeSourcesOptions {
  sources?: string[]
  path?: string
}

export interface WorkspaceMaterializeSourcesResult {
  bytes: number
  directories: number
  durationMs: number
  files: number
  path: string
  sources: WorkspaceSourceMaterializationStatus[]
}
