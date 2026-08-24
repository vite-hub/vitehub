import { normalizeSafeSourcePath } from "./core/path.ts"
import { useSource } from "./core/registry.ts"

import type { JsonSchema, Source as ComarkContentSource } from "comark-content"
import type { SourceItem, SourceName, SourceReader } from "./core/types.ts"

export interface ContentSourceOptions {
  prefix?: string
  schema?: JsonSchema
}

type ContentSourceItem = SourceItem<string, unknown, object>
export type ContentSourceInput = SourceName | SourceReader | (() => SourceReader)

function contentPath(item: ContentSourceItem): string {
  return normalizeSafeSourcePath(item.path || item.key)
}

function textContent(item: ContentSourceItem): string {
  if (typeof item.content === "string") return item.content
  if (item.content instanceof Uint8Array) return new TextDecoder().decode(item.content)
  if (item.data !== undefined) {
    const serialized = JSON.stringify(item.data)
    if (serialized !== undefined) return serialized
  }
  throw new TypeError(`[vitehub] contentSource() cannot read ${JSON.stringify(item.key)} as content.`)
}

/** Adapt a registered ViteHub Source or Source Reader to the interface consumed by Comark Content. */
export function contentSource(input: ContentSourceInput, options: ContentSourceOptions = {}): ComarkContentSource {
  let currentItems = new Map<string, ContentSourceItem>()

  async function loadItems() {
    const nextItems = new Map<string, ContentSourceItem>()
    const currentReader = typeof input === "string"
      ? useSource(input)
      : typeof input === "function"
        ? input()
        : input
    for (const item of await currentReader.items()) {
      const path = contentPath(item)
      if (nextItems.has(path)) {
        throw new TypeError(`[vitehub] contentSource() received duplicate content path ${JSON.stringify(path)}.`)
      }
      nextItems.set(path, item)
    }
    currentItems = nextItems
    return nextItems
  }

  async function findItem(key: string) {
    const path = normalizeSafeSourcePath(key)
    return currentItems.get(path) ?? (await loadItems()).get(path)
  }

  return {
    ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    ...(options.schema === undefined ? {} : { schema: options.schema }),
    async keys() {
      return [...(await loadItems()).keys()]
    },
    async getItem(key) {
      const item = await findItem(key)
      if (!item) throw new TypeError(`[vitehub] contentSource() could not find ${JSON.stringify(key)}.`)
      return textContent(item)
    },
    async getItemRaw(key) {
      const item = await findItem(key)
      if (!item) return
      return item.data ?? item.content
    },
  }
}
