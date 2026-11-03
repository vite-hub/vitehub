/**
 * The names and the session answer that the page tools server and the browser loader share. It has no DOM and no Node
 * code, so both sides import it.
 */

/** The query that turns the page tools on for a page. `?vitehub=<tool id>` also opens that tool. */
export const viteHubPageToolsQuery = "vitehub"

/**
 * Query parameters of links into a tool, such as `?comment=3` of Comments. Like `?vitehub`, they load the page tools,
 * so a person who follows a link sees what it points at. The tool with that `param` opens.
 */
export const viteHubPageToolsLinkParams: readonly string[] = ["comment"]

/**
 * The cookie that remembers the session route's answer for this browser: `1` when a tool allows the person, `0` when
 * none does or the person turned the tools off. It is a hint, never a credential, and it is not HttpOnly, because the
 * page's bootstrap script reads it.
 */
export const viteHubPageToolsCookie = "vitehub-tools"

/**
 * The cookie that tells page scripts that an app Auth session exists. `@vite-hub/auth` sets it to `1` next to the
 * session cookie and clears it on sign-out. It is not HttpOnly and holds no secret.
 */
export const viteHubSessionMarkerCookie = "vitehub_session"

const hintMaxAge = 60 * 60 * 24 * 30

/** The `Set-Cookie` value that stores the session route's answer for 30 days. */
export function viteHubPageToolsHintCookie(allowed: boolean): string {
  return `${viteHubPageToolsCookie}=${allowed ? 1 : 0}; Path=/; Max-Age=${hintMaxAge}; SameSite=Lax`
}

/**
 * The `Set-Cookie` value that forgets the session route's answer. Auth sends it when a session starts or ends, so the
 * next page asks the session route again for the new person.
 */
export const viteHubPageToolsResetCookie: string = `${viteHubPageToolsCookie}=; Path=/; Max-Age=0; SameSite=Lax`

/**
 * Whether a page loads the page tools loader, from its query string and its `Cookie` header or `document.cookie`:
 * - the `?vitehub` query, or
 * - `vitehub-tools=1`, the session route allowed this person, or
 * - `vitehub_session=1` without any `vitehub-tools` cookie: a person signed in and the session route has not answered
 *   for this session yet.
 *
 * `vitehub-tools=0` stops the last case, so a signed-in person without access causes one session request per session.
 */
export function viteHubPageToolsWanted(search: string, cookie: string): boolean {
  const query = new URLSearchParams(search)
  if (query.has(viteHubPageToolsQuery) || viteHubPageToolsLinkParams.some(param => query.has(param))) return true
  const parts = cookie.split(";").map(part => part.trim())
  if (parts.includes(`${viteHubPageToolsCookie}=1`)) return true
  return parts.includes(`${viteHubSessionMarkerCookie}=1`) && !parts.some(part => part.startsWith(`${viteHubPageToolsCookie}=`))
}

/**
 * The URL prefix of the built page tools scripts, such as the loader. It is not `/_vitehub/page`: Nitro answers 404 for
 * any path under a public asset prefix that has no file, and gives the whole prefix the asset cache headers.
 */
export const viteHubPageToolsAssets = "/_vitehub/page/assets"

/** The route of the visitor check. */
export const viteHubPageSessionPath = "/_vitehub/page/session"

/**
 * The URL of the loader script, below the app base. Its version query changes when the loader changes, so caches keep
 * it 5 minutes.
 */
export const viteHubPageToolsLoader = "/_vitehub/page/assets/loader.js?v=14"

/**
 * The buttons of the pill and of each tool's segment. The pill is always the dark review toolbar of Drop, so it reads
 * the same on every site. The pill sets the `--vitehub-pill-*` colors, and segments inherit them through their shadow
 * roots. A pressed or expanded button is inverted, like the active tool in Drop. A busy button, or every button of a
 * busy segment, is inverted too: a tool that is still loading shows the click at once.
 */
export const viteHubPillButtonStyles = `button{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;min-width:28px;height:28px;padding:0 8px;border-radius:8px;font:inherit;white-space:nowrap;color:var(--vitehub-pill-text);cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent;transition-property:background-color,color,scale;transition-duration:150ms;transition-timing-function:cubic-bezier(.23,1,.32,1)}
@media(hover:hover){button:where(:not(:disabled):hover){background:var(--vitehub-pill-hover);color:var(--vitehub-pill-strong)}}
button:where(:not(:disabled):active){scale:.96}
button[aria-pressed=true],button[aria-expanded=true]{background:var(--vitehub-pill-on);color:var(--vitehub-pill-on-text)}
:host([aria-busy=true]) button,button[aria-busy=true]{background:var(--vitehub-pill-on);color:var(--vitehub-pill-on-text);cursor:progress}
button:focus-visible{outline:2px solid var(--vitehub-pill-on);outline-offset:1px}
button svg{width:14px;height:14px;flex:none}
@media(any-pointer:coarse){button{min-width:44px;height:44px}}
@media(prefers-reduced-motion:reduce){button{transition:none}}`

/** The attribute of the script that loads the page tools. A page that has it does not get a second one. */
export const viteHubPageToolsMarker = "data-vitehub-page-tools"

/** The bootstrap's opening tag, so the server can recognize the generated bootstrap when it replaces it. */
export const viteHubPageToolsInlineStart: string = `<script type="module" ${viteHubPageToolsMarker}>`

/**
 * The exact page tools bootstrap: an inline module script that imports `<base>/_vitehub/page/assets/loader.js` only
 * when `viteHubPageToolsWanted()` is true in the browser. Without the hint it makes no request. Vite adds it to a
 * single page app's `index.html`, and the server adds it to every rendered and prerendered page, so static hosts serve
 * it too. A `nonce` goes on the tag for a Content Security Policy with nonces.
 */
export function viteHubPageToolsInlineScript(base: string | undefined, nonce?: string): string {
  const tools = JSON.stringify(`${viteHubPageToolsCookie}=`)
  const params = JSON.stringify([viteHubPageToolsQuery, ...viteHubPageToolsLinkParams])
  const hint = `${params}.some(p=>new URLSearchParams(location.search).has(p))||c.includes(${JSON.stringify(`${viteHubPageToolsCookie}=1`)})||c.includes(${JSON.stringify(`${viteHubSessionMarkerCookie}=1`)})&&!c.some(p=>p.startsWith(${tools}))`
  const start = nonce ? `<script type="module" nonce="${nonce}" ${viteHubPageToolsMarker}>` : viteHubPageToolsInlineStart
  return `${start}const c=document.cookie.split("; ");if(${hint})import(${JSON.stringify(`${viteHubBasePath(base)}${viteHubPageToolsLoader}`)})</script>`
}

/**
 * The path of an app base, without the trailing slash: `/portal/` and `https://cdn.example/portal/` give `/portal`.
 * The root and relative bases (`""`, `"./"`) give `""`. The Console mounts its routes with the same rule.
 */
export function viteHubBasePath(base: string | undefined): string {
  if (!base || base === "./") return ""
  let pathname = base
  if (/^https?:\/\//.test(pathname)) {
    try {
      pathname = new URL(pathname).pathname
    }
    catch {
      return ""
    }
  }
  if (!pathname.startsWith("/") || pathname.startsWith("//")) return ""
  return pathname.replace(/\/+$/, "")
}

/**
 * Adds the app base to a path, such as the `script` of a tool. Full URLs and protocol-relative URLs stay as they are.
 */
export function withViteHubBase(base: string, path: string): string {
  return path.startsWith("/") && !path.startsWith("//") ? `${base}${path}` : path
}

/**
 * The URL of the session route, from the URL of the loader: the loader is at `<base>/_vitehub/page/assets/loader.js`,
 * so the session is at `<base>/_vitehub/page/session`. Without that shape, it is the session path at the root.
 */
export function viteHubPageSessionUrl(loaderUrl: string): string {
  const path = new URL(loaderUrl, "http://localhost").pathname
  const index = path.lastIndexOf(`${viteHubPageToolsAssets}/`)
  return index === -1 ? viteHubPageSessionPath : `${path.slice(0, index)}${viteHubPageSessionPath}`
}

/** Mount a page-tools URL under the application path, ignoring Vite asset bases such as CDN URLs. */
export function viteHubPageToolsPath(path: string, base = ""): string {
  return base.startsWith("/") && !base.startsWith("//") ? `${base.replace(/\/+$/, "")}${path}` : path
}

/** One tool that the visitor may use, as the session route returns it. */
export interface ViteHubPageToolInfo {
  /** The owner, such as `comments`. It also names the tool's segment in the pill. */
  id: string
  /** The display name, such as `Comments`. */
  label: string
  /** An Iconify class, such as `i-lucide-message-square-text`. */
  icon: string
  /** A key that opens the tool, such as `c`. */
  hotkey?: string
  /**
   * The URL of the module script of the tool. A path, such as `/api/_vitehub/comments/assets/overlay.js`, is below the
   * app base: the session route adds the base. A full URL stays as it is.
   */
  script: string
  lazy?: boolean
  /** A query parameter that opens the tool on load, such as `comment` for a link to a comment thread. */
  param?: string
}

/** The answer of `GET /_vitehub/page/session`. */
export interface ViteHubPageSession {
  tools: ViteHubPageToolInfo[]
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

function readTool(value: unknown): ViteHubPageToolInfo | undefined {
  if (value === null || typeof value !== "object") return undefined
  const id = text(Reflect.get(value, "id"))
  const script = text(Reflect.get(value, "script"))
  if (!id || !script) return undefined
  const tool: ViteHubPageToolInfo = { id, label: text(Reflect.get(value, "label")) ?? id, icon: text(Reflect.get(value, "icon")) ?? "", script }
  if (Reflect.get(value, "lazy") === true) tool.lazy = true
  const hotkey = text(Reflect.get(value, "hotkey"))
  if (hotkey) tool.hotkey = hotkey
  const param = text(Reflect.get(value, "param"))
  if (param) tool.param = param
  return tool
}

/** The tools of a session answer. Entries without an id or a script are skipped. */
export function readViteHubPageSession(value: unknown): ViteHubPageSession {
  const tools: unknown = value !== null && typeof value === "object" ? Reflect.get(value, "tools") : undefined
  return { tools: Array.isArray(tools) ? tools.map(readTool).filter((tool): tool is ViteHubPageToolInfo => Boolean(tool)) : [] }
}
