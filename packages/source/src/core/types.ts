export type SourceContent = string | Uint8Array

export interface ReadSourceOptions {
  encoding?: "utf8" | "binary"
}

export type ReadSourceResult<TOptions extends ReadSourceOptions | undefined = undefined> =
  TOptions extends { encoding: "binary" } ? Uint8Array : string

export interface SourceContext {
  abortSignal?: AbortSignal
  revision?: SourceRevision
  rootDir: string
  sourceRootDir?: string
  source?: string
  workspace?: string
}

export interface SourceCacheOptions {
  maxAge?: number
}

export interface SourceRevision {
  id: string
  immutable: boolean
  ref?: string
}

export interface SourceItem<
  TKey extends string = string,
  TData = unknown,
  TMetadata extends object = object,
> {
  key: TKey
  path?: string
  content?: SourceContent
  data?: TData
  mediaType?: string
  metadata?: TMetadata
}

export interface Source<
  TKey extends string = string,
  TData = unknown,
  TMetadata extends object = object,
> {
  name: string
  cache?: false | SourceCacheOptions
  fingerprint?: unknown
  resolveRevision?(ctx: SourceContext): Promise<SourceRevision | undefined>
  prepare?(ctx: SourceContext): Promise<void>
  getKeys(ctx: SourceContext): Promise<TKey[]>
  getItem(key: TKey, ctx: SourceContext): Promise<SourceItem<TKey, TData, TMetadata>>
  getItems?(ctx: SourceContext): Promise<SourceItem<TKey, TData, TMetadata>[]>
  getMeta?(key: TKey, ctx: SourceContext): Promise<TMetadata | undefined>
}

export interface SourceListEntry<TKey extends string = string> {
  key: TKey
  type: "file" | "directory"
}

declare global {
  interface ViteHubSourceMap {}
}

export interface SourceMap extends ViteHubSourceMap {}

/** Resolve an optional registered name to its loader definition. */
export type RegisteredSource<TName extends SourceName> =
  TName extends keyof ViteHubSourceMap
    ? ViteHubSourceMap[TName] extends Source ? ViteHubSourceMap[TName] : never
    : Source

export type SourceName = [keyof ViteHubSourceMap] extends [never] ? string : Extract<keyof ViteHubSourceMap, string>

type SourceKeyFunction<TSource extends Source> =
  TSource extends unknown ? (key: Parameters<TSource["getItem"]>[0]) => void : never

/** Keys accepted by every possible definition variant. */
export type SourceKey<TSource extends Source = Source> =
  SourceKeyFunction<TSource> extends (key: infer TKey) => void ? Extract<TKey, string> : never
export type SourceEntry<TSource extends Source = Source> = Awaited<ReturnType<TSource["getItem"]>>
type ItemData<TItem> = TItem extends { data?: infer TData } ? TData : never
type ItemMetadata<TItem> = TItem extends { metadata?: infer TMetadata } ? TMetadata : never

export type SourceData<TSource extends Source = Source> = ItemData<SourceEntry<TSource>>
export type SourceMetadata<TSource extends Source = Source> = ItemMetadata<SourceEntry<TSource>>

type SourceMeta<TSource extends Source> = TSource extends unknown
  ? "getMeta" extends keyof TSource
    ? Awaited<ReturnType<NonNullable<TSource["getMeta"]>>> | (undefined extends TSource["getMeta"] ? undefined : never)
    : undefined
  : never

type SourceEntries<TSource extends Source> = TSource extends unknown
  ? "getItems" extends keyof TSource
    ? Awaited<ReturnType<NonNullable<TSource["getItems"]>>> | (undefined extends TSource["getItems"] ? SourceEntry<TSource>[] : never)
    : SourceEntry<TSource>[]
  : never

export interface SourceFile<TKey extends string = string, TMetadata extends object = Record<string, unknown>>
  extends SourceItem<TKey, unknown, TMetadata> {
  content: SourceContent
}

/** File loaders guarantee readable content for every item. */
export interface FileSource<TKey extends string = string, TMetadata extends object = Record<string, unknown>>
  extends Source<TKey, unknown, TMetadata> {
  getItem(key: TKey, ctx: SourceContext): Promise<SourceFile<TKey, TMetadata>>
  getItems?(ctx: SourceContext): Promise<SourceFile<TKey, TMetadata>[]>
}

interface SourceFileMethods<TKey extends string> {
  read<TOptions extends ReadSourceOptions | undefined = undefined>(
    key: TKey,
    options?: TOptions,
  ): Promise<ReadSourceResult<TOptions>>
  list(prefix?: string): Promise<SourceListEntry[]>
}

/** A reader owns one revision and preparation attempt. Create another reader to refresh. */
export type SourceReader<TSource extends Source = Source> = {
  revision(): Promise<SourceRevision | undefined>
  keys(): Promise<Awaited<ReturnType<TSource["getKeys"]>>>
  get(key: SourceKey<TSource>): Promise<SourceEntry<TSource>>
  items(): Promise<SourceEntries<TSource>>
  meta(key: SourceKey<TSource>): Promise<SourceMeta<TSource>>
  exists(key: SourceKey<TSource>): Promise<boolean>
} & (SourceEntry<TSource> extends { content: SourceContent } ? SourceFileMethods<SourceKey<TSource>> : object)
