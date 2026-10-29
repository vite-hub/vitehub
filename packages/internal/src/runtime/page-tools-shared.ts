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

/** The URL of the loader script. Its version query changes when the loader changes, so caches keep it 5 minutes. */
export const viteHubPageToolsLoader = "/_vitehub/page/assets/loader.js?v=2"

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
  /** The URL of the module script of the tool. */
  script: string
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
  const hotkey = text(Reflect.get(value, "hotkey"))
  if (hotkey) tool.hotkey = hotkey
  return tool
}

/** The tools of a session answer. Entries without an id or a script are skipped. */
export function readViteHubPageSession(value: unknown): ViteHubPageSession {
  const tools: unknown = value !== null && typeof value === "object" ? Reflect.get(value, "tools") : undefined
  return { tools: Array.isArray(tools) ? tools.map(readTool).filter((tool): tool is ViteHubPageToolInfo => Boolean(tool)) : [] }
}
