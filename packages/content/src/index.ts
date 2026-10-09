import { contentErrorDiagnostics } from "./error-diagnostics.ts"
import { buildArtifact, contentHub } from "comark-content"
import { defineEventHandler } from "h3"

import type {
  Cache,
  CacheArtifactOptions,
  ContentHub,
  ContentFile,
  ComarkContent,
  ContentOptions,
  ContentPlugin,
  Source as ComarkContentSource,
} from "comark-content"
import type { H3Event } from "h3"
import { createContentInstance } from "./content-source.ts"
import type { ContentSourceInput } from "./content-source.ts"
export { contentSource } from "./content-source.ts"
export type { ContentSourceInput, ContentSourceOptions, ContentSourceReader } from "./content-source.ts"

export interface ContentHandler {
  (event: unknown): Promise<unknown>
  fetch(input: Request | URL | string): Promise<Response>
}

export interface ContentHandlerEvent {
  method?: string
  node?: { req: NodeContentRequest }
  req: Request | NodeContentRequest
}

type NodeContentRequest = {
  aborted: boolean
  headers: Record<string, string | string[] | undefined>
  method?: string
  url?: string
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array>
  once(event: "aborted", listener: () => void): unknown
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

/** Define the Comark Content runtime served by ViteHub from `server/content.ts`. */
export function defineContent<
  const TPlugins extends ReadonlyArray<ContentPlugin<any, any>> = [],
>(options: DefineContentOptions<TPlugins> = {}): ContentRuntime & Omit<ContentMethods<TPlugins>, "search"> {
  if (options.source && options.sources) throw new Error("Define either source or sources, not both.")
  const { source, sources, ...sharedOptions } = options
  const inputs = sources ?? { default: source }
  const instances = Object.entries(inputs).map(([name, input]) => {
    if (!input) throw new Error(`Content source ${JSON.stringify(name)} is missing.`)
    return createContentInstance(name, input, { ...sharedOptions, basePath: "/api/content" })
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
      if (!Object.hasOwn(runtime, key)) Object.defineProperty(runtime, key, { enumerable: true, value })
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
