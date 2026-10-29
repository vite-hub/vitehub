import { registerViteHubMcpTools } from "@vite-hub/internal/runtime/mcp-tools"

import { installComments } from "../index.ts"
import { commentsApiRoute, commentsHintCookie, commentsHintQuery, commentsRoute } from "../page.ts"
import { commentsMcpTools } from "./mcp.ts"

import type { Comments } from "../index.ts"
import type { CommentsDatabase } from "../store.ts"
import type { CommentsSessionOptions } from "./session.ts"

export interface CommentsPluginOptions extends CommentsSessionOptions {
  comments: Comments
  /** The Database of `defineComments({ database })`, or undefined when the app has none. */
  database: () => CommentsDatabase | undefined
  /** URL of the overlay script that pages load in comment mode. */
  overlay: string
}

const runtimeKey = Symbol.for("vitehub.comments.runtime")

/** The Comments definition that the Nitro plugin installed, for the Console reader. */
export function installedComments(): Comments | undefined {
  const value: unknown = Reflect.get(globalThis, runtimeKey)
  // SAFETY: only defineCommentsPlugin() writes this process slot, with a Comments definition.
  return value === undefined ? undefined : value as Comments
}

/** Whether a request asks for comment mode: the `?comments` query or the hint cookie that the session route sets. */
export function wantsCommentMode(request: Request, base = ""): boolean {
  const url = new URL(request.url)
  if (base && url.pathname !== base && !url.pathname.startsWith(`${base}/`)) return false
  const path = url.pathname.slice(base.length)
  if (path.startsWith("/_vitehub") || path.startsWith("/api/")) return false
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
export function injectOverlay(response: Response, src: string, policyHeaders: Headers = response.headers): Response {
  const type = response.headers.get("content-type") ?? ""
  if (!response.body || response.status !== 200 || !type.includes("text/html")) return response
  const tag = scriptTag(src, scriptNonce(policyHeaders))
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

/** The parts of an H3 1 event that the Nitro 2 hooks read. */
interface Nitro2Event {
  web?: { request?: Request }
  node?: {
    req?: { url?: string, headers?: Record<string, string> }
    res?: { setHeader?: (name: string, value: string) => void, getHeader?: (name: string) => unknown }
  }
}

/** The Web request of an H3 1 event. Only the path, query, and headers matter for comment mode. */
function nitro2Request(event: Nitro2Event): Request | undefined {
  const node = event.node?.req
  return event.web?.request ?? (node?.url ? new Request(new URL(node.url, "http://localhost"), { headers: node.headers }) : undefined)
}

/**
 * The Nitro plugin of Comments. It connects the definition to its Database, and adds the overlay script to HTML pages
 * of requests in comment mode. Pages without the hint are returned unchanged.
 */
export function defineCommentsPlugin(options: CommentsPluginOptions): (nitroApp: unknown) => void {
  const base = commentsApiRoute(new URL(options.overlay, "http://localhost").href).slice(0, -commentsRoute.length)
  return (nitroApp) => {
    const database = options.database()
    if (database) installComments(options.comments, { database })
    else console.warn("[vitehub] Comments has no Database. Enable one with `vitehub({ database: true })`, or set `defineComments({ database })` to a Database name.")
    Reflect.set(globalThis, runtimeKey, options.comments)
    // The ViteHub MCP server at `/_vitehub/mcp` lists them for people with Console access to Comments.
    registerViteHubMcpTools("comments", commentsMcpTools(options.comments, { session: options.session, consoleSession: options.consoleSession }))

    if (nitroApp === null || typeof nitroApp !== "object") return
    // Nitro 3: the Web fetch entry that every preset calls.
    const fetch: unknown = Reflect.get(nitroApp, "fetch")
    if (fetch instanceof Function) {
      Reflect.set(nitroApp, "fetch", async (request: Request, ...rest: unknown[]) => {
        const response: unknown = await Reflect.apply(fetch, nitroApp, [request, ...rest])
        return response instanceof Response && request instanceof Request && wantsCommentMode(request, base) ? injectOverlay(response, options.overlay) : response
      })
      return
    }
    // Nitro 2 with Nuxt: the HTML render hook for rendered pages, and the response hook for the pages that a route
    // returns as a `Response`, such as a prerendered file that a Cloudflare Worker reads from its assets.
    const hooks: unknown = Reflect.get(nitroApp, "hooks")
    const hook: unknown = hooks !== null && typeof hooks === "object" ? Reflect.get(hooks, "hook") : undefined
    if (!(hook instanceof Function)) return
    Reflect.apply(hook, hooks, ["render:html", (html: { bodyAppend: string[] }, context: { event: Nitro2Event }) => {
      const request = nitro2Request(context.event)
      if (!request || !wantsCommentMode(request, base)) return
      const res = context.event.node?.res
      const policy = res?.getHeader?.("content-security-policy")
      html.bodyAppend.push(scriptTag(options.overlay, typeof policy === "string" ? scriptNonce(new Headers({ "content-security-policy": policy })) : undefined))
      // As on the fetch path: a page with the overlay must never reach a shared cache.
      res?.setHeader?.("cache-control", "private, no-store")
    }])
    Reflect.apply(hook, hooks, ["beforeResponse", (event: Nitro2Event, response: { body?: unknown }) => {
      if (!(response.body instanceof Response)) return
      const request = nitro2Request(event)
      if (request && wantsCommentMode(request, base)) {
        // H3 preserves Node response headers unless the returned Response replaces them.
        const headers = new Headers(response.body.headers)
        const policy = event.node?.res?.getHeader?.("content-security-policy")
        if (!headers.has("content-security-policy") && typeof policy === "string") headers.set("content-security-policy", policy)
        response.body = injectOverlay(response.body, options.overlay, headers)
      }
    }])
  }
}
