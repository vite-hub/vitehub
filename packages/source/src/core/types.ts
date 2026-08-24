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
  TMetadata extends object = Record<string, unknown>,
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
  TMetadata extends object = Record<string, unknown>,
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

type SourceKeyOf<TSource> = TSource extends Source<infer TKey, any, any> ? TKey : string
type SourceDataOf<TSource> = TSource extends Source<any, infer TData, any> ? TData : unknown
type SourceMetadataOf<TSource> = TSource extends Source<any, any, infer TMetadata> ? TMetadata : Record<string, unknown>
type RegisteredSource<TName extends SourceName> =
  TName extends keyof ViteHubSourceMap ? ViteHubSourceMap[TName] : Source

export type SourceName = [keyof ViteHubSourceMap] extends [never] ? string : Extract<keyof ViteHubSourceMap, string>

export type SourceKey<TName extends SourceName = SourceName> =
  Extract<SourceKeyOf<RegisteredSource<TName>>, string>

export type SourceData<TName extends SourceName = SourceName> =
  SourceDataOf<RegisteredSource<TName>>

export type SourceMetadata<TName extends SourceName = SourceName> =
  SourceMetadataOf<RegisteredSource<TName>>

export interface SourceReader<TName extends SourceName = SourceName> {
  revision(): Promise<SourceRevision | undefined>
  keys(): Promise<SourceKey<TName>[]>
  get(key: SourceKey<TName>): Promise<SourceItem<SourceKey<TName>, SourceData<TName>, SourceMetadata<TName>>>
  items(): Promise<Array<SourceItem<SourceKey<TName>, SourceData<TName>, SourceMetadata<TName>>>>
  read<TOptions extends ReadSourceOptions | undefined = undefined>(
    key: SourceKey<TName>,
    options?: TOptions
  ): Promise<ReadSourceResult<TOptions>>
  meta(key: SourceKey<TName>): Promise<SourceMetadata<TName> | undefined>
  exists(key: SourceKey<TName>): Promise<boolean>
  list(prefix?: SourceKey<TName> | (string & {}) | ""): Promise<SourceListEntry<SourceKey<TName>>[]>
}
