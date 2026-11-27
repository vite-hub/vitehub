import { pageToolsHtmlTransform, scriptPolicyNonce } from "./page-tools-html.ts"
import { readViteHubPageAccount, viteHubBasePath, viteHubPageSessionPath, viteHubPageToolsAssets, viteHubPageToolsCookie, viteHubPageToolsHintCookie, viteHubPageToolsInlineScript, viteHubPageToolsLoader, viteHubPageToolsMarker, viteHubPageToolsQuery, viteHubPageToolsWanted, withViteHubBase } from "./page-tools-shared.ts"
import { forwardedRequestOrigin, matchesPublicOrigin } from "./request-origin.ts"

import type { ViteHubPageAccount, ViteHubPageSession, ViteHubPageToolInfo } from "./page-tools-shared.ts"

export { viteHubBasePath, viteHubPageSessionPath, viteHubPageToolsAssets, viteHubPageToolsCookie, viteHubPageToolsLoader, viteHubPageToolsMarker, viteHubPageToolsQuery, withViteHubBase }
export type { ViteHubPageAccount, ViteHubPageSession, ViteHubPageToolInfo } from "./page-tools-shared.ts"

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
  /**
   * The roles that give a permission of this tool, such as `comments-write`. Site access in the Console offers them when
   * someone invites a guest, and signs them into the roles of the Site access token. The tool checks the roles itself.
   */
  grants?: readonly ViteHubPageGrant[]
}

/** A role that gives one permission of a page tool, such as `{ id: "comments-write", label: "Write comments" }`. */
export interface ViteHubPageGrant {
  id: string
  label: string
  description?: string
}

interface PageToolsState {
  tools: WeakMap<object, Map<string, ViteHubPageTool>>
  apps: WeakMap<object, object>
  installed: WeakSet<object>
  bases: WeakMap<object, string>
  // Optional: a copy of this module from an older release may have made the slot without it.
  origins?: WeakMap<object, readonly string[]>
  grants?: Map<string, ViteHubPageGrant>
  siteVisitor?: ViteHubSiteVisitorReader
  // Optional: a copy of this module from an older release may have made the slot without it.
  accounts?: WeakMap<object, ViteHubPageAccountReader>
}

/**
 * Reads the person who is signed in to the app, for the account menu of the pill. It returns `undefined` for a visitor
 * without a session. The owner of the app's Auth registers it, such as the Console of `vite-hub`.
 */
export type ViteHubPageAccountReader = (visitor: ViteHubPageToolVisitor) => Promise<ViteHubPageAccount | undefined>

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
  const grants = state().grants ??= new Map()
  for (const grant of tool.grants ?? []) grants.set(grant.id, grant)
}

/** Registers the account reader of one Nitro app. A second call replaces it. */
export function registerViteHubPageAccount(nitroApp: unknown, read: ViteHubPageAccountReader): void {
  if (nitroApp === null || typeof nitroApp !== "object") return
  const accounts = state().accounts ??= new WeakMap()
  accounts.set(nitroApp, read)
}

/** The account of a visitor, or `undefined` without a reader, without a session, or when the reader fails. */
async function readAccount(nitroApp: object, request: Request): Promise<ViteHubPageAccount | undefined> {
  const read = state().accounts?.get(nitroApp)
  if (!read) return undefined
  try {
    return readViteHubPageAccount(await read({ request }))
  }
  catch (error) {
    console.error("[vitehub] The page tools could not read the signed-in person. The pill shows no account for this request.", error)
    return undefined
  }
}

/**
 * Whether the page tool `id` of the request's app allows this visitor, by the same check as the session route. `false`
 * when the app has no such tool, the check throws, or the request did not come through the app's `fetch`.
 */
export async function viteHubPageToolAllows(request: Request, id: string): Promise<boolean> {
  const nitroApp = state().apps.get(request)
  const tool = nitroApp && state().tools.get(nitroApp)?.get(id)
  if (!tool) return false
  try {
    return await tool.allowed({ request }) === true
  }
  catch (error) {
    console.error(`[vitehub] The visitor check of the page tool "${id}" failed. The tool stays off for this request.`, error)
    return false
  }
}

/** The grants of the request's current tools, or the process grant catalog when called without a request. */
export function viteHubPageGrants(request?: Request): ViteHubPageGrant[] {
  if (request) {
    const app = state().apps.get(request)
    if (!app) return []
    return [...state().tools.get(app)?.values() ?? []].flatMap(tool => tool.grants ?? [])
  }
  return [...state().grants?.values() ?? []]
}

/**
 * A person that Site access in the ViteHub Console signed in to the app: a Console member, or a guest, with their roles,
 * such as `console` and `comments-write`. The Console signs them in a Site access token, which the app keeps in its
 * site cookie.
 */
export interface ViteHubSiteVisitor {
  id: string
  name: string
  email?: string
  image?: string
  roles: string[]
  /** `member` for a member of the Console team, who has the `console` role. `guest` for an invited guest. */
  kind: "member" | "guest"
  commentsAgent?: { project: { id: string, teamId: string, url: string, name?: string }, resolve: boolean }
}

/** Reads the Site access person of a request. It returns undefined without a valid cookie of this app. */
export type ViteHubSiteVisitorReader = (request: Request) => Promise<ViteHubSiteVisitor | undefined>

/**
 * Installs the reader of the Site access cookie. The Console installs it when the server starts, so page tools, such as
 * Comments, know the person without depending on the Console.
 */
export function installViteHubSiteVisitor(reader: ViteHubSiteVisitorReader): void {
  state().siteVisitor = reader
}

/** The reader of the Site access cookie, or undefined in an app where the Console did not install one. */
export function viteHubSiteVisitorReader(): ViteHubSiteVisitorReader | undefined {
  return state().siteVisitor
}

/** Whether the app serves its page tools on the origin of the request. Every origin counts for an app without `origins`. */
function servesOrigin(nitroApp: object, request: Request): boolean {
  return matchesPublicOrigin(request, state().origins?.get(nitroApp) ?? [])
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
  // The prerenderer asks on a made-up origin. A host serves the prerendered page on the public origin.
  if (!request.headers.has("x-nitro-prerender") && !servesOrigin(nitroApp, request)) return undefined
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
 * Answers `GET <base>/_vitehub/page/tools`: the tools whose `allowed` check passes for this visitor, in registration
 * order. The app base is the part of the request path before the session path, as the Console finds its own base, and
 * each tool `script` path gets it. When at least one tool is allowed, the answer also has the `account` of a signed-in
 * visitor, from the reader of `registerViteHubPageAccount()`. An anonymous visitor never gets one. It sets the hint cookie to `1` when at least one tool is allowed, and to `0` when
 * none is, so a signed-in person without access does not ask again on each page. A tool whose check throws is not
 * allowed. Requests from other sites get 403 and run no check. An origin that the app does not serve its page tools on
 * gets 404.
 */
export async function respondViteHubPageSession(nitroApp: object, request: Request): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return sessionResponse({ error: { code: "VITEHUB_PAGE_TOOLS_METHOD", why: "The page tools session accepts GET only." } }, { status: 405 })
  }
  const origin = request.headers.get("origin")
  if ((origin && origin !== forwardedRequestOrigin(request)) || request.headers.get("sec-fetch-site") === "cross-site") {
    return sessionResponse({ error: { code: "VITEHUB_PAGE_TOOLS_CROSS_ORIGIN", why: "The page tools session answers the site's own pages only." } }, { status: 403 })
  }
  if (!servesOrigin(nitroApp, request)) {
    return sessionResponse({ error: { code: "VITEHUB_PAGE_TOOLS_ORIGIN", why: "The page tools answer only on the public URL of the app." } }, { status: 404 })
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
    .flatMap(({ allowed: _allowed, grants: _grants, ...tool }, index) => checks[index] === true || checks[index] === "lazy"
      ? [{ ...tool, ...(checks[index] === "lazy" ? { lazy: true } : {}), script: withViteHubBase(base, tool.script) }]
      : [])
  const account = tools.length > 0 ? await readAccount(nitroApp, request) : undefined
  return sessionResponse(account ? { tools, account } : { tools }, { cookie: viteHubPageToolsHintCookie(tools.length > 0) })
}

/**
 * The route of `GET /_vitehub/page/tools`: a Fetchable (https://fetchable.org). `installViteHubPageTools()` binds
 * each Request to its app in Nitro's `request` hook, so the route finds the tools of that app.
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

/** How the app installs the page tools. */
export interface ViteHubPageToolsInstallOptions {
  /** The app base, such as `/portal/` from the Vite `base`. The loader tag uses it. Default: the root. */
  base?: string
  /**
   * The origins that serve the page tools, such as `["https://shop.example.com"]` from `vitehub({ publicUrl })`. Pages
   * on another hostname of the same deployment get no pill, and the page tools route answers 404 there. Default: every
   * origin.
   */
  origins?: readonly string[]
}

/**
 * Adds the page tools to the HTML pages of a Nitro app when at least one tool is registered. A request with the hint
 * gets the loader script, and the page is sent with `cache-control: private, no-store`. Every other page gets the
 * bootstrap, a short inline script that loads the loader in the browser only when the hint appears there. The
 * bootstrap is in prerendered pages too, so a host that serves them as static files, such as Cloudflare Workers
 * static assets, still shows the pill. Call it from each owner's Nitro plugin: it installs once per app, whatever the
 * number of calls. It reads that app's registry and configured base on each request, so plugin order does not matter.
 * It wraps `nitroApp.fetch`, the Web entry that every preset and the prerenderer call. The tag uses `options.base`.
 * It binds each request to the app in Nitro's `request` hook too, since another wrapper of `fetch` may pass a copy of
 * the request inward, such as the `security` policy of `vite-hub` on Node.js.
 */
export function installViteHubPageTools(nitroApp: unknown, options: ViteHubPageToolsInstallOptions = {}): void {
  if (nitroApp === null || typeof nitroApp !== "object") return
  const { installed, bases } = state()
  if (options.base !== undefined) bases.set(nitroApp, viteHubBasePath(options.base))
  if (options.origins !== undefined) (state().origins ??= new WeakMap()).set(nitroApp, options.origins)
  if (installed.has(nitroApp)) return
  installed.add(nitroApp)

  // The hook gets the `event.req` that the routes get, even when an inner wrapper of `fetch` copied the request.
  const hooks: unknown = Reflect.get(nitroApp, "hooks")
  const hook: unknown = hooks && typeof hooks === "object" ? Reflect.get(hooks, "hook") : undefined
  if (hook instanceof Function) {
    Reflect.apply(hook, hooks, ["request", (event: { req?: unknown } | undefined) => {
      if (event?.req instanceof Request) state().apps.set(event.req, nitroApp)
    }])
  }

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
}
