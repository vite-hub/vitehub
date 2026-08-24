import { comarkContent } from "comark-content"
import { defineEventHandler } from "h3"

import { normalizeSafeSourcePath } from "./core/path.ts"
import { useSource } from "./core/registry.ts"

import type {
  ComarkContent,
  ContentOptions,
  ContentPlugin,
  JsonSchema,
  Source as ComarkContentSource,
} from "comark-content"
import type { H3Event } from "h3"
import type { SourceItem, SourceName, SourceReader } from "./core/types.ts"

export interface ContentSourceOptions {
  prefix?: string
  schema?: JsonSchema
}

type ContentSourceItem = SourceItem<string, unknown, object>
type NodeContentRequest = {
  aborted: boolean
  headers: Record<string, string | string[] | undefined>
  method?: string
  url?: string
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array>
  once(event: "aborted", listener: () => void): unknown
}
export type ContentSourceInput = SourceName | SourceReader | (() => SourceReader) | ComarkContentSource

type PluginMethods<TPlugin> = TPlugin extends ContentPlugin<infer TMethods, any> ? TMethods : unknown
type UnionToIntersection<T> = (T extends unknown ? (value: T) => void : never) extends (value: infer TIntersection) => void
  ? TIntersection
  : never
type ContentMethods<TPlugins extends ReadonlyArray<ContentPlugin<any, any>>> =
  TPlugins["length"] extends 0 ? unknown : UnionToIntersection<PluginMethods<TPlugins[number]>>

export type DefineContentOptions<
  TPlugins extends ReadonlyArray<ContentPlugin<any, any>> = ReadonlyArray<ContentPlugin<any, any>>,
> = Omit<ContentOptions, "basePath" | "plugins" | "source" | "sources"> & {
  plugins?: TPlugins
  source?: ContentSourceInput
  sources?: Record<string, ContentSourceInput>
}

function contentPath(item: ContentSourceItem): string {
  return normalizeSafeSourcePath(item.path || item.key)
}

function textContent(item: ContentSourceItem): string {
  if (item.content instanceof Uint8Array) return new TextDecoder().decode(item.content)
  if (item.content !== undefined) return item.content
  if (item.data !== undefined) {
    const serialized = JSON.stringify(item.data)
    if (serialized !== undefined) return serialized
  }
  throw new TypeError(`[vitehub] contentSource() cannot read ${JSON.stringify(item.key)} as content.`)
}

function isComarkContentSource(input: ContentSourceInput): input is ComarkContentSource {
  return input instanceof Object && "getItem" in input && "keys" in input
}

function isSourceReaderFactory(input: SourceName | SourceReader | (() => SourceReader)): input is () => SourceReader {
  return input instanceof Function
}

function isSourceName(input: SourceName | SourceReader | (() => SourceReader)): input is SourceName {
  return !(input instanceof Object)
}

function configuredContentSource(input: ComarkContentSource, options: ContentSourceOptions): ComarkContentSource {
  const source = {
    getItem: input.getItem.bind(input),
    keys: input.keys.bind(input),
    prefix: options.prefix ?? input.prefix,
    schema: options.schema ?? input.schema,
  } as ComarkContentSource
  if (input.getItemRaw) source.getItemRaw = input.getItemRaw.bind(input)
  if (input.watch) source.watch = input.watch.bind(input)
  return source
}

/** Adapt a registered ViteHub Source or Source Reader to the interface consumed by Comark Content. */
export function contentSource(input: ContentSourceInput, options: ContentSourceOptions = {}): ComarkContentSource {
  if (isComarkContentSource(input)) {
    return options.prefix === undefined && options.schema === undefined ? input : configuredContentSource(input, options)
  }
  // SAFETY: The native Comark Source branch returned above, leaving only ViteHub Source inputs.
  const sourceInput = input as SourceName | SourceReader | (() => SourceReader)
  const pendingLoads: Map<string, ContentSourceItem>[] = []
  let latestItems: Map<string, ContentSourceItem> | undefined

  async function loadItems() {
    const nextItems = new Map<string, ContentSourceItem>()
    const currentReader = isSourceName(sourceInput)
      ? useSource(sourceInput)
      : isSourceReaderFactory(sourceInput)
        ? sourceInput()
        : sourceInput
    for (const item of await currentReader.items()) {
      const path = contentPath(item)
      if (nextItems.has(path)) {
        throw new TypeError(`[vitehub] contentSource() received duplicate content path ${JSON.stringify(path)}.`)
      }
      nextItems.set(path, item)
    }
    return nextItems
  }

  async function findItem(key: string) {
    const path = normalizeSafeSourcePath(key)
    const loadIndex = pendingLoads.findIndex(items => items.has(path))
    if (loadIndex !== -1) {
      const items = pendingLoads[loadIndex]!
      const item = items.get(path)
      items.delete(path)
      if (items.size === 0) pendingLoads.splice(loadIndex, 1)
      return item
    }
    return (await loadItems()).get(path)
  }

  const source: ComarkContentSource = {
    async keys() {
      const items = await loadItems()
      latestItems = items
      const pendingItems = new Map(items)
      pendingLoads.push(pendingItems)
      setTimeout(() => {
        const loadIndex = pendingLoads.indexOf(pendingItems)
        if (loadIndex !== -1) pendingLoads.splice(loadIndex, 1)
      }, 0)
      return [...items.keys()]
    },
    async getItem(key) {
      const item = await findItem(key)
      if (!item) throw new TypeError(`[vitehub] contentSource() could not find ${JSON.stringify(key)}.`)
      return textContent(item)
    },
    async getItemRaw(key) {
      const path = normalizeSafeSourcePath(key)
      const item = (latestItems ?? await loadItems()).get(path)
      if (!item) return
      return item.data ?? item.content
    },
  }
  if (options.prefix !== undefined) source.prefix = options.prefix
  if (options.schema !== undefined) source.schema = options.schema
  return source
}

/** Define the Comark Content runtime served by ViteHub from `server/content.ts`. */
export function defineContent<
  const TPlugins extends ReadonlyArray<ContentPlugin<any, any>> = [],
>(options: DefineContentOptions<TPlugins> = {}): ComarkContent & ContentMethods<TPlugins> {
  const source = options.source ? contentSource(options.source) : undefined
  const sources = options.sources
    ? Object.fromEntries(Object.entries(options.sources).map(([name, input]) => [name, contentSource(input)]))
    : undefined

  // SAFETY: Comark plugins add their declared methods to the returned runtime object.
  return comarkContent({
    ...options,
    basePath: "/api/content",
    source,
    sources,
  }) as ComarkContent & ContentMethods<TPlugins>
}

/** Adapt a Comark Content Web handler to an H3/Nitro route. */
export function defineContentHandler(
  content: Pick<ComarkContent, "handler">,
): ReturnType<typeof defineEventHandler> {
  return defineEventHandler(async (event: H3Event) => {
    if (event.req instanceof Request) return await content.handler(event.req)

    if (!event.node) throw new TypeError("[vitehub] Content received an unsupported non-Web request.")
    // SAFETY: H3 exposes a Node IncomingMessage or HTTP/2 request through event.node.req.
    const nodeRequest = event.node.req as NodeContentRequest
    const method = event.method || nodeRequest.method || "GET"
    const headers = new Headers()
    for (const [name, value] of Object.entries(nodeRequest.headers)) {
      if (value === undefined) continue
      if (value instanceof Array) {
        for (const entry of value) headers.append(name, entry)
      }
      else headers.set(name, value)
    }
    const protocol = headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim() || "http"
    const host = headers.get("x-forwarded-host")?.split(",", 1)[0]?.trim()
      || headers.get("host")
      || "localhost"
    const url = new URL(nodeRequest.url || "/", `${protocol}://${host}`)
    let body: Uint8Array | undefined
    if (method !== "GET" && method !== "HEAD") {
      const chunks: Uint8Array[] = []
      for await (const chunk of nodeRequest) {
        chunks.push(chunk)
      }
      const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
      body = new Uint8Array(length)
      let offset = 0
      for (const chunk of chunks) {
        body.set(chunk, offset)
        offset += chunk.byteLength
      }
    }
    const abort = new AbortController()
    if (nodeRequest.aborted) abort.abort()
    else nodeRequest.once("aborted", () => abort.abort())

    return await content.handler(new Request(url, {
      body,
      headers,
      method,
      signal: abort.signal,
    }))
  })
}
