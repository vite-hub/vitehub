/**
 * The browser side of the page tools. The page gets one script, the loader. It asks `/_vitehub/page/session` which
 * tools this visitor may use, then imports the script of each one and calls its default export.
 */

// This package compiles without the DOM types, which conflict with the Node stream types. The loader reads only these
// browser globals.
declare const location: { readonly href: string, readonly search: string }
declare const document: { cookie: string }
declare const history: { readonly state: unknown, replaceState(state: unknown, unused: string, url: URL): void }

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
  /** The owner, such as `comments`. */
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

/** What the loader gives to the default export of a tool module. */
export interface ViteHubPageToolContext {
  tool: ViteHubPageToolInfo
  /** Aborts when the tool must stop, such as after `exit()`. The loader then also calls the cleanup function. */
  signal: AbortSignal
  /** True when the page URL has `?vitehub=<this tool id>`. */
  open: boolean
  /** Turns the page tools off for this browser: clears the hint cookie and the query, and stops every tool. */
  exit(): void
}

/** The module at the `script` URL of a tool. The default export mounts the tool and can return a cleanup function. */
export interface ViteHubPageToolModule {
  default(context: ViteHubPageToolContext): void | (() => void)
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

function startOf(module: unknown): ViteHubPageToolModule["default"] | undefined {
  const start: unknown = module !== null && typeof module === "object" ? Reflect.get(module, "default") : undefined
  // SAFETY: a page tool script exports its start function as default. The loader checks that it is a function.
  return start instanceof Function ? start as ViteHubPageToolModule["default"] : undefined
}

export interface LoadViteHubPageToolsOptions {
  /** The public session URL. A browser entry resolves it relative to its own loader URL. */
  session?: string
  /** Imports the script of a tool. Default: a dynamic `import()`. */
  load?: (script: string) => Promise<unknown>
}

/**
 * Asks the session route which tools this visitor may use, then starts each one. Without an allowed tool it does
 * nothing more: the session route already cleared the hint cookie. Returns the tools that it started.
 */
export async function loadViteHubPageTools(options: LoadViteHubPageToolsOptions = {}): Promise<ViteHubPageToolInfo[]> {
  const load = options.load ?? ((script: string) => import(/* @vite-ignore */ script))
  let session: ViteHubPageSession
  try {
    const response = await fetch(options.session ?? viteHubPageSessionPath, { credentials: "same-origin", headers: { accept: "application/json" } })
    if (!response.ok) return []
    session = readViteHubPageSession(await response.json())
  }
  catch {
    return []
  }
  if (session.tools.length === 0) return []

  const open = new URLSearchParams(location.search).get(viteHubPageToolsQuery)
  const controllers = session.tools.map(() => new AbortController())
  const exit = () => {
    document.cookie = `${viteHubPageToolsCookie}=; Path=/; Max-Age=0; SameSite=Lax`
    const url = new URL(location.href)
    if (url.searchParams.has(viteHubPageToolsQuery)) {
      url.searchParams.delete(viteHubPageToolsQuery)
      history.replaceState(history.state, "", url)
    }
    for (const controller of controllers) controller.abort()
  }
  const started = await Promise.all(session.tools.map(async (tool, index) => {
    const { signal } = controllers[index]!
    try {
      const start = startOf(await load(tool.script))
      if (!start) throw new TypeError(`The script ${tool.script} has no default export function.`)
      if (signal.aborted) return undefined
      const cleanup = start({ tool, signal, open: tool.id === open, exit })
      if (cleanup instanceof Function) {
        if (signal.aborted) cleanup()
        else signal.addEventListener("abort", () => cleanup(), { once: true })
      }
      return signal.aborted ? undefined : tool
    }
    catch (error) {
      console.error(`[vitehub] The page tool "${tool.id}" did not start.`, error)
      return undefined
    }
  }))
  return started.filter((tool): tool is ViteHubPageToolInfo => Boolean(tool))
}
