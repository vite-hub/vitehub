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
  if (
    !source ||
    typeof source !== "object" ||
    !("get" in source) ||
    !(source.get instanceof Function) ||
    !("cache" in source) ||
    !source.cache
  ) {
    const core: unknown = defineCoreSource
    return (core as (input: unknown) => unknown)(source)
  }
  const reader = source as CachedSourceReader<string, unknown>
  return {
    ...reader,
    get: defineCachedFunction((...args) => reader.get.apply(reader, args), {
      swr: false,
      ...reader.cache,
    }),
  }
}
