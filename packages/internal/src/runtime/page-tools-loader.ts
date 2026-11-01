import { createViteHubPageWindow } from "./page-tools-window.ts"
import type { ViteHubPageWindow, ViteHubPageWindowOptions } from "./page-tools-window.ts"
/**
 * The browser side of the page tools. The page gets one script, the loader. It asks `<base>/_vitehub/page/session`
 * which tools this visitor may use, draws the pill, then imports the script of each tool and calls its default export.
 * It finds the app base from its own URL, `<base>/_vitehub/page/assets/loader.js`, so it needs no configuration.
 *
 * This file runs only in the browser. The package's Node program does not include it, because the DOM types conflict
 * with the Node stream types: `tsconfig.browser.json` checks it.
 */
import { readViteHubPageSession, viteHubPageSessionUrl, viteHubPageToolsCookie, viteHubPageToolsQuery, viteHubPillButtonStyles } from "./page-tools-shared.ts"

import type { ViteHubPageSession, ViteHubPageToolInfo } from "./page-tools-shared.ts"

/** What the loader gives to the default export of a tool module. */
export interface ViteHubPageToolContext {
  tool: ViteHubPageToolInfo
  /**
   * The tool's segment in the pill: a `<vitehub-tool slot="<tool id>">` element. Attach a shadow root to it and draw the
   * tool's controls there, so their CSS stays apart from the pill and from other tools. Inherited styles, such as the
   * pill's text color, font, dark `color-scheme`, and `--vitehub-pill-*` colors, reach it. Use `viteHubPillButtonStyles`
   * from `page-tools-shared` for its buttons, so every segment matches. The pill hides a segment
   * that is still empty when the default export returns. Set `bar.hidden` to hide or show it later.
   */
  bar: HTMLElement
  /** Aborts when the tool must stop, such as after `exit()`. The loader then also calls the cleanup function. */
  signal: AbortSignal
  /** Whether the tool should open on startup, through query selection, activation, or restored state. */
  open: boolean
  createWindow(options: Omit<ViteHubPageWindowOptions, "signal">): ViteHubPageWindow
  openTool(id: string, path?: string): Promise<boolean>
  onOpen(handler: (path?: string) => void): void
  beforeExit(check: () => boolean): void
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

// Drop's review toolbar: dark glass with the system font on every page. The tools in its segments inherit the colors
// and the font. Space groups the buttons: 8px between segments, 2px inside one.
//
// Collapsed, the glass is the ViteHub hexagon itself, at the center of the bar. The bar keeps its layout and only its
// clip changes, so the morph never reflows and both ends open together: 12 clip points go from the bar's rectangle
// (border-radius rounds it) to the hexagon with softened corners. The hexagon is 40x36 (the mark's 20:18) inside the
// 38px bar, or 58x52 inside the 54px bar of touch screens. The mark moves to the center to be the hexagon's button.
// Collapsing fades the tools out first (80ms) and closes the shape 40ms in, so it never cuts through a label.
const pillBar = "polygon(0 0,0 0,100% 0,100% 0,100% 50%,100% 50%,100% 100%,100% 100%,0 100%,0 100%,0 50%,0 50%)"
const pillHexagon = `polygon(calc(50% + var(--vitehub-pill-hw) * -0.235 - 1.01px) 2.72px,calc(50% + var(--vitehub-pill-hw) * -0.235 + 2px) 1px,calc(50% + var(--vitehub-pill-hw) * 0.235 - 2px) 1px,calc(50% + var(--vitehub-pill-hw) * 0.235 + 1.01px) 2.72px,calc(50% + var(--vitehub-pill-hw) * 0.5 - 1.01px) calc(var(--vitehub-pill-h) / 2 - 1.72px),calc(50% + var(--vitehub-pill-hw) * 0.5 - 1.01px) calc(var(--vitehub-pill-h) / 2 + 1.72px),calc(50% + var(--vitehub-pill-hw) * 0.235 + 1.01px) calc(var(--vitehub-pill-h) - 2.72px),calc(50% + var(--vitehub-pill-hw) * 0.235 - 2px) calc(var(--vitehub-pill-h) - 1px),calc(50% + var(--vitehub-pill-hw) * -0.235 + 2px) calc(var(--vitehub-pill-h) - 1px),calc(50% + var(--vitehub-pill-hw) * -0.235 - 1.01px) calc(var(--vitehub-pill-h) - 2.72px),calc(50% + var(--vitehub-pill-hw) * -0.5 + 1.01px) calc(var(--vitehub-pill-h) / 2 + 1.72px),calc(50% + var(--vitehub-pill-hw) * -0.5 + 1.01px) calc(var(--vitehub-pill-h) / 2 - 1.72px))`
const pillStyles = `:host{all:initial;position:fixed;left:50%;bottom:max(16px,env(safe-area-inset-bottom));translate:-50% 0;z-index:2147483001;pointer-events:none;filter:drop-shadow(0 8px 24px rgb(0 0 0/25%));color-scheme:dark;font:500 12px/1 ui-sans-serif,system-ui,sans-serif;color:#d4d4d4;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;--vitehub-pill-text:#d4d4d4;--vitehub-pill-strong:#fafafa;--vitehub-pill-muted:#a3a3a3;--vitehub-pill-hover:rgb(255 255 255/8%);--vitehub-pill-on:#fafafa;--vitehub-pill-on-text:#0a0a0a;--vitehub-pill-line:rgb(255 255 255/12%);--vitehub-pill-surface:#111;--vitehub-pill-ease:cubic-bezier(.32,.72,0,1);--vitehub-pill-h:38px;--vitehub-pill-hw:calc((var(--vitehub-pill-h) - 2px) * 10 / 9);--vitehub-pill-morph:320ms;--vitehub-pill-fade:opacity 180ms ease-out 80ms,visibility 0s}
:host([collapsed]){--vitehub-pill-morph:240ms;--vitehub-pill-wait:40ms;--vitehub-pill-fade:opacity 80ms ease-out,visibility 0s 80ms}
div{position:relative;box-sizing:border-box;max-width:calc(100vw - 16px);overflow-x:auto;scrollbar-width:none;display:flex;align-items:center;gap:8px;padding:4px;border:1px solid var(--vitehub-pill-line);border-radius:12px;background:rgb(17 17 17/92%);pointer-events:auto;clip-path:${pillBar};transition:clip-path var(--vitehub-pill-morph) var(--vitehub-pill-ease) var(--vitehub-pill-wait,0s),background-color 150ms ease-out,scale 150ms ease-out}
:host([collapsed]) div{clip-path:${pillHexagon}}
@media(hover:hover){:host([collapsed]) div:hover{background:rgb(38 38 38/94%)}}
:host([collapsed]) div:active{scale:.96}
::slotted(*){flex-shrink:0;display:flex;align-items:center;gap:2px;transition:var(--vitehub-pill-fade)}
::slotted([hidden]){display:none!important}
:host([collapsed]) ::slotted(*),:host([collapsed]) .exit{opacity:0;visibility:hidden}
${viteHubPillButtonStyles}
button{flex-shrink:0;padding:0}
.exit{position:sticky;right:0;transition:background-color 150ms,color 150ms,scale 150ms,var(--vitehub-pill-fade)}
.mark{position:sticky;left:0;z-index:1}
.mark,.mark[aria-expanded=true]{background:none;color:var(--vitehub-pill-strong)}
@media(hover:hover){.mark:hover{background:var(--vitehub-pill-hover)}}
.mark svg{width:16px;height:16px;transition:opacity 180ms ease-out 80ms,scale 180ms ease-out 80ms}
:host([collapsed]) .mark svg{opacity:0;scale:.6;transition-duration:80ms;transition-delay:0s;transition-timing-function:ease-out}
:host([collapsed]) .mark:is(:hover,:active){background:none;scale:none}
:host([collapsed]) .mark{position:absolute;left:50%;translate:-50% 0;transition:position 0s 80ms allow-discrete,left 0s 80ms,translate 0s 80ms}
:host([collapsed]) .mark::before{content:"";position:absolute;top:-4px;bottom:-4px;left:50%;width:var(--vitehub-pill-hw);translate:-50% 0}
@media(any-pointer:coarse){:host{--vitehub-pill-h:54px}}
@media(prefers-reduced-motion:reduce){div,::slotted(*),.exit,.mark svg{transition:none}}`

/** The key in `localStorage` that keeps the pill collapsed to the ViteHub mark, on this page and the next ones. */
const collapsedKey = "vitehub-tools-collapsed"

function svgIcon(viewBox: string, path: string, attributes: Record<string, string>): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  for (const [name, value] of Object.entries({ viewBox, "aria-hidden": "true", ...attributes })) svg.setAttribute(name, value)
  const shape = document.createElementNS("http://www.w3.org/2000/svg", "path")
  shape.setAttribute("d", path)
  svg.append(shape)
  return svg
}

function storedCollapsed(): boolean {
  try { return localStorage.getItem(collapsedKey) === "1" }
  catch { return false }
}

/**
 * Draws the pill: one `<vitehub-pill>` at the bottom center of the page, with the ViteHub mark, a named slot per tool in
 * session order, and the exit button. The mark collapses the pill to itself and the browser remembers it.
 */
function mountPill(tools: ViteHubPageToolInfo[], exit: () => void, signal: AbortSignal): HTMLElement {
  const pill = document.createElement("vitehub-pill")
  const shadow = pill.attachShadow({ mode: "open" })
  const style = document.createElement("style")
  style.textContent = pillStyles
  const toolbar = document.createElement("div")
  toolbar.setAttribute("role", "toolbar")
  toolbar.setAttribute("aria-label", "ViteHub tools")
  // The ViteHub mark collapses the pill to itself. The tools keep running: their windows, pins, and modes stay.
  const mark = document.createElement("button")
  mark.className = "mark"
  mark.append(svgIcon("0 0 20 18", "M19.734 8.156 15.576.844A1.66 1.66 0 0 0 14.135 0H5.819C5.226 0 4.677.32 4.38.844L.222 8.156a1.71 1.71 0 0 0 0 1.688l4.158 7.312c.297.523.846.844 1.439.844h8.316c.593 0 1.142-.32 1.438-.844l4.158-7.312c.3-.523.3-1.165.003-1.688Z", { fill: "currentColor" }))
  const collapse = (collapsed: boolean) => {
    pill.toggleAttribute("collapsed", collapsed)
    mark.setAttribute("aria-expanded", String(!collapsed))
    mark.setAttribute("aria-label", collapsed ? "Show ViteHub tools" : "Hide ViteHub tools")
    mark.title = mark.getAttribute("aria-label")!
  }
  collapse(storedCollapsed())
  mark.addEventListener("click", () => {
    const collapsed = !pill.hasAttribute("collapsed")
    collapse(collapsed)
    try { collapsed ? localStorage.setItem(collapsedKey, "1") : localStorage.removeItem(collapsedKey) }
    catch {}
  })
  const button = document.createElement("button")
  button.className = "exit"
  button.setAttribute("aria-label", "Turn off ViteHub tools")
  button.title = "Turn off ViteHub tools"
  button.append(svgIcon("0 0 24 24", "M18 6 6 18M6 6l12 12", { width: "15", height: "15", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round" }))
  toolbar.append(mark, button)
  shadow.append(style, toolbar)
  for (const tool of tools) {
    const slot = document.createElement("slot")
    slot.name = tool.id
    toolbar.insertBefore(slot, button)
  }
  button.addEventListener("click", exit)
  signal.addEventListener("abort", () => pill.remove(), { once: true })
  document.body.append(pill)
  return pill
}

export interface LoadViteHubPageToolsOptions {
  /** Imports the script of a tool. Default: a dynamic `import()`. */
  load?: (script: string) => Promise<unknown>
  /** The URL of the session route. Default: the session route next to this script, below the same app base. */
  session?: string
}

/**
 * Asks the session route which tools this visitor may use, draws the pill, then starts each tool with its segment.
 * Without an allowed tool it does nothing more: the session route already cleared the hint cookie. The pill remains
 * while a tool is mounted or available to launch or retry. Returns those available tools.
 */
export async function loadViteHubPageTools(options: LoadViteHubPageToolsOptions = {}): Promise<ViteHubPageToolInfo[]> {
  // Vite pages load this external module under CSP; visitors without a hint make no session request.
  const query = new URLSearchParams(location.search)
  if (!query.has(viteHubPageToolsQuery) && !document.cookie.split(";").some(part => part.trim() === `${viteHubPageToolsCookie}=1`)) return []
  const load = options.load ?? ((script: string) => import(/* @vite-ignore */ script))
  let session: ViteHubPageSession
  try {
    const response = await fetch(options.session ?? viteHubPageSessionUrl(import.meta.url), { credentials: "same-origin", headers: { accept: "application/json" } })
    if (!response.ok) return []
    session = readViteHubPageSession(await response.json())
  }
  catch {
    return []
  }
  // One pill per page: a second loader on the same page does nothing.
  if (session.tools.length === 0 || document.querySelector("vitehub-pill")) return []

  const open = query.get(viteHubPageToolsQuery)
  const querySelected = session.tools.some(tool => tool.id === open)
  const pillController = new AbortController()
  const controllers = session.tools.map(() => new AbortController())
  const exitChecks = new Set<() => boolean>()
  const exit = () => {
    if ([...exitChecks].some(check => !check())) return
    for (const tool of session.tools) remember(tool.id, false)
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
  const windows = new Map<string, ViteHubPageWindow>()
  const windowKey = (id: string) => `vitehub-open:${options.session ?? viteHubPageSessionUrl(import.meta.url)}:${id}`
  const remember = (id: string, value: boolean) => { try { sessionStorage.setItem(windowKey(id), String(value)) } catch {} }
  const restored = (id: string) => { try { return sessionStorage.getItem(windowKey(id)) === "true" } catch { return false } }
  const activators = new Map<string, (path?: string) => Promise<boolean>>()
  const openTool = async (id: string, path?: string) => await activators.get(id)?.(path) ?? false
  const started = await Promise.all(session.tools.map(async (tool, index) => {
    const { signal } = controllers[index]!
    let bar = document.createElement("vitehub-tool")
    bar.slot = tool.id
    pill.append(bar)
    let activate: ((path?: string) => void) | undefined
    let starting: Promise<boolean> | undefined
    let mounted = false
    const replaceBar = () => {
      const replacement = document.createElement("vitehub-tool")
      replacement.slot = tool.id
      bar.replaceWith(replacement)
      bar = replacement
    }
    const mountLaunch = () => {
      const shadow = bar.attachShadow({ mode: "open" })
      const style = document.createElement("style")
      style.textContent = viteHubPillButtonStyles
      shadow.append(style, launch)
    }
    const run = (path?: string, show = true): Promise<boolean> => {
      if (signal.aborted) return Promise.resolve(false)
      if (mounted) { activate?.(path); return Promise.resolve(true) }
      if (starting) return starting.then(ok => { if (ok) activate?.(path); return ok })
      starting = (async () => {
        const attempt = new AbortController()
        const stop = () => attempt.abort()
        signal.addEventListener("abort", stop, { once: true })
        try {
          bar.setAttribute("aria-busy", "true")
          const start = startOf(await load(tool.script))
          if (!start) throw new TypeError(`The script ${tool.script} has no default export function.`)
          if (signal.aborted) return false
          // Tools own their segment's shadow root; discard the loader's launch control before startup.
          launch.remove()
          if (bar.shadowRoot) replaceBar()
          else bar.replaceChildren()
          const cleanup = start({
            beforeExit: check => {
              const guard = () => check()
              exitChecks.add(guard)
              attempt.signal.addEventListener("abort", () => exitChecks.delete(guard), { once: true })
            }, tool, bar, signal: attempt.signal,
            open: show && (tool.lazy === true || tool.id === open || restored(tool.id)), exit,
            createWindow: options => {
              const window = createViteHubPageWindow({ ...options, signal: attempt.signal, onHide: () => {
                remember(tool.id, false)
                // Collapsed segments hide the window's trigger; the mark remains visible and operable.
                if (pill.hasAttribute("collapsed")) pill.shadowRoot!.querySelector<HTMLButtonElement>("button.mark")!.focus({ preventScroll: true })
                options.onHide?.()
              } })
              const retained = { ...window, show() {
                if (attempt.signal.aborted) return
                for (const [id, other] of windows) if (id !== tool.id) other.hide()
                remember(tool.id, true)
                window.show()
              }, destroy() {
                if (windows.get(tool.id) === retained) {
                  windows.delete(tool.id)
                  remember(tool.id, false)
                }
                window.destroy()
              } }
              windows.set(tool.id, retained)
              return retained
            }, openTool,
            onOpen: handler => { activate = handler },
          })
          mounted = true
          if (path) activate?.(path)
          if (!bar.shadowRoot && !bar.hasChildNodes()) bar.hidden = true
          if (cleanup instanceof Function) {
            if (signal.aborted) cleanup()
            else attempt.signal.addEventListener("abort", () => cleanup(), { once: true })
          }
          return !signal.aborted
        }
        catch (error) {
          attempt.abort()
          signal.removeEventListener("abort", stop)
          if (windows.delete(tool.id)) remember(tool.id, false)
          activate = undefined
          mounted = false
          console.error(`[vitehub] The page tool "${tool.id}" did not start.`, error)
          if (tool.lazy) {
            // A failed tool may have attached a shadow root; retries need a fresh segment.
            replaceBar()
            launch.textContent = `Retry ${tool.label}`
            launch.title = "The tool could not load. Try again."
            bar.hidden = false
            mountLaunch()
          }
          else { activators.delete(tool.id); bar.remove() }
          return false
        }
        finally { bar.removeAttribute("aria-busy"); starting = undefined }
      })()
      return starting
    }
    const launch = document.createElement("button")
    launch.type = "button"
    launch.textContent = tool.label
    launch.addEventListener("click", () => void run())
    activators.set(tool.id, run)
    if (tool.lazy && tool.id !== open && !restored(tool.id)) { mountLaunch(); return tool }
    // Restored tools may mount, but an explicit query selection owns the visible window.
    const ok = await run(undefined, !querySelected || tool.id === open)
    return !signal.aborted && (ok || tool.lazy) ? tool : undefined
  }))
  const tools = started.filter((tool): tool is ViteHubPageToolInfo => Boolean(tool))
  if (tools.length === 0) pillController.abort()
  return tools
}
