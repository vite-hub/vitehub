import { isH3V1Event, toH3V1Request } from "./h3-v1-request.ts"
import { viteHubPageSessionPath, viteHubPageToolsAssets, viteHubPageToolsCookie, viteHubPageToolsLoader, viteHubPageToolsPath, viteHubPageToolsQuery } from "./page-tools-shared.ts"
import { forwardedRequestOrigin } from "./request-origin.ts"

import type { ViteHubPageSession, ViteHubPageToolInfo } from "./page-tools-shared.ts"

export { viteHubPageSessionPath, viteHubPageToolsAssets, viteHubPageToolsCookie, viteHubPageToolsLoader, viteHubPageToolsQuery }
export type { ViteHubPageSession, ViteHubPageToolInfo } from "./page-tools-shared.ts"

/** What the visitor check of a tool gets: the request of the session route and its H3 event. */
export interface ViteHubPageToolVisitor {
  request: Request
  /** The H3 event of the session route: an H3 2 event on Nitro 3, an H3 1 event on Nitro 2. */
  event: unknown
}

/**
 * A tool that ViteHub adds to the app's HTML pages, such as the Comments overlay. An owner package registers it when
 * the server starts, then calls `installViteHubPageTools(nitroApp)`.
 */
export interface ViteHubPageTool extends ViteHubPageToolInfo {
  /**
   * Whether this visitor may use the tool. The session route calls it, and the loader imports only the scripts of
   * allowed tools. It does not replace the access checks of the tool's own API, which must check each call again.
   */
  allowed(visitor: ViteHubPageToolVisitor): Promise<boolean>
}

interface PageToolsState {
  tools: WeakMap<object, Map<string, ViteHubPageTool>>
  apps: WeakMap<object, object>
  installed: WeakSet<object>
  bases: WeakMap<object, string>
}

const stateKey: unique symbol = Symbol.for("vitehub.page-tools")
// SAFETY: This module owns the process slot. Owner packages bundle their own copy of it, so the registry and the
// installed Nitro apps must be shared through the slot, not through module state.
const scope = globalThis as typeof globalThis & { [stateKey]?: PageToolsState }

function state(): PageToolsState {
  return scope[stateKey] ??= { installed: new WeakSet(), tools: new WeakMap(), apps: new WeakMap(), bases: new WeakMap() }
}

/** Registers a page tool for one Nitro app, before or after installation. The same id replaces only that app's tool. */
export function registerViteHubPageTool(nitroApp: unknown, tool: ViteHubPageTool): void {
  if (nitroApp === null || typeof nitroApp !== "object") return
  const { tools } = state()
  let registry = tools.get(nitroApp)
  if (!registry) {
    registry = new Map()
    tools.set(nitroApp, registry)
  }
  registry.set(tool.id, tool)
}

/**
 * Whether a request asks for the page tools: the `?vitehub` query, or the `vitehub-tools=1` cookie that the session
 * route sets. It is a hint, never a credential. Paths under `/_vitehub` and `/api/` never get the page tools.
 */
export function hasViteHubPageToolsHint(request: Request, base = ""): boolean {
  const url = new URL(request.url)
  base = viteHubPageToolsPath("", base)
  if (base && url.pathname !== base && !url.pathname.startsWith(`${base}/`)) return false
  const path = url.pathname.slice(base.length)
  if (path.startsWith("/_vitehub") || path === "/api" || path.startsWith("/api/")) return false
  if (url.searchParams.has(viteHubPageToolsQuery)) return true
  const cookie = request.headers.get("cookie")
  return Boolean(cookie && cookie.split(";").some(part => part.trim() === `${viteHubPageToolsCookie}=1`))
}

/** Whether ViteHub adds the loader to the page of this request: it has the hint, and a tool is registered. */
function wantsLoader(nitroApp: object, request: Request): boolean {
  return (state().tools.get(nitroApp)?.size ?? 0) > 0 && hasViteHubPageToolsHint(request, state().bases.get(nitroApp))
}

function loaderTag(nonce?: string, base = ""): string {
  return `<script type="module" src="${viteHubPageToolsPath(viteHubPageToolsLoader, base)}"${nonce ? ` nonce="${nonce}"` : ""} data-vitehub-page-tools></script>`
}

const hintMaxAge = 60 * 60 * 24 * 30

function sessionResponse(value: ViteHubPageSession | { error: { code: string, why: string } }, init: { status?: number, cookie?: string } = {}): Response {
  const headers = new Headers({ "cache-control": "private, no-store", "content-type": "application/json; charset=utf-8" })
  if (init.cookie) headers.append("set-cookie", init.cookie)
  return new Response(JSON.stringify(value), { headers, status: init.status ?? 200 })
}

/**
 * Answers `GET /_vitehub/page/session`: the tools whose `allowed` check passes for this visitor, in registration order.
 * It sets the hint cookie when at least one tool is allowed, and clears it when none is. A tool whose check throws is
 * not allowed. Requests from other sites get 403 and run no check.
 */
export async function respondViteHubPageSession(nitroApp: object, request: Request, event: unknown): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return sessionResponse({ error: { code: "VITEHUB_PAGE_TOOLS_METHOD", why: "The page tools session accepts GET only." } }, { status: 405 })
  }
  const origin = request.headers.get("origin")
  if ((origin && origin !== forwardedRequestOrigin(request)) || request.headers.get("sec-fetch-site") === "cross-site") {
    return sessionResponse({ error: { code: "VITEHUB_PAGE_TOOLS_CROSS_ORIGIN", why: "The page tools session answers the site's own pages only." } }, { status: 403 })
  }
  const registered = [...state().tools.get(nitroApp)?.values() ?? []]
  const checks = await Promise.all(registered.map(async (tool) => {
    try {
      return await tool.allowed({ request, event })
    }
    catch (error) {
      console.error(`[vitehub] The visitor check of the page tool "${tool.id}" failed. The tool stays off for this request.`, error)
      return false
    }
  }))
  const tools = registered.filter((_, index) => checks[index] === true).map(({ allowed: _allowed, ...tool }) => tool)
  return sessionResponse({ tools }, {
    cookie: tools.length
      ? `${viteHubPageToolsCookie}=1; Path=/; Max-Age=${hintMaxAge}; SameSite=Lax`
      : `${viteHubPageToolsCookie}=; Path=/; Max-Age=0; SameSite=Lax`,
  })
}

/** The Web request of an H3 2 or H3 1 event. */
function eventRequest(event: unknown): Request | undefined {
  if (event === null || typeof event !== "object") return undefined
  if (isH3V1Event(event)) return toH3V1Request(event)
  const request: unknown = Reflect.get(event, "req")
  return request instanceof Request ? request : undefined
}

/**
 * The Nitro handler of `GET /_vitehub/page/session`. H3 2 and H3 1 both call a plain function with their event, so it
 * serves Nitro 3 and Nitro 2.
 */
export async function viteHubPageSessionHandler(event: unknown): Promise<Response> {
  const request = eventRequest(event)
  if (!request) return sessionResponse({ error: { code: "VITEHUB_PAGE_TOOLS_REQUEST", why: "The page tools session got no request." } }, { status: 400 })
  const nitroApp = state().apps.get(request) ?? (event !== null && typeof event === "object" ? state().apps.get(event) : undefined)
  if (!nitroApp) return sessionResponse({ error: { code: "VITEHUB_PAGE_TOOLS_APP", why: "The page tools session has no Nitro app." } }, { status: 503 })
  return await respondViteHubPageSession(nitroApp, request, event)
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

/**
 * Inserts the loader script tag before `</body>` of a streamed HTML body, or at its end when it has none. The page then
 * varies per person, so it drops `content-length` and sends `cache-control: private, no-store`. Other responses return
 * unchanged, including compressed HTML. `policyHeaders` supplies the effective CSP when the host keeps it outside
 * the Response.
 */
export function injectPageToolsLoader(response: Response, policyHeaders: Headers = response.headers, base = ""): Response {
  const type = response.headers.get("content-type") ?? ""
  if (!response.body || response.status !== 200 || !type.includes("text/html")) return response
  const encoding = response.headers.get("content-encoding")
  if (encoding && encoding.toLowerCase() !== "identity") return response
  const tag = loaderTag(scriptNonce(policyHeaders), base)
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
      let keep = Math.max(0, text.length - 8)
      // Encode a surrogate pair together when the retained tail starts inside an astral character.
      const last = text.charCodeAt(keep - 1)
      if (last >= 0xD800 && last <= 0xDBFF) keep--
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
    req?: { url?: string, originalUrl?: string, headers?: Record<string, string> }
    res?: { setHeader?: (name: string, value: string) => void, getHeader?: (name: string) => unknown }
  }
}

/** The Web request of an H3 1 event. Only the path, query, and headers matter to the hint. */
function nitro2Request(event: Nitro2Event): Request | undefined {
  const node = event.node?.req
  // H3 strips the application base from `url` and keeps the public path in `originalUrl`.
  const path = node?.originalUrl || node?.url
  return event.web?.request ?? (path ? new Request(new URL(path, "http://localhost"), { headers: node?.headers }) : undefined)
}

/**
 * Adds the loader of the page tools to the HTML pages of a Nitro app, for requests with the hint, when at least one
 * tool is registered. Call it from each owner's Nitro plugin: it installs once per app, whatever the number of calls.
 * It reads that app's registry on each request, so plugin order does not matter. Owners may supply the application
 * base pathname even after installation, so reserved routes under that mount stay excluded.
 * - Nitro 3: it wraps `nitroApp.fetch`, the Web entry that every preset calls.
 * - Nitro 2 with Nuxt: it hooks `render:html` for rendered pages, and `beforeResponse` for pages that a route returns
 *   as a `Response`, such as a prerendered file that a Cloudflare Worker reads from its assets.
 */
export function installViteHubPageTools(nitroApp: unknown, base?: string): void {
  if (nitroApp === null || typeof nitroApp !== "object") return
  const { installed, bases } = state()
  if (base !== undefined) bases.set(nitroApp, base)
  if (installed.has(nitroApp)) return
  installed.add(nitroApp)

  const fetch: unknown = Reflect.get(nitroApp, "fetch")
  if (fetch instanceof Function) {
    Reflect.set(nitroApp, "fetch", async (request: Request, ...rest: unknown[]) => {
      // Nitro 3 preserves the Web request as event.req. Each request carries its own app binding.
      if (request instanceof Request) state().apps.set(request, nitroApp)
      const response: unknown = await Reflect.apply(fetch, nitroApp, [request, ...rest])
      return response instanceof Response && request instanceof Request && wantsLoader(nitroApp, request) ? injectPageToolsLoader(response, response.headers, state().bases.get(nitroApp)) : response
    })
    return
  }
  const hooks: unknown = Reflect.get(nitroApp, "hooks")
  const hook: unknown = hooks !== null && typeof hooks === "object" ? Reflect.get(hooks, "hook") : undefined
  if (!(hook instanceof Function)) return
  Reflect.apply(hook, hooks, ["request", (event: object) => {
    state().apps.set(event, nitroApp)
  }])
  Reflect.apply(hook, hooks, ["render:html", (html: { bodyAppend: string[] }, context: { event: Nitro2Event }) => {
    const request = nitro2Request(context.event)
    if (!request || !wantsLoader(nitroApp, request)) return
    const res = context.event.node?.res
    const policy = res?.getHeader?.("content-security-policy")
    html.bodyAppend.push(loaderTag(typeof policy === "string" ? scriptNonce(new Headers({ "content-security-policy": policy })) : undefined, state().bases.get(nitroApp)))
    // As on the fetch path: a page with the loader must never reach a shared cache.
    res?.setHeader?.("cache-control", "private, no-store")
  }])
  Reflect.apply(hook, hooks, ["beforeResponse", (event: Nitro2Event, response: { body?: unknown }) => {
    if (!(response.body instanceof Response)) return
    const request = nitro2Request(event)
    if (request && wantsLoader(nitroApp, request)) {
      // H3 preserves Node response headers unless the returned Response replaces them.
      const headers = new Headers(response.body.headers)
      const policy = event.node?.res?.getHeader?.("content-security-policy")
      if (!headers.has("content-security-policy") && typeof policy === "string") headers.set("content-security-policy", policy)
      response.body = injectPageToolsLoader(response.body, headers, state().bases.get(nitroApp))
    }
  }])
}
