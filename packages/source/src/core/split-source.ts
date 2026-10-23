import { sourceError } from "./errors.ts"

import type { Source, SourceContext, SourceEntry, SourceItem, SourceKey } from "./types.ts"

/** One part of a parent item. Its key is unique inside the parent and has no `#`. */
export type SplitSourcePart = SourceItem<string, unknown, object>

export interface SplitSourceOptions<TSource extends Source, TPart extends SplitSourcePart> {
  /** The Source whose items are split. */
  source: TSource
  /** Defaults to the parent Source name. */
  name?: string
  /** Returns the parts of one parent item, in order. Return an empty array to skip the item. */
  split(item: SourceEntry<TSource>): readonly TPart[] | Promise<readonly TPart[]>
}

/** A part's key: the parent key, `#`, and the part key. */
export type SplitSourceKey<TSource extends Source> = `${SourceKey<TSource>}#${string}`

/** A part as the split Source returns it: its full key, and the parent's path when the part has none. */
export type SplitSourceItem<TSource extends Source, TPart extends SplitSourcePart> = Omit<TPart, "key"> & {
  key: SplitSourceKey<TSource>
}

/** A Source with one item for each part of another Source's items. */
type SplitSourceMeta<TSource extends Source> = NonNullable<TSource["getMeta"]> extends (...args: any[]) => infer TResult
  ? TResult
  : Promise<undefined>

export type SplitSource<TSource extends Source, TPart extends SplitSourcePart> = Omit<Source<SplitSourceKey<TSource>>, "getItem" | "getItems" | "getMeta"> & {
  getItem(key: SplitSourceKey<TSource>, ctx: SourceContext): Promise<SplitSourceItem<TSource, TPart>>
  getItems(ctx: SourceContext): Promise<SplitSourceItem<TSource, TPart>[]>
  getMeta(key: SplitSourceKey<TSource>, ctx: SourceContext): SplitSourceMeta<TSource>
}

/** Split each item of a Source into parts, such as the sections of a Markdown file. Each part is an item. */
export function splitSource<const TSource extends Source, TPart extends SplitSourcePart>(
  options: SplitSourceOptions<TSource, TPart>,
): SplitSource<TSource, TPart> {
  const parent: Source = options.source
  type Item = SplitSourceItem<TSource, TPart>

  async function partsOf(item: SourceItem): Promise<Item[]> {
    // SAFETY: The parent Source returned this item, so it is an entry of TSource.
    const parts: unknown = await options.split(item as SourceEntry<TSource>)
    if (!Array.isArray(parts)) {
      throw sourceError(`[vitehub] splitSource() split() must return an array for ${JSON.stringify(item.key)}.`)
    }
    const seen = new Set<string>()
    return parts.map((part: TPart) => {
      if (!part.key || part.key.includes("#")) {
        throw sourceError(`[vitehub] splitSource() part key ${JSON.stringify(part.key)} in ${JSON.stringify(item.key)} must be a non-empty string without "#".`)
      }
      if (seen.has(part.key)) {
        throw sourceError(`[vitehub] splitSource() returned the part key ${JSON.stringify(part.key)} twice for ${JSON.stringify(item.key)}.`)
      }
      seen.add(part.key)
      // SAFETY: The parent Source returned item.key, so it is a SourceKey<TSource>.
      const key = `${item.key}#${part.key}` as SplitSourceKey<TSource>
      const path = part.path ?? item.path
      const metadata = item.metadata === undefined
        ? part.metadata
        : part.metadata === undefined
          ? item.metadata
          : { ...item.metadata, ...part.metadata }
      const result: Item = {
        ...part,
        key,
        ...(path === undefined ? {} : { path }),
        ...(metadata === undefined ? {} : { metadata }),
      }
      return result
    })
  }

  async function parentItems(ctx: SourceContext): Promise<SourceItem[]> {
    if (parent.getItems) return await parent.getItems(ctx)
    const keys = await parent.getKeys(ctx)
    return await Promise.all(keys.map(key => parent.getItem(key, ctx)))
  }

  async function getItems(ctx: SourceContext): Promise<Item[]> {
    return (await Promise.all((await parentItems(ctx)).map(partsOf))).flat()
  }

  return {
    name: options.name ?? parent.name,
    ...(parent.cache === undefined ? {} : { cache: parent.cache }),
    ...(parent.fingerprint === undefined ? {} : { fingerprint: parent.fingerprint }),
    ...(parent.resolveRevision ? { resolveRevision: (ctx: SourceContext) => parent.resolveRevision!(ctx) } : {}),
    ...(parent.prepare ? { prepare: (ctx: SourceContext) => parent.prepare!(ctx) } : {}),
    async getKeys(ctx) {
      return (await getItems(ctx)).map(part => part.key)
    },
    async getItem(key, ctx) {
      const id = String(key)
      const at = id.lastIndexOf("#")
      if (at < 1) throw sourceError(`[vitehub] splitSource() key ${JSON.stringify(id)} has no "#" between the item and the part.`)
      const parts = await partsOf(await parent.getItem(id.slice(0, at), ctx))
      const part = parts.find(candidate => candidate.key === key)
      if (!part) throw sourceError(`[vitehub] splitSource() could not find ${JSON.stringify(key)}.`)
      return part
    },
    getMeta(key, ctx) {
      const id = String(key)
      const at = id.lastIndexOf("#")
      if (at < 1) return Promise.resolve(undefined) as SplitSourceMeta<TSource>
      return (parent.getMeta?.(id.slice(0, at), ctx) ?? Promise.resolve(undefined)) as SplitSourceMeta<TSource>
    },
    getItems,
  }
}
