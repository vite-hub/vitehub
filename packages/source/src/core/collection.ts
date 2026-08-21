import { sourceError } from "./errors.ts"

interface CollectionSourceReader {
  get(key: never): Promise<unknown>
  items?(): Promise<Array<{ key: string }>>
}

type CollectionSources = Record<string, CollectionSourceReader>

type CollectionSourceKeyFunction<TReader> =
  TReader extends { get(key: infer TKey): Promise<unknown> } ? (key: TKey) => void : never

type CollectionSourceKey<TReader> =
  CollectionSourceKeyFunction<TReader> extends (key: infer TKey) => void
    ? Extract<TKey, string>
    : never

type CollectionSourceValue<TReader> =
  TReader extends { get(key: never): Promise<infer TValue> } ? TValue : never

type CollectionSourceItem<TReader> =
  TReader extends { items(): Promise<Array<infer TItem extends { key: string }>> } ? TItem : never

type Equal<TLeft, TRight> =
  (<T>() => T extends TLeft ? 1 : 2) extends (<T>() => T extends TRight ? 1 : 2)
    ? (<T>() => T extends TRight ? 1 : 2) extends (<T>() => T extends TLeft ? 1 : 2)
      ? true
      : false
    : false

type CollectionSourceGetSignatures<TReader> = TReader extends { get: {
  (key: infer TKey1): Promise<infer TValue1>
  (key: infer TKey2): Promise<infer TValue2>
  (key: infer TKey3): Promise<infer TValue3>
  (key: infer TKey4): Promise<infer TValue4>
  (key: infer TKey5): Promise<infer TValue5>
} } ? [[TKey1, TValue1], [TKey2, TValue2], [TKey3, TValue3], [TKey4, TValue4], [TKey5, TValue5]] : never

type SignaturesAreEqual<TSignatures extends unknown[], TExpected = TSignatures[number]> =
  TSignatures extends [infer TSignature, ...infer TRest]
    ? Equal<TSignature, TExpected> extends true
      ? SignaturesAreEqual<TRest, TExpected>
      : false
    : true

type ValidCollectionGet<TReader> =
  TReader extends unknown
    ? SignaturesAreEqual<CollectionSourceGetSignatures<TReader>> extends true ? TReader : never
    : never

type ValidCollectionSource<TReader> =
  [CollectionSourceItem<TReader>] extends [never]
    ? ValidCollectionGet<TReader>
    : Exclude<CollectionSourceItem<TReader>["key"], CollectionSourceKey<TReader>> extends never
      ? ValidCollectionGet<TReader>
      : never

type ValidCollectionSources<TSources extends CollectionSources> = {
  [TSource in keyof TSources]: ValidCollectionSource<TSources[TSource]>
}

type TaggedCollectionItemVariant<TSource extends string, TItem> =
  TItem extends { key: string }
    ? Omit<TItem, "identity" | "source"> & {
        identity: readonly [TSource, TItem["key"]]
        source: TSource
      }
    : never

type TaggedCollectionItem<TSource extends string, TReader> =
  TaggedCollectionItemVariant<TSource, CollectionSourceItem<TReader>>

type CollectionItem<TSources extends CollectionSources> = {
  [TSource in Extract<keyof TSources, string>]: TaggedCollectionItem<TSource, TSources[TSource]>
}[Extract<keyof TSources, string>]

type CollectionIdentity<TSources extends CollectionSources> = {
  [TSource in Extract<keyof TSources, string>]: readonly [
    source: TSource,
    key: CollectionSourceKey<TSources[TSource]>,
  ]
}[Extract<keyof TSources, string>]

type CollectionIdentityValue<TSources extends CollectionSources, TIdentity> =
  TIdentity extends readonly [infer TSource extends Extract<keyof TSources, string>, string]
    ? CollectionSourceValue<TSources[TSource]>
    : never

interface CollectionDefinition<TSources extends CollectionSources> {
  readonly sources: TSources
    & ValidCollectionSources<TSources>
    & Record<Exclude<keyof TSources, string>, never>
}

interface CollectionReader<TSources extends CollectionSources> {
  get<const TIdentity extends CollectionIdentity<TSources>>(
    identity: TIdentity,
  ): Promise<CollectionIdentityValue<TSources, TIdentity>>
  items(): Promise<Array<CollectionItem<TSources>>>
}

export function defineCollection<const TSources extends CollectionSources>(
  collection: CollectionDefinition<TSources>,
): CollectionReader<TSources> {
  const sources: TSources = collection.sources

  async function get<const TIdentity extends CollectionIdentity<TSources>>(
    identity: TIdentity,
  ): Promise<CollectionIdentityValue<TSources, TIdentity>> {
    if (!Array.isArray(identity) || identity.length !== 2
      || typeof identity[0] !== "string" || typeof identity[1] !== "string") {
      throw new TypeError("[vitehub] Collection identity must be a [source, key] string tuple.")
    }

    const [source, key] = identity
    if (!Object.hasOwn(sources, source)) {
      throw sourceError(`[vitehub] Collection source alias ${JSON.stringify(source)} is not defined.`)
    }

    return await (sources[source].get as (key: string) => Promise<CollectionIdentityValue<TSources, TIdentity>>)(key)
  }

  async function items(): Promise<Array<CollectionItem<TSources>>> {
    const entries = Object.entries(sources)
    for (const [source, reader] of entries) {
      if (typeof reader.items !== "function") {
        throw sourceError(`[vitehub] Collection source alias ${JSON.stringify(source)} is not enumerable.`)
      }
    }

    const groups = await Promise.all(entries.map(async ([source, reader]) =>
      (await reader.items!()).map(item => ({
        ...item,
        identity: [source, item.key],
        source,
      })),
    ))

    // Object.entries erases the alias/item correlation validated by CollectionDefinition.
    return groups.flat() as unknown as Array<CollectionItem<TSources>>
  }

  return { get, items }
}
