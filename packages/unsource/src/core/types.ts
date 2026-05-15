export type SourceContent = string | Uint8Array

export interface ReadSourceOptions {
  encoding?: "utf8" | "binary"
}

export type ReadSourceResult<TOptions extends ReadSourceOptions | undefined = undefined> =
  TOptions extends { encoding: "binary" } ? Uint8Array : string

export interface SourceContext {
  rootDir: string
  source?: string
  workspace?: string
}

export interface SourceCacheOptions {
  maxAge?: number
}

export interface SourceSearchQuery {
  pattern: string
  cwd?: string
  paths?: string[]
  regex?: boolean
  caseSensitive?: boolean
  limit?: number
}

export interface SourceSearchHit {
  path: string
  line: number
  column: number
  text: string
}

export interface SourceItem<TKey extends string = string> {
  key: TKey
  path?: string
  content?: SourceContent
  data?: unknown
  mediaType?: string
  metadata?: Record<string, unknown>
}

export interface Source<TKey extends string = string> {
  name: string
  cache?: false | SourceCacheOptions
  fingerprint?: unknown
  prepare?(ctx: SourceContext): Promise<void>
  getKeys(ctx: SourceContext): Promise<TKey[]>
  getItem(key: TKey, ctx: SourceContext): Promise<SourceItem<TKey>>
  getItems?(ctx: SourceContext): Promise<SourceItem<TKey>[]>
  getMeta?(key: TKey, ctx: SourceContext): Promise<Record<string, unknown> | undefined>
  search?(query: SourceSearchQuery, ctx: SourceContext): Promise<SourceSearchHit[]>
  watch?: unknown[]
}

export interface SourceListEntry<TKey extends string = string> {
  key: TKey
  type: "file" | "directory"
}

declare global {
  interface UnsourceSourceMap {}
}

export interface SourceMap extends UnsourceSourceMap {}

type SourceKeyOf<TSource> = TSource extends Source<infer TKey> ? TKey : string

export type SourceName = [keyof UnsourceSourceMap] extends [never] ? string : Extract<keyof UnsourceSourceMap, string>

export type SourceKey<TName extends SourceName = SourceName> =
  TName extends keyof UnsourceSourceMap
    ? Extract<SourceKeyOf<UnsourceSourceMap[TName]>, string>
    : string

export interface SourceReader<TName extends SourceName = SourceName> {
  keys(): Promise<SourceKey<TName>[]>
  get(key: SourceKey<TName>): Promise<SourceItem<SourceKey<TName>>>
  read<TOptions extends ReadSourceOptions | undefined = undefined>(
    key: SourceKey<TName>,
    options?: TOptions
  ): Promise<ReadSourceResult<TOptions>>
  meta(key: SourceKey<TName>): Promise<Record<string, unknown> | undefined>
  exists(key: SourceKey<TName>): Promise<boolean>
  list(prefix?: SourceKey<TName> | (string & {}) | ""): Promise<SourceListEntry<SourceKey<TName>>[]>
}
