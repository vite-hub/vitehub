import { defineSource as defineCoreSource } from "@vite-hub/source"
import { defineCachedFunction } from "nitro/cache"

import type { Source, SourceContext } from "@vite-hub/source"
import type { CacheOptions } from "nitro/types"

export * from "@vite-hub/source/server"

interface KeyedSourceReader {
  get(key: never): Promise<unknown>
}

type RuntimeSourceDefinition<TReader extends KeyedSourceReader> =
  (context: SourceContext) => TReader

export type SourceReaderCacheOptions<TKey extends string, TValue> =
  & Omit<CacheOptions<TValue, [key: TKey]>, "name">
  & { name: string }

interface CachedSourceReader<TKey extends string, TValue> {
  cache: false | SourceReaderCacheOptions<TKey, TValue>
  get(key: TKey): Promise<TValue>
}

function isCachedSourceReader(source: unknown): source is CachedSourceReader<string, unknown> {
  return Object(source) === source
    && !(source instanceof Function)
    && Reflect.get(Object(source), "get") instanceof Function
    && Boolean(Reflect.get(Object(source), "cache"))
}

export function defineSource<
  const TKey extends string,
  TValue,
  const TReader extends CachedSourceReader<TKey, TValue>,
>(source: TReader): TReader
export function defineSource<const TSource extends Source>(source: TSource): TSource
export function defineSource<const TReader extends KeyedSourceReader>(source: TReader & { cache?: never }): TReader
export function defineSource<const TReader extends KeyedSourceReader>(
  definition: RuntimeSourceDefinition<TReader>,
): RuntimeSourceDefinition<TReader>
export function defineSource(source: unknown): unknown {
  if (!isCachedSourceReader(source)) {
    const core: unknown = defineCoreSource
    // SAFETY: The public overloads above are the ViteHub subset of the core defineSource input contract.
    return (core as (input: unknown) => unknown)(source)
  }
  return {
    ...source,
    get: defineCachedFunction((...args) => source.get.apply(source, args), {
      swr: false,
      ...source.cache,
    }),
  }
}
