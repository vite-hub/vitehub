import { comarkContent, contentHub } from "comark-content"
import { defineEventHandler } from "h3"

import type { ComarkContent, ContentOptions, ContentPlugin, ContentSource } from "comark-content"
import type { H3Event } from "h3"
import { contentErrorDiagnostics } from "./error-diagnostics.ts"

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
> = Omit<ContentOptions, "basePath" | "plugins" | "source"> & {
  plugins?: TPlugins
  source?: ContentSource
  sources?: Record<string, ContentSource>
}

export function defineContent<
  const TPlugins extends ReadonlyArray<ContentPlugin<any, any>> = [],
>(options: DefineContentOptions<TPlugins> = {}): ComarkContent & ContentMethods<TPlugins> {
  const { sources, ...contentOptions } = options
  if (!sources) {
    // SAFETY: Comark's default instance satisfies the ViteHub content surface.
    return comarkContent("default", {
      ...contentOptions,
      basePath: "/api/content",
    }) as ComarkContent & ContentMethods<TPlugins>
  }

  const instances = Object.entries(sources).map(([name, source]) => comarkContent(name, {
    ...contentOptions,
    source,
  }))
  // SAFETY: The hub exposes the same read and handler surface as a content instance.
  const hub: unknown = contentHub(instances, { basePath: "/api/content" })
  return hub as ComarkContent & ContentMethods<TPlugins>
}

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
