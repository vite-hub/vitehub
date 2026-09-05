import { comarkContent } from "comark-content"
import { defineEventHandler } from "h3"

import { createSource, useSource } from "@vite-hub/source"

import type {
  ComarkContent,
  ContentOptions,
  ContentPlugin,
  JsonSchema,
  Source as ComarkContentSource,
} from "comark-content"
import type { H3Event } from "h3"
import type { Source, SourceItem, SourceName } from "@vite-hub/source"

export interface ContentHandler {
  (event: unknown): Promise<unknown>
  fetch(input: Request | URL | string): Promise<Response>
}

export interface ContentHandlerEvent {
  method?: string
  node?: { req: NodeContentRequest }
  req: Request | NodeContentRequest
}

export interface ContentSourceOptions {
  prefix?: string
  schema?: JsonSchema
}

type ContentSourceItem = SourceItem<string, unknown, object>
type ContentSourceFactory = {
  create(options?: ContentSourceOptions): ComarkContentSource
}
type ContentSourceState = {
  latestItems?: Map<string, ContentSourceItem>
  latestSequence: number
  nextSequence: number
}
type NodeContentRequest = {
  aborted: boolean
  headers: Record<string, string | string[] | undefined>
  method?: string
  url?: string
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array>
  once(event: "aborted", listener: () => void): unknown
}
export interface ContentSourceReader {
  items(): Promise<ContentSourceItem[]>
}

export type ContentSourceInput =
  | Source<string, unknown, object>
  | SourceName
  | ContentSourceReader
  | (() => ContentSourceReader)
  | ComarkContentSource

const contentSourceFactory = Symbol("vitehub.contentSourceFactory")

function normalizeContentSourcePath(path = ""): string {
  const raw = path.replace(/\\/g, "/")
  const normalized = raw.replace(/^\/+/, "").replace(/\/+$/, "")
  const parts = normalized.split("/").filter(Boolean)
  if (
    !normalized
    || raw.startsWith("/")
    || /^[a-z]:\//i.test(raw)
    || parts.some(part => part === "." || part === "..")
    || parts[0] === ".git"
    || parts[0] === ".vitehub"
  ) {
    throw new TypeError(`[vitehub] Content Source path escapes the source root: ${path}.`)
  }
  return normalized
}

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
  return normalizeContentSourcePath(item.path || item.key)
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

function isRuntimeFunction(value: unknown): value is Function {
  if (value === null || Object(value) !== value) return false
  try {
    Function.prototype.toString.call(value)
    return true
  } catch {
    return false
  }
}

function isRuntimeObject(value: unknown): value is object {
  return value !== null && Object(value) === value && !isRuntimeFunction(value)
}

function isSourceName(input: ContentSourceInput): input is SourceName {
  return Object(input) !== input && Object.prototype.toString.call(input) === "[object String]"
}

function isComarkContentSource(input: ContentSourceInput): input is ComarkContentSource {
  return (
    isRuntimeObject(input)
    && "getItem" in input
    && isRuntimeFunction(input.getItem)
    && "getItemRaw" in input
    && isRuntimeFunction(input.getItemRaw)
    && "keys" in input
    && isRuntimeFunction(input.keys)
  )
}

function isSourceDefinition(input: ContentSourceInput): input is Source<string, unknown, object> {
  return (
    isRuntimeObject(input)
    && "getKeys" in input
    && isRuntimeFunction(input.getKeys)
    && "getItem" in input
    && isRuntimeFunction(input.getItem)
  )
}

function configuredContentSource(input: ComarkContentSource, options: ContentSourceOptions): ComarkContentSource {
  const source: ComarkContentSource = {
    getItem: input.getItem.bind(input),
    getItemRaw: input.getItemRaw.bind(input),
    keys: input.keys.bind(input),
    prefix: options.prefix ?? input.prefix,
    schema: options.schema ?? input.schema,
  }
  if (input.watch) source.watch = input.watch.bind(input)
  return source
}

function getContentSourceFactory(source: ComarkContentSource): ContentSourceFactory | undefined {
  // SAFETY: Only adapters created below define this private symbol, and they store a ContentSourceFactory.
  return (source as ComarkContentSource & { [contentSourceFactory]?: ContentSourceFactory })[contentSourceFactory]
}

function contentSourceOptions(
  defaults: ContentSourceOptions,
  overrides: ContentSourceOptions,
): ContentSourceOptions {
  return {
    prefix: overrides.prefix ?? defaults.prefix,
    schema: overrides.schema ?? defaults.schema,
  }
}

function createContentSourceFactory(
  sourceInput: Source<string, unknown, object> | SourceName | ContentSourceReader | (() => ContentSourceReader),
  defaults: ContentSourceOptions,
): ContentSourceFactory {
  const state: ContentSourceState = { latestSequence: 0, nextSequence: 0 }
  const factory: ContentSourceFactory = {
    create(overrides = {}) {
      const options = contentSourceOptions(defaults, overrides)
      let itemsPromise: Promise<Map<string, ContentSourceItem>> | undefined

      function loadItems() {
        if (!itemsPromise) {
          const sequence = ++state.nextSequence
          itemsPromise = (async () => {
            const nextItems = new Map<string, ContentSourceItem>()
            const currentReader = isSourceName(sourceInput)
              ? useSource(sourceInput)
              : isSourceDefinition(sourceInput)
                ? createSource(sourceInput)
                : isRuntimeFunction(sourceInput)
                  ? sourceInput()
                  : sourceInput
            for (const item of await currentReader.items()) {
              const path = contentPath(item)
              if (nextItems.has(path)) {
                throw new TypeError(`[vitehub] contentSource() received duplicate content path ${JSON.stringify(path)}.`)
              }
              nextItems.set(path, item)
            }
            if (sequence >= state.latestSequence) {
              state.latestItems = nextItems
              state.latestSequence = sequence
            }
            return nextItems
          })()
        }
        return itemsPromise
      }

      const source: ComarkContentSource = {
        async keys() {
          itemsPromise = undefined
          return [...(await loadItems()).keys()]
        },
        async getItem(key) {
          const path = normalizeContentSourcePath(key)
          const item = (await loadItems()).get(path)
          if (!item) throw new TypeError(`[vitehub] contentSource() could not find ${JSON.stringify(key)}.`)
          return textContent(item)
        },
        async getItemRaw(key) {
          const path = normalizeContentSourcePath(key)
          let items = state.latestItems
          if (itemsPromise) {
            try {
              items = await itemsPromise
            } catch (error) {
              if (!items) throw error
            }
          } else if (!items) {
            items = await loadItems()
          }
          const item = items.get(path)
          if (!item) return
          return item.data ?? item.content
        },
      }
      if (options.prefix !== undefined) source.prefix = options.prefix
      if (options.schema !== undefined) source.schema = options.schema
      Object.defineProperty(source, contentSourceFactory, {
        value: {
          create: (overrides = {}) => factory.create(contentSourceOptions(options, overrides)),
        } satisfies ContentSourceFactory,
      })
      return source
    },
  }
  return factory
}

// Comark reads each enumerable entry once per load, so getters isolate adapted Source snapshots.
function configuredContentSources(inputs: Record<string, ContentSourceInput>): Record<string, ComarkContentSource> {
  const sources: Record<string, ComarkContentSource> = {}
  for (const [name, input] of Object.entries(inputs)) {
    const source = contentSource(input)
    const factory = getContentSourceFactory(source)
    if (factory) {
      Object.defineProperty(sources, name, {
        enumerable: true,
        get: () => factory.create(),
      })
    } else {
      Object.defineProperty(sources, name, {
        enumerable: true,
        value: source,
      })
    }
  }
  return sources
}

/** Adapt a Source to Comark Content, opening a fresh reader for each definition load. */
export function contentSource(input: ContentSourceInput, options: ContentSourceOptions = {}): ComarkContentSource {
  if (isComarkContentSource(input)) {
    const factory = getContentSourceFactory(input)
    if (factory) return factory.create(options)
    return options.prefix === undefined && options.schema === undefined ? input : configuredContentSource(input, options)
  }
  return createContentSourceFactory(input, options).create()
}

/** Define the Comark Content runtime served by ViteHub from `server/content.ts`. */
export function defineContent<
  const TPlugins extends ReadonlyArray<ContentPlugin<any, any>> = [],
>(options: DefineContentOptions<TPlugins> = {}): ComarkContent & ContentMethods<TPlugins> {
  let source = options.source ? contentSource(options.source) : undefined
  let sources = options.sources ? configuredContentSources(options.sources) : undefined
  if (source && getContentSourceFactory(source) && !sources) {
    sources = configuredContentSources({ default: source })
    source = undefined
  }

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
): ContentHandler {
  // SAFETY: ContentHandler preserves the callable and fetch contracts exposed by H3's handler.
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
  }) as ContentHandler
}
