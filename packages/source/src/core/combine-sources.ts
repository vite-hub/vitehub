import { sourceError } from "./errors.ts"

interface CombinedSourceReader {
  get(key: never): Promise<unknown>
  items?(): Promise<Array<{ key: string }>>
}

type CombinedSources = Record<string, CombinedSourceReader>

type CombinedSourceKeyFunction<TReader> = TReader extends { get(key: infer TKey): Promise<unknown> }
  ? (key: TKey) => void
  : never

type CombinedSourceKey<TReader> =
  CombinedSourceKeyFunction<TReader> extends (key: infer TKey) => void
    ? Extract<TKey, string>
    : never

type CombinedSourceValue<TReader> = TReader extends { get(key: never): Promise<infer TValue> }
  ? TValue
  : never

type CombinedSourceItem<TReader> = TReader extends {
  items(): Promise<Array<infer TItem extends { key: string }>>
}
  ? TItem
  : never

type Equal<TLeft, TRight> =
  (<T>() => T extends TLeft ? 1 : 2) extends <T>() => T extends TRight ? 1 : 2
    ? (<T>() => T extends TRight ? 1 : 2) extends <T>() => T extends TLeft ? 1 : 2
      ? true
      : false
    : false

type ValidCombinedGet<TReader> = TReader extends unknown
  ? TReader extends { get: infer TGet }
    ? Equal<
        TGet,
        (key: CombinedSourceKey<TReader>) => Promise<CombinedSourceValue<TReader>>
      > extends true
      ? TReader
      : never
    : never
  : never

type ValidCombinedSource<TReader> = [CombinedSourceItem<TReader>] extends [never]
  ? ValidCombinedGet<TReader>
  : Exclude<CombinedSourceItem<TReader>["key"], CombinedSourceKey<TReader>> extends never
    ? ValidCombinedGet<TReader>
    : never

type ValidCombinedSources<TSources extends CombinedSources> = {
  [TSource in keyof TSources]: ValidCombinedSource<TSources[TSource]>
}

type TaggedCombinedItemVariant<TSource extends string, TItem> = TItem extends { key: string }
  ? Omit<TItem, "identity" | "source"> & {
      identity: readonly [TSource, TItem["key"]]
      source: TSource
    }
  : never

type TaggedCombinedItem<TSource extends string, TReader> = TaggedCombinedItemVariant<
  TSource,
  CombinedSourceItem<TReader>
>

type CombinedItem<TSources extends CombinedSources> = {
  [TSource in Extract<keyof TSources, string>]: TaggedCombinedItem<TSource, TSources[TSource]>
}[Extract<keyof TSources, string>]

type CombinedIdentity<TSources extends CombinedSources> = {
  [TSource in Extract<keyof TSources, string>]: readonly [
    source: TSource,
    key: CombinedSourceKey<TSources[TSource]>,
  ]
}[Extract<keyof TSources, string>]

type CombinedIdentityValue<
  TSources extends CombinedSources,
  TIdentity,
> = TIdentity extends readonly [infer TSource extends Extract<keyof TSources, string>, string]
  ? CombinedSourceValue<TSources[TSource]>
  : never

interface CombinedSourcesDefinition<TSources extends CombinedSources> {
  readonly sources: TSources &
    ValidCombinedSources<TSources> &
    Record<Exclude<keyof TSources, string>, never>
}

interface CombinedSourcesReader<TSources extends CombinedSources> {
  get<const TIdentity extends CombinedIdentity<TSources>>(
    identity: TIdentity,
  ): Promise<CombinedIdentityValue<TSources, TIdentity>>
  items(): Promise<Array<CombinedItem<TSources>>>
}

export function combineSources<const TSources extends CombinedSources>(
  definition: CombinedSourcesDefinition<TSources>,
): CombinedSourcesReader<TSources> {
  const sources: TSources = definition.sources

  async function get<const TIdentity extends CombinedIdentity<TSources>>(
    identity: TIdentity,
  ): Promise<CombinedIdentityValue<TSources, TIdentity>> {
    if (
      !Array.isArray(identity) ||
      identity.length !== 2 ||
      typeof identity[0] !== "string" ||
      typeof identity[1] !== "string"
    ) {
      throw new TypeError(
        "[vitehub] Combined Source identity must be a [source, key] string tuple.",
      )
    }

    const [source, key] = identity
    if (!Object.hasOwn(sources, source)) {
      throw sourceError(
        `[vitehub] Combined Source alias ${JSON.stringify(source)} is not defined.`,
      )
    }

    return await (
      sources[source].get as (key: string) => Promise<CombinedIdentityValue<TSources, TIdentity>>
    )(key)
  }

  async function items(): Promise<Array<CombinedItem<TSources>>> {
    const entries = Object.entries(sources)
    for (const [source, reader] of entries) {
      if (typeof reader.items !== "function") {
        throw sourceError(
          `[vitehub] Combined Source alias ${JSON.stringify(source)} is not enumerable.`,
        )
      }
    }

    const groups = await Promise.all(
      entries.map(async ([source, reader]) =>
        (await reader.items!()).map((item) => ({
          ...item,
          identity: [source, item.key],
          source,
        })),
      ),
    )

    return groups.flat() as unknown as Array<CombinedItem<TSources>>
  }

  return { get, items }
}
