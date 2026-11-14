import { mountViteHubPageAccount } from "./page-account.ts"
import { closeViteHubPagePill, dragViteHubPageDock, mountViteHubPagePill, storedViteHubPageDock, viteHubPageHexagonSize, viteHubPagePillStyles, viteHubPageSvgIcon } from "./page-pill.ts"
import { createViteHubPageWindow, dockViteHubPageWindows } from "./page-tools-window.ts"
import type { ViteHubPageToolsDock, ViteHubPageWindow, ViteHubPageWindowOptions } from "./page-tools-window.ts"

export { viteHubPageToolsEdgeAt } from "./page-pill.ts"
/**
 * The browser side of the page tools. The page gets one script, the loader. It asks `<base>/_vitehub/page/session`
 * which tools this visitor may use, draws the pill, then imports the script of each tool and calls its default export.
 * It finds the app base from its own URL, `<base>/_vitehub/page/assets/loader.js`, so it needs no configuration.
 *
 * This file runs only in the browser. The package's Node program does not include it, because the DOM types conflict
 * with the Node stream types: `tsconfig.browser.json` checks it.
 */
import { readViteHubPageSession, viteHubPageSessionUrl, viteHubPageToolsQuery, viteHubPageToolsWanted, viteHubPillAttribute, viteHubPillButtonStyles } from "./page-tools-shared.ts"

import type { ViteHubPageSession, ViteHubPageToolInfo } from "./page-tools-shared.ts"

/** What the loader gives to the default export of a tool module. */
export interface ViteHubPageToolContext {
  tool: ViteHubPageToolInfo
  /**
   * The tool's segment in the pill: a `<vitehub-tool slot="<tool id>">` element. Attach a shadow root to it and draw the
   * tool's controls there, so their CSS stays apart from the pill and from other tools. Inherited styles, such as the
   * pill's text color, font, dark `color-scheme`, and `--vitehub-pill-*` colors, reach it. `--vitehub-pill-flow` is the
   * `flex-direction` for a row of controls: `column` when the pill docks to the left or right edge. Use
   * `viteHubPillButtonStyles` from `page-tools-shared` for its buttons, so every segment matches. The pill hides a segment
   * that is still empty when the default export returns. Set `bar.hidden` to hide or show it later.
   */
  bar: HTMLElement
  /** Aborts when the tool must stop, such as after `exit()`. The loader then also calls the cleanup function. */
  signal: AbortSignal
  /** Whether the tool should open on startup, through query selection, activation, or restored state. */
  open: boolean
  createWindow(options: Omit<ViteHubPageWindowOptions, "signal">): ViteHubPageWindow
  /**
   * Adds a tab to the pill: a `<vitehub-tab slot="tab">` that stands on the bar's inner side, like a tab on top of a chat
   * box, and grows out from under the bar. Use it for a state of this page that the person must keep in view, such as a
   * draft preview. Draw it like `bar`, in its own shadow root. It goes away with the tool, or when you remove it.
   */
  createTab(): HTMLElement
  openTool(id: string, path?: string): Promise<boolean>
  onOpen(handler: (path?: string) => void): void
  beforeExit(check: () => boolean): void
  /**
   * Turns the page tools off for this browser: removes the query, stops every tool, and leaves a small ViteHub mark
   * where the pill was, on this page and the next ones, that turns them on again. The pill's exit button calls it, so a
   * tool does not draw its own.
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

// The mark that stays when the tools are off: the ViteHub mark itself at 14px high (20px on touch screens), dark with a
// light hairline so it shows on light and dark pages, at the place of the pill. The way back is always there but covers
// almost nothing of the page. It is half transparent until the pointer or the focus reaches it. Its hit area grows 6px
// around it (10px on touch screens) and runs off the edge of the screen, so a pointer pushed against the edge finds
// it, without taking more clicks from the page. Dragging it moves it to another place, like the pill's mark. The pill's
// clipped hexagon would round into a circle at this size. After the exit button, it takes over from the pill's hexagon
// at the hexagon's size and shrinks to its own toward the edge, from the point that keeps its place along the edge.
const offMarkStyles = `:host([off]){--vitehub-hex-h:14px;filter:drop-shadow(0 1px 2px rgb(0 0 0/25%))}
:host([off]) button{position:relative;display:block;width:var(--vitehub-hex-w);min-width:0;height:var(--vitehub-hex-h);padding:0;border-radius:4px;pointer-events:auto;cursor:grab;opacity:.55;transition:opacity 150ms ease-out;animation:vitehub-off-in 200ms cubic-bezier(.23,1,.32,1)}
:host([off][edge=bottom]) button{transform-origin:calc(var(--at) * 1%) 100%}
:host([off][edge=top]) button{transform-origin:calc(var(--at) * 1%) 0}
:host([off][edge=left]) button{transform-origin:0 calc(var(--at) * 1%)}
:host([off][edge=right]) button{transform-origin:100% calc(var(--at) * 1%)}
:host([off][closing]) button{animation:vitehub-off-from-pill 240ms cubic-bezier(.23,1,.32,1)}
:host([off][dragging]) button{opacity:1;cursor:grabbing}
:host([off]) button::before{content:"";position:absolute;inset:-6px}
svg{display:block;width:100%;height:100%;overflow:visible;fill:rgb(17 17 17/92%);stroke:rgb(255 255 255/18%);stroke-width:1px;vector-effect:non-scaling-stroke;transition:fill 150ms ease-out,scale 150ms ease-out}
:host([off]) button:focus-visible{opacity:1}
:host([off][dragging]) svg{scale:none}
@media(hover:hover){:host([off]) button:hover{opacity:1;background:none}button:hover svg{fill:rgb(38 38 38/94%)}}
button:active svg{scale:.96}
@media(any-pointer:coarse){:host([off]){--vitehub-hex-h:20px}:host([off]) button{min-width:0;height:var(--vitehub-hex-h)}:host([off]) button::before{inset:-10px}}
@keyframes vitehub-off-in{from{opacity:0;scale:.6}}
@keyframes vitehub-off-from-pill{from{opacity:1;scale:var(--vitehub-off-from)}}
@media(prefers-reduced-motion:reduce){:host([off]) button,svg{animation:none;transition:none}}`
/** The key in `localStorage` that keeps the page tools off in this browser, so each page draws only the small mark. */
const offKey = "vitehub-tools-off"

/** The key in `localStorage` that keeps the pill collapsed to the ViteHub mark, on this page and the next ones. */
const collapsedKey = "vitehub-tools-collapsed"
/** The key in `localStorage` that keeps the edge and the place where the pill docks. */
const dockKey = "vitehub-tools-dock"

/** The slot of the account item in the pill. Tool ids name the other slots. */
const accountSlot = "vitehub-account"

/** The ViteHub mark, a hexagon with soft corners, in a 20 by 18 box. */
const markPath = "M19.734 8.156 15.576.844A1.66 1.66 0 0 0 14.135 0H5.819C5.226 0 4.677.32 4.38.844L.222 8.156a1.71 1.71 0 0 0 0 1.688l4.158 7.312c.297.523.846.844 1.439.844h8.316c.593 0 1.142-.32 1.438-.844l4.158-7.312c.3-.523.3-1.165.003-1.688Z"

function storedOff(): boolean {
  try { return localStorage.getItem(offKey) === "1" }
  catch { return false }
}

function rememberOff(off: boolean): void {
  try {
    if (off) localStorage.setItem(offKey, "1")
    else localStorage.removeItem(offKey)
  }
  catch {}
}

/**
 * Whether the page asks for the mark only: with `<html data-vitehub-pill="mark">`, because its own bar is there, or
 * because one of its own floating controls sits where the pill docks by default and the person has not moved the pill.
 */
function pageAsksForMark(): boolean {
  return document.documentElement.getAttribute(viteHubPillAttribute) === "mark" || crowded
}

/** Whether a floating control of the page sits at the pill's default place. `watchPageAsk()` keeps it current. */
let crowded = false
/** Whether the person docked the pill or its off mark somewhere. Then the pill stays where they put it. */
let docked = false

function storedDockText(): string | null {
  try { return localStorage.getItem(dockKey) }
  catch { return null }
}

/**
 * Whether a fixed element of the page, or a sticky one that sticks to the bottom, such as its own floating menu button, lies in the middle of the bottom
 * edge, where the pill docks until the person drags it. Elements in the page's flow do not count: the pill floats over
 * text anyway. A layer over most of the screen, such as a backdrop, is no control, but a small element in it is.
 */
function pageControlAtPillPlace(): boolean {
  // A DOM without layout, such as happy-dom in tests, has nothing under the pill.
  if (docked || typeof document.elementsFromPoint !== "function") return false
  const small = (element: Element) => {
    const box = element.getBoundingClientRect()
    return box.width * box.height < innerWidth * innerHeight / 2
  }
  // Points every 16px over the place of the open pill, 280px wide at two heights, so even a small button is found.
  const points = Array.from({ length: 36 }, (_, index) => [
    Math.min(innerWidth - 1, Math.max(0, innerWidth / 2 - 140 + (index % 18) * 16 + 8)),
    innerHeight - (index < 18 ? 24 : 44),
  ] as const)
  const walked = new Set<Element>()
  for (const [x, y] of points) {
    for (const element of document.elementsFromPoint(x, y)) {
      if (walked.has(element)) continue
      walked.add(element)
      for (let node: Element | null = element; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
        if (node.localName.startsWith("vitehub-")) break
        const style = getComputedStyle(node)
        // A sticky element is a control only when it sticks to the bottom edge. A heading that sticks to the top only
        // passes the bottom edge while the page scrolls.
        if (style.position === "fixed" || (style.position === "sticky" && style.bottom !== "auto")) {
          if (small(node) || (node !== element && small(element))) return true
          break
        }
        // Content that scrolls in a fixed layer, such as the main column of an app shell, is the page's flow.
        if (/auto|scroll/.test(style.overflowY) && node.scrollHeight > node.clientHeight) break
      }
    }
  }
  return false
}

/**
 * Where the pill goes while the page asks for the mark: the nearer end of the bottom edge, out of the way of a bar
 * centered on it. The ends of the top edge hold a page's back button and menus, so on the other edges it keeps its place.
 */
function asideOf(dock: ViteHubPageToolsDock): ViteHubPageToolsDock {
  return dock.edge === "bottom" ? { edge: "bottom", at: dock.at < 50 ? 0 : 100 } : dock
}

/**
 * Calls `change` each time the page starts or stops asking for the mark, until `signal` aborts. A resize, a change of
 * the page's elements, or a drop of the pill can uncover or cover the pill's default place, so each one checks it again.
 */
function watchPageAsk(change: () => void, signal: AbortSignal): void {
  let asked = pageAsksForMark()
  // Another tab that saves a dock sends a storage event. Without one, only a drop on this page changes the stored dock.
  let seen = storedDockText()
  const check = () => {
    docked ||= storedDockText() !== seen
    const was = crowded
    crowded = pageControlAtPillPlace()
    // A drop of the folded mark ends the avoidance: the pill stays as the person sees it, folded, instead of opening.
    if (was && !crowded && docked && document.querySelector("vitehub-pill")?.hasAttribute("collapsed")) {
      try { localStorage.setItem(collapsedKey, "1") }
      catch {}
    }
    if (pageAsksForMark() === asked) return
    asked = !asked
    change()
  }
  const observer = new MutationObserver(check)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: [viteHubPillAttribute] })
  // At most one check each 200ms, also on a page that changes all the time.
  let timer: ReturnType<typeof setTimeout> | undefined
  const later = () => {
    timer ??= setTimeout(() => {
      timer = undefined
      check()
    }, 200)
  }
  // A page can add or show its floating control after the pill, such as a chat widget that loads late or a back-to-top
  // button that a scroll reveals with a class. The pill's own changes do not count.
  const added = new MutationObserver((records) => {
    if (records.some(record => !(record.target instanceof Element && record.target.localName.startsWith("vitehub-")))) later()
  })
  added.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "class", "style"] })
  addEventListener("scroll", later, { capture: true, passive: true, signal })
  addEventListener("resize", later, { signal })
  addEventListener("storage", (event) => {
    if (event.key === null || event.key === dockKey) seen = storedDockText()
    later()
  }, { signal })
  document.addEventListener("pointerup", later, { signal })
  signal.addEventListener("abort", () => {
    observer.disconnect()
    added.disconnect()
    clearTimeout(timer)
  }, { once: true })
}

/**
 * Draws the small ViteHub mark that stays where the pill was while the tools are off. Its button turns them on again.
 * The focus moves to it after a key press on the exit button, which is gone. `stopped`: removes the mark when it
 * aborts. `from`: the height of the hexagon that the pill folded to, which the mark shrinks from.
 */
function mountOffMark(stopped: AbortSignal, turnOn: () => void, focus: boolean, from?: number): void {
  if (stopped.aborted) return
  const mark = document.createElement("vitehub-tools-off")
  mark.setAttribute("off", "")
  mark.setAttribute("collapsed", "")
  if (from) mark.setAttribute("closing", "")
  mark.style.viewTransitionName = "vitehub-pill"
  let dock = storedViteHubPageDock(dockKey) ?? { edge: "bottom", at: 50 }
  const place = () => {
    // A drag follows the pointer, even where the page asks for the mark.
    const shown = pageAsksForMark() && !mark.hasAttribute("dragging") ? asideOf(dock) : dock
    mark.setAttribute("edge", shown.edge)
    mark.style.setProperty("--at", String(shown.at))
  }
  place()
  const watching = new AbortController()
  stopped.addEventListener("abort", () => {
    watching.abort()
    mark.remove()
  }, { once: true, signal: watching.signal })
  watchPageAsk(place, watching.signal)
  const shadow = mark.attachShadow({ mode: "open" })
  const style = document.createElement("style")
  style.textContent = `${viteHubPagePillStyles}\n${offMarkStyles}`
  const button = document.createElement("button")
  button.type = "button"
  button.setAttribute("aria-label", "Turn on ViteHub tools")
  button.title = "Turn on ViteHub tools"
  button.append(viteHubPageSvgIcon("0 0 20 18", markPath, {}))
  shadow.append(style, button)
  document.documentElement.append(mark)
  if (from) {
    mark.style.setProperty("--vitehub-off-from", String(from / viteHubPageHexagonSize(mark).height))
    button.addEventListener("animationend", () => mark.removeAttribute("closing"), { once: true })
  }
  // The pill opens where the mark is dropped: both keep the same dock.
  const dragged = dragViteHubPageDock({
    host: mark,
    handle: button,
    dock: () => dock,
    shape: (side) => {
      const size = side ? mark.offsetHeight : mark.offsetWidth
      const hexagon = viteHubPageHexagonSize(mark)
      return { size, lead: size / 2, part: side ? hexagon.height : hexagon.width, margin: 2 }
    },
    place: (next) => { dock = next; place() },
    drop: () => {
      place()
      try { localStorage.setItem(dockKey, JSON.stringify(dock)) }
      catch {}
    },
    signal: watching.signal,
  })
  button.addEventListener("click", () => {
    if (dragged()) return
    watching.abort()
    mark.remove()
    turnOn()
  })
  if (focus) button.focus({ preventScroll: true })
}

export interface LoadViteHubPageToolsOptions {
  /** Imports the script of a tool. Default: a dynamic `import()`. */
  load?: (script: string) => Promise<unknown>
  /** The URL of the session route. Default: the session route next to this script, below the same app base. */
  session?: string
}

/**
 * Asks the session route which tools this visitor may use, draws the pill, then starts each tool with its segment.
 * Without an allowed tool it does nothing more: the session route already set the hint cookie to `0`. The pill remains
 * while a tool is mounted or available to launch or retry. Returns those available tools.
 */
export async function loadViteHubPageTools(options: LoadViteHubPageToolsOptions = {}): Promise<ViteHubPageToolInfo[]> {
  return await startViteHubPageTools(options, false)
}

/** Aborts when `stopViteHubPageTools()` runs. Each load keeps the signal that it started with. */
let running = new AbortController()

/**
 * Stops the pill, the tools, and the off mark of each load on this page, and removes them. Unlike the exit button, it
 * keeps the browser's choices. A page keeps its tools while it lives, so tests use it: call it before the test window
 * closes, so that no watcher of the page runs after the window is gone.
 */
export function stopViteHubPageTools(): void {
  running.abort()
  running = new AbortController()
}

/** `turnedOn`: the person pressed the off mark, so the pill opens even on a page that asks for the mark. */
async function startViteHubPageTools(options: LoadViteHubPageToolsOptions, turnedOn: boolean): Promise<ViteHubPageToolInfo[]> {
  // Vite pages load this external module under CSP; visitors without a hint make no session request.
  const query = new URLSearchParams(location.search)
  if (!viteHubPageToolsWanted(location.search, document.cookie)) return []
  const { signal: stopped } = running
  docked = storedViteHubPageDock(dockKey) !== undefined
  crowded = pageControlAtPillPlace()
  const load = options.load ?? ((script: string) => import(/* @vite-ignore */ script))
  let session: ViteHubPageSession
  try {
    const sessionUrl = new URL(options.session ?? viteHubPageSessionUrl(import.meta.url), location.href)
    sessionUrl.searchParams.set("page", location.pathname)
    const response = await fetch(sessionUrl.origin === location.origin ? `${sessionUrl.pathname}${sessionUrl.search}` : sessionUrl.href, { credentials: "same-origin", headers: { accept: "application/json" } })
    if (!response.ok) return []
    session = readViteHubPageSession(await response.json())
  }
  catch {
    return []
  }
  // One pill per page: a second loader on the same page does nothing.
  if (stopped.aborted || session.tools.length === 0 || document.querySelector("vitehub-pill, vitehub-tools-off")) return []
  const linkedTool = session.tools.find(tool => tool.param && query.has(tool.param))
  // Explicit page-tool links turn the tools on again. Otherwise, tools that were turned off show only their small mark.
  if (query.has(viteHubPageToolsQuery) || linkedTool) rememberOff(false)
  else if (storedOff()) {
    mountOffMark(stopped, () => { rememberOff(false); void startViteHubPageTools(options, true) }, false)
    return []
  }

  // `?vitehub=<tool>` opens a tool, and so does the query parameter of a tool, such as `?comment=3` of Comments.
  const open = query.get(viteHubPageToolsQuery) || linkedTool?.id
  const querySelected = session.tools.some(tool => tool.id === open)
  const pillController = new AbortController()
  const controllers = session.tools.map(() => new AbortController())
  stopped.addEventListener("abort", () => {
    for (const controller of controllers) controller.abort()
    pillController.abort()
  }, { once: true, signal: pillController.signal })
  const exitChecks = new Set<() => boolean>()
  let closing = false
  // `keyboard`: the exit button was pressed with a key, so the small mark takes the focus that the button had.
  const exit = (keyboard = false) => {
    if (closing || [...exitChecks].some(check => !check())) return
    closing = true
    const opened = session.tools.filter(tool => restored(tool.id))
    for (const tool of session.tools) remember(tool.id, false)
    // The hint cookie stays, so the next pages still ask the session route and show the mark only to people with access.
    rememberOff(true)
    const url = new URL(location.href)
    url.searchParams.delete(viteHubPageToolsQuery)
    for (const tool of session.tools) if (tool.param) url.searchParams.delete(tool.param)
    if (url.href !== location.href) history.replaceState(history.state, "", url)
    // The tools stop at once. The bar folds into its hexagon at its size, and then the small mark takes its place.
    const folded = pill.hasAttribute("collapsed") ? undefined : viteHubPageHexagonSize(pill).height
    const closed = closeViteHubPagePill(pill)
    for (const controller of controllers) controller.abort()
    void closed.then(() => {
      pillController.abort()
      mountOffMark(stopped, () => {
        rememberOff(false)
        for (const tool of opened) remember(tool.id, true)
        void startViteHubPageTools(options, true)
      }, keyboard, folded && !matchMedia("(prefers-reduced-motion: reduce)").matches ? folded : undefined)
    })
  }
  const pill = mountViteHubPagePill({
    name: "vitehub-pill",
    label: "ViteHub tools",
    mark: viteHubPageSvgIcon("0 0 20 18", markPath, { fill: "currentColor" }),
    // The account item ends the bar, before the exit button.
    slots: [...session.tools.map(tool => tool.id), ...session.account ? [accountSlot] : []],
    storage: { collapsed: collapsedKey, dock: dockKey },
    exit: { label: "Turn off ViteHub tools", press: exit },
    onPlace: dockViteHubPageWindows,
    markOnly: { active: pageAsksForMark, watch: watchPageAsk, opened: turnedOn },
    signal: pillController.signal,
  })
  if (session.account) {
    const bar = document.createElement("vitehub-account")
    bar.slot = accountSlot
    pill.append(bar)
    mountViteHubPageAccount({
      account: session.account,
      bar,
      mark: markPath,
      // The Console segment draws nothing on an origin that the Console cannot open, so the menu leaves its item out too.
      openConsole: () => {
        const segment = pill.querySelector<HTMLElement>(`vitehub-tool[slot="console"]`)
        return segment && !segment.hidden ? () => void openTool("console") : undefined
      },
      signal: pillController.signal,
    })
  }
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
    // A lazy tool's script starts to load when the pointer reaches its button or the button gets focus, so the click
    // seldom waits for the network. A failed load tries again on the next intent.
    let loading: Promise<unknown> | undefined
    const preload = () => {
      if (!loading) {
        loading = load(tool.script)
        loading.catch(() => { loading = undefined })
      }
      return loading
    }
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
          const start = startOf(await preload())
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
            open: show && (tool.lazy === true || tool.id === open || restored(tool.id)), exit: () => exit(),
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
            createTab: () => {
              const tab = document.createElement("vitehub-tab")
              tab.slot = "tab"
              pill.append(tab)
              attempt.signal.addEventListener("abort", () => tab.remove(), { once: true })
              if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
                const edge = pill.getAttribute("edge")
                const from = edge === "top" ? "0 -100%" : edge === "left" ? "-100% 0" : edge === "right" ? "100% 0" : "0 100%"
                tab.animate([{ translate: from, opacity: 0 }, { translate: "0 0", opacity: 1 }], { duration: 220, easing: "cubic-bezier(.32,.72,0,1)" })
              }
              return tab
            },
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
          // A failed tool may have attached a shadow root; retries need a fresh segment.
          replaceBar()
          launch.textContent = `Retry ${tool.label}`
          launch.title = "The tool could not load. Try again."
          bar.hidden = false
          mountLaunch()
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
    for (const intent of ["pointerenter", "pointerdown", "focus"]) launch.addEventListener(intent, () => void preload())
    activators.set(tool.id, run)
    if (tool.lazy && tool.id !== open && !restored(tool.id)) { mountLaunch(); return tool }
    // Restored tools may mount, but an explicit query selection owns the visible window. A failed start keeps a retry.
    await run(undefined, !querySelected || tool.id === open)
    return signal.aborted ? undefined : tool
  }))
  const tools = started.filter((tool): tool is ViteHubPageToolInfo => Boolean(tool))
  if (tools.length === 0) pillController.abort()
  return tools
}
