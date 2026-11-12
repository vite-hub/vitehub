import { pageToolsHtmlTransform, scriptPolicyNonce } from "./page-tools-html.ts"
import { viteHubBasePath, viteHubPageSessionPath, viteHubPageToolsAssets, viteHubPageToolsCookie, viteHubPageToolsHintCookie, viteHubPageToolsInlineScript, viteHubPageToolsLoader, viteHubPageToolsMarker, viteHubPageToolsQuery, viteHubPageToolsWanted, withViteHubBase } from "./page-tools-shared.ts"
import { forwardedRequestOrigin } from "./request-origin.ts"

import type { ViteHubPageSession, ViteHubPageToolInfo } from "./page-tools-shared.ts"

export { viteHubBasePath, viteHubPageSessionPath, viteHubPageToolsAssets, viteHubPageToolsCookie, viteHubPageToolsLoader, viteHubPageToolsMarker, viteHubPageToolsQuery, withViteHubBase }
export type { ViteHubPageSession, ViteHubPageToolInfo } from "./page-tools-shared.ts"

/**
 * What the visitor check of a tool gets: the Request of the session route. In a ViteHub app, Nitro puts the Standard
 * Context of the request on it (`request["~standard"]`), so helpers that read a request event accept it.
 */
export interface ViteHubPageToolVisitor {
  request: Request
}

/**
 * A tool that ViteHub adds to the app's HTML pages, such as the Comments overlay. An owner package registers it when
 * the server starts, then calls `installViteHubPageTools(nitroApp)`.
 */
export interface ViteHubPageTool extends ViteHubPageToolInfo {
  /**
   * Whether this visitor may use the tool. The session route calls it, and the loader imports only the scripts of
   * allowed tools. It does not replace the access checks of the tool's own API, which must check each call again.
   * `"lazy"` allows the tool but loads its script only when the visitor opens it, such as a sign-in prompt that most
   * visitors never open.
   */
  allowed(visitor: ViteHubPageToolVisitor): Promise<boolean | "lazy">
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

/** Whether a URL is an app page that can get the page tools: inside the app base, and not under `/_vitehub` or `/api`. */
function isPagePath(url: URL, base: string): boolean {
  if (base && url.pathname !== base && !url.pathname.startsWith(`${base}/`)) return false
  const path = pathBelow(base, url.pathname)
  return !(path.startsWith("/_vitehub") || path === "/api" || path.startsWith("/api/"))
}

/**
 * Whether a request asks for the page tools, by the rule of `viteHubPageToolsWanted()`: the `?vitehub` query, the
 * `vitehub-tools=1` cookie that the session route sets, or an Auth session that the session route has not checked yet.
 * It is a hint, never a credential. Paths under `<base>/_vitehub` and `<base>/api/` never get the page tools. `base` is
 * the path of the app base, such as `/portal`.
 */
export function hasViteHubPageToolsHint(request: Request, base = ""): boolean {
  const url = new URL(request.url)
  return isPagePath(url, viteHubBasePath(base)) && viteHubPageToolsWanted(url.search, request.headers.get("cookie") ?? "")
}

/**
 * What ViteHub adds to the page of this request: the loader for a request with the hint, the bootstrap for any other
 * page, or nothing when no tool is registered or the path is not a page.
 */
function pageAddition(nitroApp: object, request: Request, base: string): "loader" | "bootstrap" | undefined {
  const url = new URL(request.url)
  if ((state().tools.get(nitroApp)?.size ?? 0) === 0 || !isPagePath(url, base)) return undefined
  return viteHubPageToolsWanted(url.search, request.headers.get("cookie") ?? "") ? "loader" : "bootstrap"
}

function loaderTag(base: string, nonce?: string): string {
  return `<script type="module" src="${base}${viteHubPageToolsLoader}"${nonce ? ` nonce="${nonce}"` : ""} ${viteHubPageToolsMarker}></script>`
}

function sessionResponse(value: ViteHubPageSession | { error: { code: string, why: string } }, init: { status?: number, cookie?: string } = {}): Response {
  const headers = new Headers({ "cache-control": "private, no-store", "content-type": "application/json; charset=utf-8" })
  if (init.cookie) headers.append("set-cookie", init.cookie)
  return new Response(JSON.stringify(value), { headers, status: init.status ?? 200 })
}

/**
 * Answers `GET <base>/_vitehub/page/session`: the tools whose `allowed` check passes for this visitor, in registration
 * order. The app base is the part of the request path before the session path, as the Console finds its own base, and
 * each tool `script` path gets it. It sets the hint cookie to `1` when at least one tool is allowed, and to `0` when
 * none is, so a signed-in person without access does not ask again on each page. A tool whose check throws is not
 * allowed. Requests from other sites get 403 and run no check.
 */
export async function respondViteHubPageSession(nitroApp: object, request: Request): Promise<Response> {
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
      return await tool.allowed({ request })
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
    .flatMap(({ allowed: _allowed, ...tool }, index) => checks[index] === true || checks[index] === "lazy"
      ? [{ ...tool, ...(checks[index] === "lazy" ? { lazy: true } : {}), script: withViteHubBase(base, tool.script) }]
      : [])
  return sessionResponse({ tools }, { cookie: viteHubPageToolsHintCookie(tools.length > 0) })
}

/**
 * The route of `GET /_vitehub/page/session`: a Fetchable (https://fetchable.org). Nitro 3 binds each Request to its
 * app in `installViteHubPageTools()`, so the route finds the tools of that app.
 */
export const viteHubPageSessionHandler: { fetch(request: Request): Promise<Response> } = {
  async fetch(request) {
    const nitroApp = state().apps.get(request)
    if (!nitroApp) return sessionResponse({ error: { code: "VITEHUB_PAGE_TOOLS_APP", why: "The page tools session has no Nitro app." } }, { status: 503 })
    return await respondViteHubPageSession(nitroApp, request)
  },
}

/**
 * The script nonce of a page's Content Security Policy. A policy with `'strict-dynamic'`, such as the one of
 * nuxt-security, blocks a script without it, even from the same origin.
 */
export function scriptNonce(headers: Headers): string | undefined {
  return scriptPolicyNonce(headers.get("content-security-policy") ?? "")
}

/**
 * Inserts the loader script tag before `</body>` of a streamed HTML body, or at its end when it has none. `base` is the
 * path of the app base, such as `/portal`. A page that already has the loader, such as a single page app whose
 * `index.html` Vite changed, gets no second one. The generated SPA inline check becomes the external loader, with
 * the response policy's nonce when present. This supports header or meta policies that allow same-origin external
 * scripts but block inline scripts. The page varies per person, so it drops `content-length` and sends
 * `cache-control: private, no-store`. Other responses return unchanged, including compressed HTML. `policyHeaders`
 * supplies the effective CSP when the host keeps it outside the Response.
 */
export function injectPageToolsLoader(response: Response, base = "", policyHeaders?: Headers): Response {
  return transformPage(response, () => loaderTag(base, scriptNonce(policyHeaders ?? response.headers)), true)
}

/**
 * Inserts the page tools bootstrap, `viteHubPageToolsInlineScript()`, before `</body>` of an HTML page for a request
 * without the hint, with the response policy's nonce when present. The bootstrap is the same for every visitor, so the
 * page keeps its cache policy. Body validators are removed because they describe the upstream HTML. A page that
 * already has a page tools script, such as a prerendered page, gets no second one. Other responses return unchanged,
 * including compressed HTML and pages without an explicit UTF-8 charset.
 */
function injectPageToolsBootstrap(response: Response, base = "", policyHeaders?: Headers): Response {
  return transformPage(response, () => viteHubPageToolsInlineScript(base, scriptNonce(policyHeaders ?? response.headers)), false)
}

// These describe the upstream body, not the HTML after adding or updating a page tools script.
const pageBodyHeaders = ["content-length", "etag", "last-modified"]
const pageConditions = ["if-none-match", "if-modified-since"]

function hasPageConditions(request: Request): boolean {
  return pageConditions.some(name => request.headers.has(name))
}

/** Whether a request is a page navigation with validators, which must reach the app without them. */
function revalidatesPage(request: Request): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false
  // Browser navigations explicitly accept HTML. Resource requests with other or wildcard Accept values must
  // retain their validators: their paths alone cannot tell us whether the response will be transformed.
  const acceptsHtml = request.headers.get("accept")?.split(",").some((range) => {
    const [type, ...parameters] = range.split(";").map(part => part.trim())
    if (type?.toLowerCase() !== "text/html") return false
    const quality = parameters.find(part => /^q\s*=/i.test(part))?.split("=")[1]?.trim()
    return quality === undefined || (Number(quality) > 0 && Number(quality) <= 1)
  })
  return acceptsHtml === true && hasPageConditions(request)
}

/** The headers of the Node.js request that srvx keeps under `runtime.node.req`, when there is one. */
function nodeRequestHeaders(request: Request): Record<string, unknown> | undefined {
  const runtime: unknown = Reflect.get(request, "runtime")
  if (typeof runtime !== "object" || runtime === null) return undefined
  const node: unknown = Reflect.get(runtime, "node")
  if (typeof node !== "object" || node === null) return undefined
  const req: unknown = Reflect.get(node, "req")
  if (typeof req !== "object" || req === null) return undefined
  const headers: unknown = Reflect.get(req, "headers")
  // SAFETY: IncomingMessage headers are a plain object of header names.
  return typeof headers === "object" && headers !== null ? headers as Record<string, unknown> : undefined
}

function withoutPageConditions(request: Request): Request {
  try {
    // In place: on Node.js, srvx passes its own request class, which `new Request()` cannot copy, and which carries
    // fields that a copy would lose, such as `ip` and `waitUntil`.
    for (const name of pageConditions) request.headers.delete(name)
    // srvx keeps a separate header store on the Node request, and Nitro's Node-format routes read that one.
    const nodeHeaders = nodeRequestHeaders(request)
    if (nodeHeaders) for (const name of pageConditions) delete nodeHeaders[name]
    return request
  }
  catch {
    // The headers of an incoming request on Cloudflare Workers cannot change, and that request is a native one.
    const headers = new Headers(request.headers)
    for (const name of pageConditions) headers.delete(name)
    return new Request(request, { headers })
  }
}

function htmlCharset(type: string): string | undefined {
  return /;\s*charset\s*=\s*"?([^";]*)/i.exec(type)?.[1]?.trim()
}

/** Whether a response is an HTML page that can get a page tools script. It reads the status and type, not the body. */
function isHtmlPage(response: Response): boolean {
  return response.status === 200 && (response.headers.get("content-type") ?? "").toLowerCase().startsWith("text/html")
}

function transformPage(response: Response, tag: () => string, personal: boolean): Response {
  // On Node.js, reading `body` makes srvx build a web Response and stream it, so the checks that need no body go first.
  if (!isHtmlPage(response) || !response.body) return response
  const type = response.headers.get("content-type") ?? ""
  const encoding = response.headers.get("content-encoding")
  if (encoding && encoding.toLowerCase() !== "identity") return response
  const charset = htmlCharset(type)
  // A missing HTTP charset can select a legacy encoding through HTML metadata or browser fallback sniffing.
  if (!/^utf-?8$/i.test(charset ?? "")) return response
  const headers = new Headers(response.headers)
  for (const name of pageBodyHeaders) headers.delete(name)
  if (personal) headers.set("cache-control", "private, no-store")
  return new Response(response.body.pipeThrough(pageToolsHtmlTransform(tag())), { headers, status: response.status, statusText: response.statusText })
}

/** The parts of an H3 1 event that the Nitro 2 hooks read. */
interface Nitro2Event {
  web?: { request?: Request }
  node?: {
    req?: { url?: string, originalUrl?: string, method?: string, headers?: Record<string, string> }
    res?: { statusCode?: number, removeHeader?: (name: string) => void, setHeader?: (name: string, value: string) => void, getHeader?: (name: string) => unknown }
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
 * Adds the page tools to the HTML pages of a Nitro app when at least one tool is registered. A request with the hint
 * gets the loader script, and the page is sent with `cache-control: private, no-store`. Every other page gets the
 * bootstrap, a short inline script that loads the loader in the browser only when the hint appears there. The
 * bootstrap is in prerendered pages too, so a host that serves them as static files, such as Cloudflare Workers
 * static assets, still shows the pill. Call it from each owner's Nitro plugin: it installs once per app, whatever the
 * number of calls. It reads that app's registry and configured base on each request, so plugin order does not matter.
 * - Nitro 3: it wraps `nitroApp.fetch`, the Web entry that every preset and the prerenderer call. The tag uses
 *   `options.base`.
 * - Nitro 2 with Nuxt: it hooks `render:html` for rendered and prerendered pages. It also hooks `beforeResponse`
 *   for pages that a route returns as a `Response`, string, or uncompressed byte buffer
 *   explicitly declared as UTF-8, including prerendered files. The tag uses the base of the request.
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
      const base = state().bases.get(nitroApp) ?? ""
      // An upstream 304 on a document request could reuse a page cached before this bootstrap was deployed, so a
      // request with validators is checked before the app answers. Any other request is checked only when the app
      // answers with an HTML page, so JSON and other responses skip parsing the request URL.
      const conditional = request instanceof Request && hasPageConditions(request)
      const early = conditional ? pageAddition(nitroApp, request, base) : undefined
      if (early && revalidatesPage(request)) request = withoutPageConditions(request)
      // Nitro 3 preserves the Web request as event.req. Each request carries its own app binding.
      if (request instanceof Request) state().apps.set(request, nitroApp)
      const response: unknown = await Reflect.apply(fetch, nitroApp, [request, ...rest])
      if (!(response instanceof Response) || !(request instanceof Request) || !isHtmlPage(response)) return response
      const addition = conditional ? early : pageAddition(nitroApp, request, base)
      if (addition === "loader") return injectPageToolsLoader(response, base)
      return addition === "bootstrap" ? injectPageToolsBootstrap(response, base) : response
    })
    return
  }
  const hooks: unknown = Reflect.get(nitroApp, "hooks")
  const hook: unknown = hooks !== null && typeof hooks === "object" ? Reflect.get(hooks, "hook") : undefined
  if (!(hook instanceof Function)) return
  Reflect.apply(hook, hooks, ["request", (event: Nitro2Event) => {
    const request = nitro2Request(event)
    const base = nitro2Base(event) || state().bases.get(nitroApp) || ""
    if (!request || !pageAddition(nitroApp, request, base)) return
    const method = event.web?.request?.method ?? event.node?.req?.method?.toUpperCase() ?? "GET"
    if (method !== "GET" && method !== "HEAD") return
    if (!revalidatesPage(request)) return
    const unconditional = withoutPageConditions(request)
    if (event.web?.request) event.web.request = unconditional
    const headers = event.node?.req?.headers
    if (headers) for (const name of pageConditions) delete headers[name]
  }])
  Reflect.apply(hook, hooks, ["render:html", (html: { bodyAppend: string[] }, context: { event: Nitro2Event }) => {
    const request = nitro2Request(context.event)
    const base = nitro2Base(context.event) || state().bases.get(nitroApp) || ""
    const addition = request && pageAddition(nitroApp, request, base)
    if (!addition) return
    const res = context.event.node?.res
    const policy = res?.getHeader?.("content-security-policy")
    const nonce = typeof policy === "string" ? scriptNonce(new Headers({ "content-security-policy": policy })) : undefined
    if (addition === "bootstrap") {
      html.bodyAppend.push(viteHubPageToolsInlineScript(base, nonce))
      return
    }
    html.bodyAppend.push(loaderTag(base, nonce))
    // As on the fetch path: a page with the loader must never reach a shared cache.
    res?.setHeader?.("cache-control", "private, no-store")
  }])
  Reflect.apply(hook, hooks, ["beforeResponse", async (event: Nitro2Event, response: { body?: unknown }) => {
    const request = nitro2Request(event)
    const base = nitro2Base(event) || state().bases.get(nitroApp) || ""
    const addition = request && pageAddition(nitroApp, request, base)
    if (!addition) return
    if (response.body instanceof Response) {
      // H3 preserves Node response headers unless the returned Response replaces them.
      const headers = new Headers(response.body.headers)
      const policy = event.node?.res?.getHeader?.("content-security-policy")
      if (!headers.has("content-security-policy") && typeof policy === "string") headers.set("content-security-policy", policy)
      const transformed = addition === "loader" ? injectPageToolsLoader(response.body, base, headers) : injectPageToolsBootstrap(response.body, base, headers)
      if (transformed !== response.body) for (const name of pageBodyHeaders) event.node?.res?.removeHeader?.(name)
      response.body = transformed
      return
    }
    const res = event.node?.res
    const type = res?.getHeader?.("content-type")
    if (typeof type !== "string" || !type.toLowerCase().startsWith("text/html")) return
    if (res?.getHeader?.("content-encoding") || (res?.statusCode ?? 200) !== 200) return
    const body = response.body
    if (typeof body !== "string" && !(body instanceof Uint8Array)) return
    // Without an HTTP charset, HTML may select a legacy encoding from its metadata or fallback sniffing.
    const charset = htmlCharset(type)
    if (body instanceof Uint8Array && !/^utf-?8$/i.test(charset ?? "")) return
    const html = typeof body === "string" ? body : new TextDecoder().decode(body)
    const policy = res?.getHeader?.("content-security-policy")
    const nonce = typeof policy === "string" ? scriptNonce(new Headers({ "content-security-policy": policy })) : undefined
    const tag = addition === "loader" ? loaderTag(base, nonce) : viteHubPageToolsInlineScript(base, nonce)
    response.body = await new Response(new Blob([html]).stream().pipeThrough(pageToolsHtmlTransform(tag))).text()
    for (const name of pageBodyHeaders) res?.removeHeader?.(name)
    if (addition === "loader") res?.setHeader?.("cache-control", "private, no-store")
  }])
}
