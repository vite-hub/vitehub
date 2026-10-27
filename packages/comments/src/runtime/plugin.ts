import { registerViteHubMcpTools } from "@vite-hub/internal/runtime/mcp-tools"

import { installComments } from "../index.ts"
import { commentsHintCookie, commentsHintQuery } from "../page.ts"
import { commentsMcpTools } from "./mcp.ts"

import type { Comments } from "../index.ts"
import type { CommentsDatabase } from "../store.ts"

export interface CommentsPluginOptions {
  comments: Comments
  /** The Database of `defineComments({ database })`, or undefined when the app has none. */
  database: () => CommentsDatabase | undefined
  /** URL of the overlay script that pages load in comment mode. */
  overlay: string
  /** Vite's serve/build identity, recorded by the generated plugin. Defaults to false. */
  development?: boolean
}

const runtimeKey = Symbol.for("vitehub.comments.runtime")

/** The Comments definition that the Nitro plugin installed, for the Console reader. */
export function installedComments(): Comments | undefined {
  const value: unknown = Reflect.get(globalThis, runtimeKey)
  // SAFETY: only defineCommentsPlugin() writes this process slot, with a Comments definition.
  return value === undefined ? undefined : value as Comments
}

/** Whether a request asks for comment mode: the `?comments` query or the hint cookie that the session route sets. */
export function wantsCommentMode(request: Request): boolean {
  const url = new URL(request.url)
  if (url.pathname.startsWith("/_vitehub") || url.pathname.startsWith("/api/")) return false
  if (url.searchParams.has(commentsHintQuery)) return true
  const cookie = request.headers.get("cookie")
  return Boolean(cookie && cookie.split(";").some(part => part.trim() === `${commentsHintCookie}=1`))
}

function scriptTag(src: string, nonce?: string): string {
  return `<script type="module" src="${src.replace(/"/g, "&quot;")}"${nonce ? ` nonce="${nonce}"` : ""} data-vitehub-comments></script>`
}

/**
 * The script nonce of a page's Content Security Policy. A policy with `'strict-dynamic'`, such as the one of
 * nuxt-security, blocks a script without it, even from the same origin.
 */
export function scriptNonce(headers: Headers): string | undefined {
  const directives = (headers.get("content-security-policy") ?? "").split(";").map(part => part.trim())
  // Browsers read `script-src-elem`, else `script-src`, else `default-src` for a script element.
  const directive = ["script-src-elem", "script-src", "default-src"]
    .map(name => directives.find(part => part.toLowerCase().startsWith(`${name} `)))
    .find(Boolean)
  return directive ? /'nonce-([\w+/=-]+)'/.exec(directive)?.[1] : undefined
}

/** Inserts the overlay script before `</body>` of a streamed HTML body, or at its end when it has none. */
export function injectOverlay(response: Response, src: string): Response {
  const type = response.headers.get("content-type") ?? ""
  if (!response.body || response.status !== 200 || !type.includes("text/html")) return response
  const tag = scriptTag(src, scriptNonce(response.headers))
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let tail = ""
  let done = false
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (done) {
        controller.enqueue(chunk)
        return
      }
      const text = tail + decoder.decode(chunk, { stream: true })
      const index = text.search(/<\/body\s*>/i)
      if (index !== -1) {
        done = true
        controller.enqueue(encoder.encode(text.slice(0, index) + tag + text.slice(index)))
        tail = ""
        return
      }
      // Keep the end, so a `</body>` split across chunks is still found.
      const keep = Math.max(0, text.length - 8)
      controller.enqueue(encoder.encode(text.slice(0, keep)))
      tail = text.slice(keep)
    },
    flush(controller) {
      const rest = tail + decoder.decode()
      controller.enqueue(encoder.encode(done ? rest : rest + tag))
    },
  })
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  headers.set("cache-control", "private, no-store")
  return new Response(response.body.pipeThrough(transform), { headers, status: response.status, statusText: response.statusText })
}

/**
 * The Nitro plugin of Comments. It connects the definition to its Database, and adds the overlay script to HTML pages
 * of requests in comment mode. Pages without the hint are returned unchanged.
 */
export function defineCommentsPlugin(options: CommentsPluginOptions): (nitroApp: unknown) => void {
  return (nitroApp) => {
    const database = options.database()
    if (database) installComments(options.comments, { database, development: options.development })
    else console.warn("[vitehub] Comments has no Database. Enable one with `vitehub({ database: true })`, or set `defineComments({ database })` to a Database name.")
    Reflect.set(globalThis, runtimeKey, options.comments)
    // The ViteHub MCP server at `/_vitehub/mcp` lists them for people with Console access to Comments.
    registerViteHubMcpTools("comments", commentsMcpTools(options.comments))

    if (nitroApp === null || typeof nitroApp !== "object") return
    // Nitro 3: the Web fetch entry that every preset calls.
    const fetch: unknown = Reflect.get(nitroApp, "fetch")
    if (fetch instanceof Function) {
      Reflect.set(nitroApp, "fetch", async (request: Request, ...rest: unknown[]) => {
        const response: unknown = await Reflect.apply(fetch, nitroApp, [request, ...rest])
        return response instanceof Response && request instanceof Request && wantsCommentMode(request) ? injectOverlay(response, options.overlay) : response
      })
      return
    }
    // Nitro 2 with Nuxt: the HTML render hook.
    const hooks: unknown = Reflect.get(nitroApp, "hooks")
    const hook: unknown = hooks !== null && typeof hooks === "object" ? Reflect.get(hooks, "hook") : undefined
    if (hook instanceof Function) {
      Reflect.apply(hook, hooks, ["render:html", (html: { bodyAppend: string[] }, context: { event: { web?: { request?: Request }, node?: { req?: { url?: string, headers?: Record<string, string> }, res?: { setHeader?: (name: string, value: string) => void, getHeader?: (name: string) => unknown } } } }) => {
        const node = context.event.node?.req
        const request = context.event.web?.request ?? (node?.url ? new Request(new URL(node.url, "http://localhost"), { headers: node.headers }) : undefined)
        if (!request || !wantsCommentMode(request)) return
        const res = context.event.node?.res
        const policy = res?.getHeader?.("content-security-policy")
        html.bodyAppend.push(scriptTag(options.overlay, typeof policy === "string" ? scriptNonce(new Headers({ "content-security-policy": policy })) : undefined))
        // As on the fetch path: a page with the overlay must never reach a shared cache.
        res?.setHeader?.("cache-control", "private, no-store")
      }])
    }
  }
}
