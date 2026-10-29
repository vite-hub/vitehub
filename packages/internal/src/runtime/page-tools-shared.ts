/**
 * The names and the session answer that the page tools server and the browser loader share. It has no DOM and no Node
 * code, so both sides import it.
 */

/** The query that turns the page tools on for a page. `?vitehub=<tool id>` also opens that tool. */
export const viteHubPageToolsQuery = "vitehub"

/** The cookie that keeps the page tools on, on the next pages. It is a hint, never a credential. */
export const viteHubPageToolsCookie = "vitehub-tools"

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
export const viteHubPageToolsLoader = "/_vitehub/page/assets/loader.js?v=4"

/** The attribute of the script that loads the page tools. A page that has it does not get a second one. */
export const viteHubPageToolsMarker = "data-vitehub-page-tools"

/** The generated SPA check's opening tag, so the server can recognize it when replacing the check. */
export const viteHubPageToolsInlineStart: string = `<script type="module" ${viteHubPageToolsMarker}>`

/** The exact generated SPA hint check, shared with the server's replacement check. */
export function viteHubPageToolsInlineScript(base: string | undefined): string {
  const hint = `new URLSearchParams(location.search).has(${JSON.stringify(viteHubPageToolsQuery)})||document.cookie.split("; ").includes(${JSON.stringify(`${viteHubPageToolsCookie}=1`)})`
  return `${viteHubPageToolsInlineStart}if(${hint})import(${JSON.stringify(`${viteHubBasePath(base)}${viteHubPageToolsLoader}`)})</script>`
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
  return tool
}

/** The tools of a session answer. Entries without an id or a script are skipped. */
export function readViteHubPageSession(value: unknown): ViteHubPageSession {
  const tools: unknown = value !== null && typeof value === "object" ? Reflect.get(value, "tools") : undefined
  return { tools: Array.isArray(tools) ? tools.map(readTool).filter((tool): tool is ViteHubPageToolInfo => Boolean(tool)) : [] }
}
