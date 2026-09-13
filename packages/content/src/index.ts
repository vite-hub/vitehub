import { contentErrorDiagnostics } from "./error-diagnostics.ts"
import { buildArtifact, comarkContent, contentHub } from "comark-content"
import { AsyncLocalStorage } from "node:async_hooks"
import { defineEventHandler } from "h3"

import { createSource, useSource } from "@vite-hub/source"

import type {
  Cache,
  CacheArtifactOptions,
  ContentHub,
  ContentGetOptions,
  ContentFile,
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
    throw contentErrorDiagnostics.CONTENT_R0001({ message: `[vitehub] Content Source path escapes the source root: ${path}.` })
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
  throw contentErrorDiagnostics.CONTENT_R0002({ message: `[vitehub] contentSource() cannot read ${JSON.stringify(item.key)} as content.` })
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
                throw contentErrorDiagnostics.CONTENT_R0003({ message: `[vitehub] contentSource() received duplicate content path ${JSON.stringify(path)}.` })
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
          if (!item) throw contentErrorDiagnostics.CONTENT_R0004({ message: `[vitehub] contentSource() could not find ${JSON.stringify(key)}.` })
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

/** Adapt a Source to Comark Content, opening a fresh reader for each definition load. */
export function contentSource(input: ContentSourceInput, options: ContentSourceOptions = {}): ComarkContentSource {
  if (isComarkContentSource(input)) {
    const factory = getContentSourceFactory(input)
    if (factory) return factory.create(options)
    return options.prefix === undefined && options.schema === undefined ? input : configuredContentSource(input, options)
  }
  return createContentSourceFactory(input, options).create()
}

/** Named-source operations retained across the Comark instance API migration. */
export type ContentRuntime = Omit<ContentHub<ComarkContent[]>, "list" | "search" | "media"> & {
  list(names?: string | string[]): ReturnType<ContentHub["list"]>
  search(names: string[], query: string, options?: Parameters<ContentHub["search"]>[1]): ReturnType<ContentHub["search"]>
  getSource(name?: string): ComarkContentSource | undefined
  cache: Omit<Cache, "keys" | "clear"> & {
    clear(name?: string): Promise<void>
    keys(name?: string): Promise<string[]>
    refresh(name: string): ReturnType<ComarkContent["refresh"]>
    snapshot(name: string, options?: CacheArtifactOptions): ReturnType<typeof buildArtifact>
  }
}

function createContentInstance(name: string, source: ComarkContentSource, options: ContentOptions) {
  options = {
    ...options,
    plugins: options.plugins?.map(plugin => plugin && ({
      ...plugin,
      setup(context) {
        const methods = plugin.setup?.(context)
        if (methods) Object.assign(context, methods)
      },
    })),
  }
  const factory = getContentSourceFactory(source)
  if (!factory) return comarkContent(name, { ...options, source })

  // Each async load retains its own Source reader, including parsers that outlive a failed load.
  const loads = new AsyncLocalStorage<ComarkContentSource>()
  const scopedSource: ComarkContentSource = {
    ...source,
    keys: () => (loads.getStore() ?? source).keys(),
    getItem: key => (loads.getStore() ?? source).getItem(key),
    getItemRaw: key => (loads.getStore() ?? source).getItemRaw(key),
  }
  const instance = comarkContent(name, { ...options, source: scopedSource })
  const init = instance.init.bind(instance)
  const refresh = instance.refresh.bind(instance)
  const get = instance.get.bind(instance)
  instance.init = opts => loads.getStore() ? init(opts) : loads.run(factory.create(), () => init(opts))
  instance.refresh = () => loads.run(factory.create(), refresh)
  // SAFETY: The wrapper forwards the key and options without changing the generic document result.
  instance.get = ((key: string, opts?: ContentGetOptions) => loads.run(factory.create(), () => get(key, opts))) as typeof instance.get
  return instance
}

/** Define the Comark Content runtime served by ViteHub from `server/content.ts`. */
export function defineContent<
  const TPlugins extends ReadonlyArray<ContentPlugin<any, any>> = [],
>(options: DefineContentOptions<TPlugins> = {}): ContentRuntime & Omit<ContentMethods<TPlugins>, "search"> {
  if (options.source && options.sources) throw new Error("Define either source or sources, not both.")
  const { source, sources, ...sharedOptions } = options
  const inputs = sources ?? { default: source }
  const instances = Object.entries(inputs).map(([name, input]) => {
    if (!input) throw new Error(`Content source ${JSON.stringify(name)} is missing.`)
    return createContentInstance(name, contentSource(input), { ...sharedOptions, basePath: "/api/content" })
  })
  const hub = contentHub(instances, { basePath: "/api/content", logger: options.logger })
  const byName = new Map(instances.map(instance => [instance.name, instance]))
  function from(name: string) {
    const instance = byName.get(name)
    if (!instance) throw new Error(`Unknown content source ${JSON.stringify(name)}.`)
    return instance
  }
  function cacheForKey(key: string) {
    const instance = instances.find(candidate => key.startsWith(`${candidate.name}:`))
    if (!instance) throw new Error(`Unknown content cache key ${JSON.stringify(key)}.`)
    return instance.cache
  }
  const runtime = {
    ...hub,
    list: (names?: string | string[]) => hub.list(names instanceof Array ? names : names ? [names] : undefined),
    search: (names: string[], query: string, opts?: Parameters<ContentHub["search"]>[1]) => hub.search(query, { ...opts, instances: names }),
    getSource: (name = "default") => byName.get(name)?.getSource(name),
    cache: {
      get: <T = ContentFile>(key: string) => cacheForKey(key).get<T>(key),
      set: <T = ContentFile>(key: string, value: T) => cacheForKey(key).set(key, value),
      invalidate: (key: string) => cacheForKey(key).invalidate(key),
      expire: (key: string) => cacheForKey(key).expire(key),
      async clear(name?: string) {
        await Promise.all((name ? [from(name)] : instances).map(instance => instance.cache.clear()))
      },
      async keys(name?: string) {
        const selected = name ? [from(name)] : instances
        return (await Promise.all(selected.map(instance => instance.cache.keys()))).flat()
      },
      refresh: (name: string) => from(name).refresh(),
      async snapshot(name: string, opts?: CacheArtifactOptions) {
        const instance = from(name)
        const items = await instance.refresh()
        return buildArtifact(name, JSON.stringify({ items, time: Date.now() }), opts)
      },
    },
  }
  // Preserve custom plugin methods; Comark's hub owns cross-source search, query and media.
  for (const instance of instances) {
    for (const [key, value] of Object.entries(instance)) {
      if (!(key in runtime)) Object.defineProperty(runtime, key, { enumerable: true, value })
    }
  }
  // SAFETY: The instances install the declared plugin methods and the hub composes built-in methods.
  return runtime as ContentRuntime & Omit<ContentMethods<TPlugins>, "search">
}

/** Adapt a Comark Content Web handler to an H3/Nitro route. */
export function defineContentHandler(
  content: Pick<ComarkContent, "handler">,
): ContentHandler {
  // SAFETY: ContentHandler preserves the callable and fetch contracts exposed by H3's handler.
  return defineEventHandler(async (event: H3Event) => {
    if (event.req instanceof Request) return await content.handler(event.req)

    if (!event.node) throw contentErrorDiagnostics.CONTENT_R0005({ message: "[vitehub] Content received an unsupported non-Web request." })
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
