import { isH3V1Event, toH3V1Request } from "./h3-v1-request.ts"
import { pageToolsHtmlTransform } from "./page-tools-html.ts"
import { viteHubBasePath, viteHubPageSessionPath, viteHubPageToolsAssets, viteHubPageToolsCookie, viteHubPageToolsLoader, viteHubPageToolsMarker, viteHubPageToolsQuery, withViteHubBase } from "./page-tools-shared.ts"
import { forwardedRequestOrigin } from "./request-origin.ts"

import type { ViteHubPageSession, ViteHubPageToolInfo } from "./page-tools-shared.ts"

export { viteHubBasePath, viteHubPageSessionPath, viteHubPageToolsAssets, viteHubPageToolsCookie, viteHubPageToolsLoader, viteHubPageToolsMarker, viteHubPageToolsQuery, withViteHubBase }
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

/** The path of a URL below the app base. A path outside the base stays as it is. */
function pathBelow(base: string, pathname: string): string {
  return base && (pathname === base || pathname.startsWith(`${base}/`)) ? pathname.slice(base.length) || "/" : pathname
}

/**
 * Whether a request asks for the page tools: the `?vitehub` query, or the `vitehub-tools=1` cookie that the session
 * route sets. It is a hint, never a credential. Paths under `<base>/_vitehub` and `<base>/api/` never get the page
 * tools. `base` is the path of the app base, such as `/portal`.
 */
export function hasViteHubPageToolsHint(request: Request, base = ""): boolean {
  const url = new URL(request.url)
  const path = pathBelow(viteHubBasePath(base), url.pathname)
  if (path.startsWith("/_vitehub") || path.startsWith("/api/")) return false
  if (url.searchParams.has(viteHubPageToolsQuery)) return true
  const cookie = request.headers.get("cookie")
  return Boolean(cookie && cookie.split(";").some(part => part.trim() === `${viteHubPageToolsCookie}=1`))
}

/** Whether ViteHub adds the loader to the page of this request: it has the hint, and a tool is registered. */
function wantsLoader(nitroApp: object, request: Request, base: string): boolean {
  return (state().tools.get(nitroApp)?.size ?? 0) > 0 && hasViteHubPageToolsHint(request, base)
}

function loaderTag(base: string, nonce?: string): string {
  return `<script type="module" src="${base}${viteHubPageToolsLoader}"${nonce ? ` nonce="${nonce}"` : ""} ${viteHubPageToolsMarker}></script>`
}

const hintMaxAge = 60 * 60 * 24 * 30

function sessionResponse(value: ViteHubPageSession | { error: { code: string, why: string } }, init: { status?: number, cookie?: string } = {}): Response {
  const headers = new Headers({ "cache-control": "private, no-store", "content-type": "application/json; charset=utf-8" })
  if (init.cookie) headers.append("set-cookie", init.cookie)
  return new Response(JSON.stringify(value), { headers, status: init.status ?? 200 })
}

/**
 * Answers `GET <base>/_vitehub/page/session`: the tools whose `allowed` check passes for this visitor, in registration
 * order. The app base is the part of the request path before the session path, as the Console finds its own base, and
 * each tool `script` path gets it. It sets the hint cookie when at least one tool is allowed, and clears it when none
 * is. A tool whose check throws is not allowed. Requests from other sites get 403 and run no check.
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
  const pathname = new URL(request.url).pathname
  const at = pathname.lastIndexOf(viteHubPageSessionPath)
  const base = at > 0 ? pathname.slice(0, at) : ""
  const tools = registered
    .filter((_, index) => checks[index] === true)
    .map(({ allowed: _allowed, ...tool }) => ({ ...tool, script: withViteHubBase(base, tool.script) }))
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
 * Inserts the loader script tag before `</body>` of a streamed HTML body, or at its end when it has none. `base` is the
 * path of the app base, such as `/portal`. A page that already has the loader, such as a single page app whose
 * `index.html` Vite changed, gets no second one. The generated SPA inline check becomes the external loader, with
 * the response policy's nonce when present. This supports header or meta policies that allow same-origin external
 * scripts but block inline scripts. The page varies per person, so it drops `content-length` and sends
 * `cache-control: private, no-store`. Other responses return unchanged.
 */
export function injectPageToolsLoader(response: Response, base = ""): Response {
  const type = response.headers.get("content-type") ?? ""
  if (!response.body || response.status !== 200 || !type.includes("text/html")) return response
  const tag = loaderTag(base, scriptNonce(response.headers))
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  headers.set("cache-control", "private, no-store")
  return new Response(response.body.pipeThrough(pageToolsHtmlTransform(tag)), { headers, status: response.status, statusText: response.statusText })
}

/** The parts of an H3 1 event that the Nitro 2 hooks read. */
interface Nitro2Event {
  web?: { request?: Request }
  node?: {
    req?: { url?: string, originalUrl?: string, headers?: Record<string, string> }
    res?: { statusCode?: number, removeHeader?: (name: string) => void, setHeader?: (name: string, value: string) => void, getHeader?: (name: string) => unknown }
  }
}

/** The Web request of an H3 1 event. Only the path, query, and headers matter to the hint. */
function nitro2Request(event: Nitro2Event): Request | undefined {
  const node = event.node?.req
  return event.web?.request ?? (node?.url ? new Request(new URL(node.url, "http://localhost"), { headers: node.headers }) : undefined)
}

/**
 * The app base of an H3 1 event, such as `/portal` for Nuxt `app.baseURL: "/portal/"`. Nitro 2 serves its routes below
 * its `baseURL`, and H3 1 removes that part from `url` and keeps the full path in `originalUrl`. It follows a base that
 * the server gets at runtime, such as `NUXT_APP_BASE_URL`.
 */
function nitro2Base(event: Nitro2Event): string {
  const original = event.node?.req?.originalUrl?.split("?")[0]
  const current = event.node?.req?.url?.split("?")[0]
  if (!original || !current || original === current || !original.endsWith(current)) return ""
  return viteHubBasePath(original.slice(0, original.length - current.length))
}

/** How the app installs the page tools. */
export interface ViteHubPageToolsInstallOptions {
  /**
   * The app base, such as `/portal/` from the Vite `base`. The loader tag of Nitro 3 pages uses it. Nitro 2 reads the
   * base of each request instead. Default: the root.
   */
  base?: string
}

/**
 * Adds the loader of the page tools to the HTML pages of a Nitro app, for requests with the hint, when at least one
 * tool is registered. Call it from each owner's Nitro plugin: it installs once per app, whatever the number of calls.
 * It reads that app's registry and configured base on each request, so plugin order does not matter.
 * - Nitro 3: it wraps `nitroApp.fetch`, the Web entry that every preset calls. The tag uses `options.base`.
 * - Nitro 2 with Nuxt: it hooks `render:html` for rendered pages, and `beforeResponse` for pages that a route returns
 *   as a `Response`, string, or uncompressed byte buffer, including prerendered files. The tag uses the base of
 *   the request.
 */
export function installViteHubPageTools(nitroApp: unknown, options: ViteHubPageToolsInstallOptions = {}): void {
  if (nitroApp === null || typeof nitroApp !== "object") return
  const { installed, bases } = state()
  if (options.base !== undefined) bases.set(nitroApp, viteHubBasePath(options.base))
  if (installed.has(nitroApp)) return
  installed.add(nitroApp)

  const fetch: unknown = Reflect.get(nitroApp, "fetch")
  if (fetch instanceof Function) {
    Reflect.set(nitroApp, "fetch", async (request: Request, ...rest: unknown[]) => {
      // Nitro 3 preserves the Web request as event.req. Each request carries its own app binding.
      if (request instanceof Request) state().apps.set(request, nitroApp)
      const response: unknown = await Reflect.apply(fetch, nitroApp, [request, ...rest])
      const base = state().bases.get(nitroApp) ?? ""
      return response instanceof Response && request instanceof Request && wantsLoader(nitroApp, request, base) ? injectPageToolsLoader(response, base) : response
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
    const base = nitro2Base(context.event) || state().bases.get(nitroApp) || ""
    if (!request || !wantsLoader(nitroApp, request, base)) return
    const res = context.event.node?.res
    const policy = res?.getHeader?.("content-security-policy")
    html.bodyAppend.push(loaderTag(base, typeof policy === "string" ? scriptNonce(new Headers({ "content-security-policy": policy })) : undefined))
    // As on the fetch path: a page with the loader must never reach a shared cache.
    res?.setHeader?.("cache-control", "private, no-store")
  }])
  Reflect.apply(hook, hooks, ["beforeResponse", (event: Nitro2Event, response: { body?: unknown }) => {
    const request = nitro2Request(event)
    const base = nitro2Base(event) || state().bases.get(nitroApp) || ""
    if (!request || !wantsLoader(nitroApp, request, base)) return
    if (response.body instanceof Response) {
      response.body = injectPageToolsLoader(response.body, base)
      return
    }
    const res = event.node?.res
    const type = res?.getHeader?.("content-type")
    if (typeof type !== "string" || !type.toLowerCase().startsWith("text/html")) return
    if (res?.getHeader?.("content-encoding") || (res?.statusCode ?? 200) !== 200) return
    const body = response.body
    if (typeof body !== "string" && !(body instanceof Uint8Array)) return
    const html = typeof body === "string" ? body : new TextDecoder().decode(body)
    const inline = html.indexOf(viteHubPageToolsInlineStart)
    const inlineEnd = inline < 0 ? -1 : html.indexOf("</script>", inline)
    if (inlineEnd < 0 && html.includes(viteHubPageToolsMarker)) return
    const policy = res?.getHeader?.("content-security-policy")
    const tag = loaderTag(base, typeof policy === "string" ? scriptNonce(new Headers({ "content-security-policy": policy })) : undefined)
    if (inlineEnd >= 0) response.body = html.slice(0, inline) + tag + html.slice(inlineEnd + "</script>".length)
    else {
      const end = html.toLowerCase().lastIndexOf("</body>")
      response.body = end < 0 ? html + tag : html.slice(0, end) + tag + html.slice(end)
    }
    res?.removeHeader?.("content-length")
    res?.removeHeader?.("etag")
    res?.setHeader?.("cache-control", "private, no-store")
  }])
}
