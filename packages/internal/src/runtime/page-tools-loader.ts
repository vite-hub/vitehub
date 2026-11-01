import { createViteHubPageWindow, dockViteHubPageWindows } from "./page-tools-window.ts"
import type { ViteHubPageToolsDock, ViteHubPageToolsEdge, ViteHubPageWindow, ViteHubPageWindowOptions } from "./page-tools-window.ts"
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
// The pill docks to an edge of the screen, like the floating frame of Nuxt and Vite DevTools: `edge` names the edge and
// `--at` the place along it, from 0 (left or top end) to 100 (right or bottom end). Expanded, the pill sits 16px from
// the edge and stays 16px inside both ends. On the left and right edges its buttons stack. Collapsed, the glass is the
// ViteHub hexagon (24px high, the mark's 20:18; 40px on touch screens), 2px from the edge, so it covers almost nothing
// of the page. The bar keeps its layout and only its clip changes, so the morph never reflows: 12 clip points go from
// the bar's rectangle (border-radius rounds it) to the hexagon with softened corners, at the center of the bar, while
// the bar moves so that the hexagon lands on the edge. Collapsing fades the tools out first (80ms) and closes the shape
// 40ms in, so it never cuts through a label.
const pillBar = "polygon(0 0,0 0,100% 0,100% 0,100% 50%,100% 50%,100% 100%,100% 100%,0 100%,0 100%,0 50%,0 50%)"
const hexagonPoints: Array<[number, number, number, number]> = [
  [-0.235, -1.01, -1, 1.72], [-0.235, 2, -1, 0], [0.235, -2, -1, 0], [0.235, 1.01, -1, 1.72],
  [0.5, -1.01, 0, -1.72], [0.5, -1.01, 0, 1.72], [0.235, 1.01, 1, -1.72], [0.235, -2, 1, 0],
  [-0.235, 2, 1, 0], [-0.235, -1.01, 1, -1.72], [-0.5, 1.01, 0, 1.72], [-0.5, 1.01, 0, -1.72],
]
const pillHexagon = `polygon(${hexagonPoints.map(([x, dx, y, dy]) => `calc(50% + var(--vitehub-hex-w) * ${x} + ${dx}px) calc(50% + var(--vitehub-hex-h) * ${y / 2} + ${dy}px)`).join(",")})`
const along = (size: string) => `calc(var(--start) + ${size} / 2 + (100% - var(--start) - var(--end) - ${size}) * var(--at) / 100)`
const pillStyles = `:host{all:initial;position:fixed;z-index:2147483001;pointer-events:none;filter:drop-shadow(0 8px 24px rgb(0 0 0/25%));color-scheme:dark;font:500 12px/1 ui-sans-serif,system-ui,sans-serif;color:#d4d4d4;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;--vitehub-pill-text:#d4d4d4;--vitehub-pill-strong:#fafafa;--vitehub-pill-muted:#a3a3a3;--vitehub-pill-hover:rgb(255 255 255/8%);--vitehub-pill-on:#fafafa;--vitehub-pill-on-text:#0a0a0a;--vitehub-pill-line:rgb(255 255 255/12%);--vitehub-pill-surface:#111;--vitehub-pill-flow:row;--vitehub-pill-ease:cubic-bezier(.32,.72,0,1);--vitehub-hex-h:24px;--vitehub-hex-w:calc(var(--vitehub-hex-h) * 10 / 9);--vitehub-pill-morph:320ms;--vitehub-pill-fade:opacity 180ms ease-out 80ms,visibility 0s;--at:50;--margin:16px;--safe-top:env(safe-area-inset-top,0px);--safe-right:env(safe-area-inset-right,0px);--safe-bottom:env(safe-area-inset-bottom,0px);--safe-left:env(safe-area-inset-left,0px);transition-property:left,top,right,bottom,translate;transition-duration:var(--vitehub-pill-morph);transition-timing-function:var(--vitehub-pill-ease);transition-delay:var(--vitehub-pill-wait,0s)}
:host([collapsed]){--margin:2px;--vitehub-pill-morph:240ms;--vitehub-pill-wait:40ms;--vitehub-pill-fade:opacity 80ms ease-out,visibility 0s 80ms}
:host(:is([edge=top],[edge=bottom])){left:${along("0px")};--start:max(var(--margin),var(--safe-left));--end:max(var(--margin),var(--safe-right));--x:calc(var(--at) * -1%)}
:host(:is([edge=left],[edge=right])){top:${along("0px")};--start:max(var(--margin),var(--safe-top));--end:max(var(--margin),var(--safe-bottom));--y:calc(var(--at) * -1%);--vitehub-pill-flow:column}
:host([edge=bottom]){bottom:max(16px,env(safe-area-inset-bottom))}
:host([edge=top]){top:max(16px,env(safe-area-inset-top))}
:host([edge=right]){right:max(16px,env(safe-area-inset-right))}
:host([edge=left]){left:max(16px,env(safe-area-inset-left))}
:host([collapsed]:is([edge=top],[edge=bottom])){left:${along("var(--vitehub-hex-w)")};--x:-50%}
:host([collapsed]:is([edge=left],[edge=right])){top:${along("var(--vitehub-hex-h)")};--y:-50%}
:host([collapsed][edge=bottom]){bottom:calc(max(2px,env(safe-area-inset-bottom)) + var(--vitehub-hex-h) / 2);--y:50%}
:host([collapsed][edge=top]){top:calc(max(2px,env(safe-area-inset-top)) + var(--vitehub-hex-h) / 2);--y:-50%}
:host([collapsed][edge=right]){right:calc(max(2px,env(safe-area-inset-right)) + var(--vitehub-hex-w) / 2);--x:50%}
:host([collapsed][edge=left]){left:calc(max(2px,env(safe-area-inset-left)) + var(--vitehub-hex-w) / 2);--x:-50%}
:host{translate:var(--x,0) var(--y,0)}
:host([dragging]){transition:none;cursor:grabbing;user-select:none;-webkit-user-select:none}
div{position:relative;box-sizing:border-box;max-width:calc(100vw - 32px);max-height:calc(100dvh - 32px);overflow:auto;scrollbar-width:none;display:flex;flex-direction:var(--vitehub-pill-flow);align-items:center;gap:8px;padding:4px;border:1px solid var(--vitehub-pill-line);border-radius:12px;background:rgb(17 17 17/92%);pointer-events:auto;clip-path:${pillBar};transition:clip-path var(--vitehub-pill-morph) var(--vitehub-pill-ease) var(--vitehub-pill-wait,0s),background-color 150ms ease-out,scale 150ms ease-out}
:host(:is([edge=left],[edge=right])) div{align-items:stretch}
:host([collapsed]) div{clip-path:${pillHexagon}}
@media(hover:hover){:host([collapsed]) div:hover{background:rgb(38 38 38/94%)}}
:host([collapsed]) div:active{scale:.96}
:host([dragging]) div{transition:none;scale:none}
::slotted(*){flex-shrink:0;display:flex;flex-direction:var(--vitehub-pill-flow);align-items:center;gap:2px;transition:var(--vitehub-pill-fade)}
:host(:is([edge=left],[edge=right])) ::slotted(*){align-items:stretch}
::slotted([hidden]){display:none!important}
:host([collapsed]) ::slotted(*),:host([collapsed]) .exit{opacity:0;visibility:hidden}
${viteHubPillButtonStyles}
button{flex-shrink:0;padding:0}
.exit{position:sticky;right:0;bottom:0;transition:background-color 150ms,color 150ms,scale 150ms,var(--vitehub-pill-fade)}
.mark{position:sticky;left:0;top:0;z-index:1;cursor:grab;touch-action:none}
:host([dragging]) .mark{cursor:grabbing}
.mark,.mark[aria-expanded=true]{background:none;color:var(--vitehub-pill-strong)}
@media(hover:hover){.mark:hover{background:var(--vitehub-pill-hover)}}
.mark svg{width:16px;height:16px;transition:opacity 180ms ease-out 80ms,scale 180ms ease-out 80ms}
:host([collapsed]) .mark svg{opacity:0;scale:.6;transition-duration:80ms;transition-delay:0s;transition-timing-function:ease-out}
:host([collapsed]) .mark:is(:hover,:active){background:none;scale:none}
:host([collapsed]) .mark{position:absolute;left:50%;top:50%;translate:-50% -50%;transition:position 0s 80ms allow-discrete,left 0s 80ms,top 0s 80ms,translate 0s 80ms}
:host([collapsed]) .mark::before{content:"";position:absolute;inset:-8px}
@media(any-pointer:coarse){:host{--vitehub-hex-h:40px}}
@media(prefers-reduced-motion:reduce){:host,div,::slotted(*),.exit,.mark svg{transition:none}}`

/** The key in `localStorage` that keeps the pill collapsed to the ViteHub mark, on this page and the next ones. */
const collapsedKey = "vitehub-tools-collapsed"
/** The key in `localStorage` that keeps the edge and the place where the pill docks. */
const dockKey = "vitehub-tools-dock"
const edges: readonly ViteHubPageToolsEdge[] = ["top", "right", "bottom", "left"]

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

function isEdge(value: unknown): value is ViteHubPageToolsEdge {
  return edges.some(edge => edge === value)
}

function storedDock(): ViteHubPageToolsDock {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(dockKey) ?? "null")
    const edge: unknown = saved !== null && typeof saved === "object" ? Reflect.get(saved, "edge") : undefined
    const at: unknown = saved !== null && typeof saved === "object" ? Reflect.get(saved, "at") : undefined
    if (isEdge(edge) && typeof at === "number" && at >= 0 && at <= 100) return { edge, at }
  }
  catch {}
  return { edge: "bottom", at: 50 }
}

/**
 * The edge that a point is closest to, like the DevTools frame: the screen splits into four parts from its center to
 * points 70px inside its corners, so the top and bottom parts are a little wider.
 */
export function viteHubPageToolsEdgeAt(x: number, y: number, width: number, height: number): ViteHubPageToolsEdge {
  const zone = Math.min(70, height / 4)
  const angle = Math.atan2(y - height / 2, x - width / 2)
  const topLeft = Math.atan2(zone - height / 2, -width / 2)
  const topRight = Math.atan2(zone - height / 2, width / 2)
  const bottomRight = Math.atan2(height / 2 - zone, width / 2)
  const bottomLeft = Math.atan2(height / 2 - zone, -width / 2)
  if (angle >= topLeft && angle <= topRight) return "top"
  if (angle > topRight && angle < bottomRight) return "right"
  if (angle >= bottomRight && angle <= bottomLeft) return "bottom"
  return "left"
}

/**
 * The place along an edge, from 0 to 100, that puts a part of `size` pixels with its center at `center`, when the part
 * stays inside the safe `start` and `end` margins of a `length` edge. It snaps to the ends and to the middle.
 */
function placeAlong(center: number, size: number, start: number, end: number, length: number): number {
  const free = length - start - end - size
  const at = free > 0 ? Math.min(100, Math.max(0, (center - start - size / 2) / free * 100)) : 50
  return at < 2 ? 0 : at > 98 ? 100 : Math.abs(at - 50) < 3 ? 50 : Math.round(at * 10) / 10
}

/**
 * Draws the pill: one `<vitehub-pill>` docked to an edge of the page, with the ViteHub mark, a named slot per tool in
 * session order, and the exit button. The mark collapses the pill to itself, and dragging the mark docks the pill to
 * another edge. The browser remembers both.
 */
function mountPill(tools: ViteHubPageToolInfo[], exit: () => void, signal: AbortSignal): HTMLElement {
  const pill = document.createElement("vitehub-pill")
  // Its own name keeps the pill in place through a page's View Transition. In the page's snapshot it would fade and
  // slide away with the old page, under any part that the page names itself.
  pill.style.viewTransitionName = "vitehub-pill"
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
    if (collapsed) toolbar.scrollTo(0, 0)
    pill.toggleAttribute("collapsed", collapsed)
    mark.setAttribute("aria-expanded", String(!collapsed))
    mark.setAttribute("aria-label", collapsed ? "Show ViteHub tools" : "Hide ViteHub tools")
    mark.title = `${mark.getAttribute("aria-label")!}. Drag to move.`
  }
  collapse(storedCollapsed())
  let dragged = false
  mark.addEventListener("click", () => {
    if (dragged) return
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

  let dock = storedDock()
  const vertical = () => dock.edge === "left" || dock.edge === "right"
  const place = (next: ViteHubPageToolsDock) => {
    dock = next
    pill.setAttribute("edge", next.edge)
    pill.style.setProperty("--at", String(next.at))
    dockViteHubPageWindows({ ...next, thickness: vertical() ? toolbar.offsetWidth : toolbar.offsetHeight })
  }
  // Dragging the mark docks the pill to the edge under the pointer and keeps the mark under it. A press that moves less
  // than 4px is a click.
  mark.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return
    dragged = false
    const markBox = mark.getBoundingClientRect()
    const grip = { x: event.clientX - markBox.left - markBox.width / 2, y: event.clientY - markBox.top - markBox.height / 2 }
    mark.setPointerCapture(event.pointerId)
    const move = (moved: PointerEvent) => {
      if (!dragged && Math.hypot(moved.clientX - event.clientX, moved.clientY - event.clientY) < 4) return
      dragged = true
      pill.setAttribute("dragging", "")
      const width = document.documentElement.clientWidth
      const height = document.documentElement.clientHeight
      const x = moved.clientX - grip.x
      const y = moved.clientY - grip.y
      const edge = viteHubPageToolsEdgeAt(x, y, width, height)
      if (edge !== dock.edge) place({ edge, at: dock.at })
      const side = edge === "left" || edge === "right"
      const collapsed = pill.hasAttribute("collapsed")
      // Expanded, the mark leads the bar; collapsed, the mark is the hexagon at the bar's center.
      const size = collapsed ? side ? pill.offsetHeight : pill.offsetWidth : side ? toolbar.offsetHeight : toolbar.offsetWidth
      const lead = collapsed ? size / 2 : side ? mark.offsetTop + mark.offsetHeight / 2 : mark.offsetLeft + mark.offsetWidth / 2
      const hexagon = collapsed ? side ? hexagonSize(pill).height : hexagonSize(pill).width : size
      const center = (side ? y : x) - lead + size / 2
      // Use the same asymmetric safe margins as CSS, so a drag keeps its place on devices with cutouts.
      const computed = getComputedStyle(pill)
      const margin = collapsed ? 2 : 16
      const start = Math.max(margin, Number.parseFloat(computed.getPropertyValue(side ? "--safe-top" : "--safe-left")) || 0)
      const end = Math.max(margin, Number.parseFloat(computed.getPropertyValue(side ? "--safe-bottom" : "--safe-right")) || 0)
      place({ edge, at: placeAlong(center, hexagon, start, end, side ? height : width) })
    }
    mark.addEventListener("pointermove", move)
    mark.addEventListener("lostpointercapture", () => {
      mark.removeEventListener("pointermove", move)
      if (!dragged) return
      pill.removeAttribute("dragging")
      try { localStorage.setItem(dockKey, JSON.stringify({ edge: dock.edge, at: dock.at })) }
      catch {}
      // The click that ends the drag comes first, so a later key press on the mark still toggles the pill.
      setTimeout(() => { dragged = false })
    }, { once: true })
  })

  // A segment that grows or shrinks, such as a tool that draws more buttons once it loads, would move every other
  // button at once. Each button glides from its old place instead, and the glass grows out of its old outline. Only
  // transforms and the clip animate, so the page sees no layout shift.
  let parts = new Map<Element, { x: number, y: number }>()
  let box = { width: 0, height: 0 }
  const measure = () => {
    const origin = toolbar.getBoundingClientRect()
    // The mark always leads the bar when it is expanded. Collapsed, it moves to the center, which is no place to glide from.
    parts = new Map([[mark, { x: 0, y: 0 }], ...[...pill.children, button].map((part): [Element, { x: number, y: number }] => {
      const rect = part.getBoundingClientRect()
      return [part, { x: rect.left - origin.left, y: rect.top - origin.top }]
    })])
    box = { width: toolbar.offsetWidth, height: toolbar.offsetHeight }
  }
  const resized = new ResizeObserver(() => {
    const before = { parts, box }
    for (const animation of toolbar.getAnimations({ subtree: false })) animation.cancel()
    for (const part of before.parts.keys()) for (const animation of part.getAnimations()) if (animation.id === "vitehub-pill-glide") animation.cancel()
    measure()
    place(dock)
    if (!before.box.width || pill.hasAttribute("collapsed") || pill.hasAttribute("dragging") || matchMedia("(prefers-reduced-motion: reduce)").matches) return
    // How far the bar's corner moved back: the size change times its place along the edge, and the whole change on the
    // right and bottom edges, where the bar grows away from the edge.
    const grown = { x: box.width - before.box.width, y: box.height - before.box.height }
    const corner = {
      x: vertical() ? dock.edge === "right" ? grown.x : 0 : grown.x * dock.at / 100,
      y: vertical() ? grown.y * dock.at / 100 : dock.edge === "bottom" ? grown.y : 0,
    }
    const timing = { duration: 250, easing: "cubic-bezier(.32,.72,0,1)", id: "vitehub-pill-glide" }
    for (const [part, now] of parts) {
      const then = before.parts.get(part)
      if (!then) continue
      const x = then.x + corner.x - now.x
      const y = then.y + corner.y - now.y
      if (Math.abs(x) > .5 || Math.abs(y) > .5) part.animate([{ translate: `${x}px ${y}px` }, { translate: "0 0" }], timing)
    }
    const top = Math.max(0, corner.y)
    const left = Math.max(0, corner.x)
    const right = Math.max(0, grown.x - corner.x)
    const bottom = Math.max(0, grown.y - corner.y)
    if (top || left || right || bottom) toolbar.animate([{ clipPath: `inset(${top}px ${right}px ${bottom}px ${left}px round 12px)` }, { clipPath: "inset(0 round 12px)" }], timing)
  })
  // A router may replace the body. Keep the tools connected as siblings of it throughout the swap.
  document.documentElement.append(pill)
  place(dock)
  // The first observation only measures: the pill must not glide in when the page loads.
  resized.observe(toolbar)
  signal.addEventListener("abort", () => resized.disconnect(), { once: true })
  return pill
}

/** The collapsed hexagon's size, from the pill's CSS. */
function hexagonSize(pill: HTMLElement): { width: number, height: number } {
  const height = Number.parseFloat(getComputedStyle(pill).getPropertyValue("--vitehub-hex-h")) || 24
  return { width: height * 10 / 9, height }
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
    for (const intent of ["pointerenter", "pointerdown", "focus"]) launch.addEventListener(intent, () => void preload())
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
