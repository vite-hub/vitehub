/**
 * The browser side of the page tools. The page gets one script, the loader. It asks `/_vitehub/page/session` which
 * tools this visitor may use, draws the pill, then imports the script of each tool and calls its default export.
 *
 * This file runs only in the browser. The package's Node program does not include it, because the DOM types conflict
 * with the Node stream types: `tsconfig.browser.json` checks it.
 */
import { readViteHubPageSession, viteHubPageSessionPath, viteHubPageToolsCookie, viteHubPageToolsQuery } from "./page-tools-shared.ts"

import type { ViteHubPageSession, ViteHubPageToolInfo } from "./page-tools-shared.ts"

/** What the loader gives to the default export of a tool module. */
export interface ViteHubPageToolContext {
  tool: ViteHubPageToolInfo
  /**
   * The tool's segment in the pill: a `<vitehub-tool slot="<tool id>">` element. Attach a shadow root to it and draw the
   * tool's controls there, so their CSS stays apart from the pill and from other tools. Inherited styles, such as the
   * pill's text color, font, and `color-scheme`, reach it, so `light-dark()` follows the page. The pill hides a segment
   * that is still empty when the default export returns. Set `bar.hidden` to hide or show it later.
   */
  bar: HTMLElement
  /** Aborts when the tool must stop, such as after `exit()`. The loader then also calls the cleanup function. */
  signal: AbortSignal
  /** True when the page URL has `?vitehub=<this tool id>`. */
  open: boolean
  /**
   * Turns the page tools off for this browser: clears the hint cookie and the query, stops every tool, and removes the
   * pill. The pill's exit button calls it, so a tool does not draw its own.
   */
  exit(): void
}

/** The module at the `script` URL of a tool. The default export mounts the tool and can return a cleanup function. */
export interface ViteHubPageToolModule {
  default(context: ViteHubPageToolContext): void | (() => void)
}

function startOf(module: unknown): ViteHubPageToolModule["default"] | undefined {
  const start: unknown = module !== null && typeof module === "object" ? Reflect.get(module, "default") : undefined
  // SAFETY: a page tool script exports its start function as default. The loader checks that it is a function.
  return start instanceof Function ? start as ViteHubPageToolModule["default"] : undefined
}

// The pill takes its colors from `color-scheme`, which the loader sets from the page, and the page's font. The tools in
// its segments inherit both. Each visible segment ends with a short divider.
const pillStyles = `:host{all:initial;position:fixed;left:50%;bottom:16px;translate:-50% 0;z-index:2147483001;font-size:13px;line-height:1.5;color:light-dark(#3f3f46,#e4e4e7);-webkit-font-smoothing:antialiased}
div{--line:light-dark(#0000000f,#ffffff12);display:flex;align-items:center;gap:2px;padding:4px;border-radius:999px;background:light-dark(#fff,#1c1c1f);box-shadow:0 0 0 1px light-dark(#00000014,#ffffff1a),0 1px 2px #0000000a,0 8px 24px -6px light-dark(#00000029,#0009)}
::slotted(*){display:flex;align-items:center;padding-right:5px;margin-right:3px;background:linear-gradient(var(--line),var(--line)) right/1px 16px no-repeat}
::slotted([hidden]){display:none!important}
button{all:unset;width:32px;height:32px;border-radius:50%;display:grid;place-items:center;cursor:pointer;color:light-dark(#71717a,#a1a1aa)}
button:hover{background:light-dark(#0000000d,#ffffff0f);color:light-dark(#18181b,#fafafa)}
:focus-visible{outline:2px solid #2563eb;outline-offset:2px}`

/** Whether the page shows its dark scheme: a `dark` class (Nuxt UI, Tailwind), `data-theme="dark"`, or `color-scheme`. */
function pageIsDark(): boolean {
  const root = document.documentElement
  if (root.classList.contains("dark") || root.dataset.theme === "dark") return true
  if (root.classList.contains("light") || root.dataset.theme === "light") return false
  const scheme = getComputedStyle(root).colorScheme
  return scheme === "dark" || (scheme.includes("dark") && matchMedia("(prefers-color-scheme: dark)").matches)
}

/**
 * Draws the pill: one `<vitehub-pill>` at the bottom center of the page, with a named slot per tool in session order and
 * the exit button. It follows the page's light or dark scheme until `signal` aborts.
 */
function mountPill(tools: ViteHubPageToolInfo[], exit: () => void, signal: AbortSignal): HTMLElement {
  const pill = document.createElement("vitehub-pill")
  const shadow = pill.attachShadow({ mode: "open" })
  const style = document.createElement("style")
  style.textContent = pillStyles
  const toolbar = document.createElement("div")
  toolbar.setAttribute("role", "toolbar")
  toolbar.setAttribute("aria-label", "ViteHub tools")
  const button = document.createElement("button")
  button.setAttribute("aria-label", "Turn off ViteHub tools")
  button.title = "Turn off ViteHub tools"
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  for (const [name, value] of Object.entries({ width: "15", height: "15", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "aria-hidden": "true" })) svg.setAttribute(name, value)
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path")
  path.setAttribute("d", "M18 6 6 18M6 6l12 12")
  svg.append(path)
  button.append(svg)
  toolbar.append(button)
  shadow.append(style, toolbar)
  for (const tool of tools) {
    const slot = document.createElement("slot")
    slot.name = tool.id
    toolbar.insertBefore(slot, button)
  }
  button.addEventListener("click", exit)
  pill.style.fontFamily = getComputedStyle(document.body).fontFamily

  const theme = () => {
    pill.style.colorScheme = pageIsDark() ? "dark" : "light"
  }
  theme()
  const observer = new MutationObserver(theme)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] })
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", theme, { signal })
  signal.addEventListener("abort", () => {
    observer.disconnect()
    pill.remove()
  }, { once: true })
  document.body.append(pill)
  return pill
}

export interface LoadViteHubPageToolsOptions {
  /** The public session URL. A browser entry resolves it relative to its own loader URL. */
  session?: string
  /** Imports the script of a tool. Default: a dynamic `import()`. */
  load?: (script: string) => Promise<unknown>
}

/**
 * Asks the session route which tools this visitor may use, draws the pill, then starts each tool with its segment.
 * Without an allowed tool it does nothing more: the session route already cleared the hint cookie. When no tool starts,
 * it removes the pill. Returns the tools that it started.
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
  // One pill per page: a second loader on the same page does nothing.
  if (session.tools.length === 0 || document.querySelector("vitehub-pill")) return []

  const open = new URLSearchParams(location.search).get(viteHubPageToolsQuery)
  const pillController = new AbortController()
  const controllers = session.tools.map(() => new AbortController())
  const exit = () => {
    document.cookie = `${viteHubPageToolsCookie}=; Path=/; Max-Age=0; SameSite=Lax`
    const url = new URL(location.href)
    if (url.searchParams.has(viteHubPageToolsQuery)) {
      url.searchParams.delete(viteHubPageToolsQuery)
      history.replaceState(history.state, "", url)
    }
    for (const controller of controllers) controller.abort()
    pillController.abort()
  }
  const pill = mountPill(session.tools, exit, pillController.signal)
  const started = await Promise.all(session.tools.map(async (tool, index) => {
    const { signal } = controllers[index]!
    const bar = document.createElement("vitehub-tool")
    bar.slot = tool.id
    pill.append(bar)
    try {
      const start = startOf(await load(tool.script))
      if (!start) throw new TypeError(`The script ${tool.script} has no default export function.`)
      if (signal.aborted) return undefined
      const cleanup = start({ tool, bar, signal, open: tool.id === open, exit })
      if (!bar.shadowRoot && !bar.hasChildNodes()) bar.hidden = true
      if (cleanup instanceof Function) {
        if (signal.aborted) cleanup()
        else signal.addEventListener("abort", () => cleanup(), { once: true })
      }
      return signal.aborted ? undefined : tool
    }
    catch (error) {
      bar.remove()
      console.error(`[vitehub] The page tool "${tool.id}" did not start.`, error)
      return undefined
    }
  }))
  const tools = started.filter((tool): tool is ViteHubPageToolInfo => Boolean(tool))
  if (tools.length === 0) pillController.abort()
  return tools
}
