import type { CacheOptions } from "nitro/types"

export * from "@vite-hub/source/server"

interface KeyedSourceReader {
  get(key: never): Promise<unknown>
}

function isRuntimeFunction(value: unknown): value is Function {
  if (value === null || Object(value) !== value) return false
  try {
    Function.prototype.toString.call(value)
    return true
  } catch {
    return false
  }
}

type ValidCachedGet<TReader extends KeyedSourceReader> =
  (<T>() => T extends TReader["get"] ? 1 : 2) extends
  (<T>() => T extends (key: Parameters<TReader["get"]>[0]) => ReturnType<TReader["get"]> ? 1 : 2)
    ? unknown
    : never

export type SourceReaderCacheOptions<TKey, TValue> =
  & Omit<CacheOptions<TValue, [key: TKey]>, "name">
  & { name: string }

// Cache keyed retrieval in the host while preserving the reader's other operations.
export function cachedSource<const TReader extends KeyedSourceReader>(
  reader: TReader & ValidCachedGet<TReader>,
  options: SourceReaderCacheOptions<Parameters<TReader["get"]>[0], Awaited<ReturnType<TReader["get"]>>>,
): TReader {
  type Key = Parameters<TReader["get"]>[0]
  type Value = Awaited<ReturnType<TReader["get"]>>
  let cachedGet: Promise<(key: Key) => Promise<Value>> | undefined

  // SAFETY: The key and value types come from this reader's get method.
  const get = reader.get as (key: Key) => Promise<Value>

  async function readCached(key: Key) {
    cachedGet ??= import("nitro/cache").then(({ defineCachedFunction }) => defineCachedFunction(
      value => get.call(reader, value),
      {
        swr: false,
        ...options,
      },
    ))
    return await (await cachedGet)(key)
  }

  // SAFETY: Object.create(reader) returns an object that inherits TReader's full public contract.
  const facade = Object.create(reader) as TReader
  return new Proxy(facade, {
    get(_target, property) {
      if (property === "get") return readCached
      const value: unknown = Reflect.get(reader, property, reader)
      return isRuntimeFunction(value) ? value.bind(reader) : value
    },
    set(_target, property, value: unknown) {
      return Reflect.set(reader, property, value, reader)
    },
    ownKeys() {
      return Reflect.ownKeys(reader)
    },
    getOwnPropertyDescriptor(_target, property) {
      const descriptor = Reflect.getOwnPropertyDescriptor(reader, property)
      return descriptor ? { ...descriptor, configurable: true } : undefined
    },
  })
}
