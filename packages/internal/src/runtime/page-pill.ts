/**
 * The page pill: the dark glass bar that docks to an edge of the page, collapses to the ViteHub hexagon, and moves where
 * its mark is dragged. ViteHub's page tools draw theirs with it, and `vite-hub/page/pill.js` ships it as a browser script
 * for other tools that put a bar on someone's page, such as Drop's review toolbar, so both behave the same.
 *
 * This file runs only in the browser. It imports only the shared button styles, so it bundles on its own.
 */
import { viteHubPillButtonStyles } from "./page-tools-shared.ts"

import type { ViteHubPageToolsDock, ViteHubPageToolsEdge } from "./page-tools-window.ts"

// Drop's review toolbar: dark glass with the system font on every page. The tools in its segments inherit the colors
// and the font. Space groups the buttons: 8px between segments, 2px inside one.
//
// The pill docks to an edge of the screen, like the floating frame of Nuxt and Vite DevTools: `edge` names the edge and
// `--at` the place along it, from 0 (left or top end) to 100 (right or bottom end). Expanded, the pill sits 16px from
// the edge and stays 16px inside both ends. On the left and right edges its buttons stack. Collapsed, the glass is the
// ViteHub hexagon (24px high, the mark's 20:18; 40px on touch screens), 2px from the edge, so it covers almost nothing
// of the page. The bar keeps its layout and only its clip changes, so the morph never reflows: 12 clip points go from
// the bar to the hexagon with softened corners, at the center of the bar, while the bar moves so that the hexagon lands
// on the edge. The bar's corner points cut 6px corners that stay outside the 12px border-radius, so the shape keeps
// soft corners at every frame instead of square ones that round only at the end. The shape grows from its center and
// shrinks from its ends, so the mark and the exit button at the ends of the bar fade with their own timing. Collapsing
// fades the ends out in 40ms and the tools in 80ms, and closes the shape 40ms in, so it never cuts through a label.
// Expanding shows the tools from 80ms and the ends from 120ms, when the shape has reached them.
const pillBar = "polygon(0 6px,6px 0,calc(100% - 6px) 0,100% 6px,100% 50%,100% 50%,100% calc(100% - 6px),calc(100% - 6px) 100%,6px 100%,0 calc(100% - 6px),0 50%,0 50%)"
const hexagonPoints: Array<[number, number, number, number]> = [
  [-0.235, -1.01, -1, 1.72], [-0.235, 2, -1, 0], [0.235, -2, -1, 0], [0.235, 1.01, -1, 1.72],
  [0.5, -1.01, 0, -1.72], [0.5, -1.01, 0, 1.72], [0.235, 1.01, 1, -1.72], [0.235, -2, 1, 0],
  [-0.235, 2, 1, 0], [-0.235, -1.01, 1, -1.72], [-0.5, 1.01, 0, 1.72], [-0.5, 1.01, 0, -1.72],
]
const pillHexagon = `polygon(${hexagonPoints.map(([x, dx, y, dy]) => `calc(50% + var(--vitehub-hex-w) * ${x} + ${dx}px) calc(50% + var(--vitehub-hex-h) * ${y / 2} + ${dy}px)`).join(",")})`
const along = (size: string) => `calc(var(--start) + ${size} / 2 + (100% - var(--start) - var(--end) - ${size}) * var(--at) / 100)`
/** The pill's styles. A pill of its own, such as the small mark that stays when the tools are off, can reuse them. */
export const viteHubPagePillStyles: string = `:host{all:initial;position:fixed;z-index:2147483001;pointer-events:none;filter:drop-shadow(0 8px 24px rgb(0 0 0/25%));color-scheme:dark;font:500 12px/1 ui-sans-serif,system-ui,sans-serif;color:#d4d4d4;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;--vitehub-pill-text:#d4d4d4;--vitehub-pill-strong:#fafafa;--vitehub-pill-muted:#a3a3a3;--vitehub-pill-hover:rgb(255 255 255/8%);--vitehub-pill-on:#fafafa;--vitehub-pill-on-text:#0a0a0a;--vitehub-pill-line:rgb(255 255 255/12%);--vitehub-pill-surface:#111;--vitehub-pill-flow:row;--vitehub-pill-ease:cubic-bezier(.32,.72,0,1);--vitehub-hex-h:24px;--vitehub-hex-w:calc(var(--vitehub-hex-h) * 10 / 9);--vitehub-pill-morph:280ms;--vitehub-pill-fade:opacity 160ms ease-out 80ms,visibility 0s;--vitehub-pill-fade-end:opacity 160ms ease-out 120ms,visibility 0s;--at:50;--margin:16px;--safe-top:env(safe-area-inset-top,0px);--safe-right:env(safe-area-inset-right,0px);--safe-bottom:env(safe-area-inset-bottom,0px);--safe-left:env(safe-area-inset-left,0px);transition-property:left,top,right,bottom,translate;transition-duration:var(--vitehub-pill-morph);transition-timing-function:var(--vitehub-pill-ease);transition-delay:var(--vitehub-pill-wait,0s)}
:host([collapsed]){--margin:2px;--vitehub-pill-morph:240ms;--vitehub-pill-wait:40ms;--vitehub-pill-fade:opacity 80ms ease-out,visibility 0s 80ms;--vitehub-pill-fade-end:opacity 40ms ease-out,visibility 0s 40ms}
:host(:is([edge=top],[edge=bottom])){left:${along("0px")};--start:max(var(--margin),var(--safe-left));--end:max(var(--margin),var(--safe-right));--x:calc(var(--at) * -1%)}
:host(:is([edge=left],[edge=right])){top:${along("0px")};--start:max(var(--margin),var(--safe-top));--end:max(var(--margin),var(--safe-bottom));--y:calc(var(--at) * -1%);--vitehub-pill-flow:column}
:host([edge=bottom]){bottom:max(16px,var(--safe-bottom))}
:host([edge=top]){top:max(16px,var(--safe-top))}
:host([edge=right]){right:max(16px,var(--safe-right))}
:host([edge=left]){left:max(16px,var(--safe-left))}
:host([collapsed]:is([edge=top],[edge=bottom])){left:${along("var(--vitehub-hex-w)")};--x:-50%}
:host([collapsed]:is([edge=left],[edge=right])){top:${along("var(--vitehub-hex-h)")};--y:-50%}
:host([collapsed][edge=bottom]){bottom:calc(max(2px,var(--safe-bottom)) + var(--vitehub-hex-h) / 2);--y:50%}
:host([collapsed][edge=top]){top:calc(max(2px,var(--safe-top)) + var(--vitehub-hex-h) / 2);--y:-50%}
:host([collapsed][edge=right]){right:calc(max(2px,var(--safe-right)) + var(--vitehub-hex-w) / 2);--x:50%}
:host([collapsed][edge=left]){left:calc(max(2px,var(--safe-left)) + var(--vitehub-hex-w) / 2);--x:-50%}
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
.exit{position:sticky;right:0;bottom:0;transition:background-color 150ms,color 150ms,scale 150ms,var(--vitehub-pill-fade-end)}
.mark{position:sticky;left:0;top:0;z-index:1;cursor:grab;touch-action:none}
:host([dragging]) .mark{cursor:grabbing}
.mark,.mark[aria-expanded=true]{background:none;color:var(--vitehub-pill-strong)}
@media(hover:hover){.mark:hover{background:var(--vitehub-pill-hover)}}
.mark svg{width:16px;height:16px;transition:opacity 160ms ease-out 120ms,scale 160ms ease-out 120ms}
:host([collapsed]) .mark svg{opacity:0;scale:.6;transition-duration:40ms;transition-delay:0s;transition-timing-function:ease-out}
:host([collapsed]) .mark:is(:hover,:active){background:none;scale:none}
:host([collapsed]) .mark{translate:var(--vitehub-mark-x,0) var(--vitehub-mark-y,0);transition:translate 0s 80ms}
:host([collapsed]) .mark::before{content:"";position:absolute;inset:-8px}
@media(any-pointer:coarse){:host{--vitehub-hex-h:40px}}
@media(prefers-reduced-motion:reduce){:host,div,::slotted(*),.exit,.mark svg,:host([collapsed]) .mark{transition:none}}`

/** An SVG icon with one path, hidden from assistive technology. */
export function viteHubPageSvgIcon(viewBox: string, path: string, attributes: Record<string, string>): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  for (const [name, value] of Object.entries({ viewBox, "aria-hidden": "true", ...attributes })) svg.setAttribute(name, value)
  const shape = document.createElementNS("http://www.w3.org/2000/svg", "path")
  shape.setAttribute("d", path)
  svg.append(shape)
  return svg
}

const edges: readonly ViteHubPageToolsEdge[] = ["top", "right", "bottom", "left"]

function isEdge(value: unknown): value is ViteHubPageToolsEdge {
  return edges.some(edge => edge === value)
}

/** A dock from untrusted input, such as `localStorage` or a script tag, or `undefined` when it is not one. */
export function readViteHubPageDock(value: unknown): ViteHubPageToolsDock | undefined {
  const edge: unknown = value !== null && typeof value === "object" ? Reflect.get(value, "edge") : undefined
  const at: unknown = value !== null && typeof value === "object" ? Reflect.get(value, "at") : undefined
  return isEdge(edge) && typeof at === "number" && at >= 0 && at <= 100 ? { edge, at } : undefined
}

/** The dock that `key` keeps in `localStorage`, or `undefined`. */
export function storedViteHubPageDock(key: string): ViteHubPageToolsDock | undefined {
  try { return readViteHubPageDock(JSON.parse(localStorage.getItem(key) ?? "null")) }
  catch { return undefined }
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

/** Where the pill is: its edge, its place along it, whether it is collapsed, and how far it reaches from the edge. */
export interface ViteHubPagePillPlace extends ViteHubPageToolsDock {
  collapsed: boolean
  thickness: number
}

export interface ViteHubPagePillOptions {
  /**
   * The name of the pill element. Page styles and queries find it by this name, and it names the pill's View
   * Transition, so a second kind of pill on the same page needs its own name.
   */
  name: string
  /** The accessible name of the toolbar, such as "ViteHub tools". It also names the mark: "Hide <label>". */
  label: string
  /** The icon in the mark, 16px. The mark collapses the pill to the hexagon, and dragging it moves the pill. */
  mark: SVGElement
  /** The named slots, in order: each segment is a child of the pill element with one of these `slot` names. */
  slots: readonly string[]
  /** The `localStorage` keys that keep whether the pill is collapsed and where it docks. */
  storage: { collapsed: string, dock: string }
  /** Where the pill docks, and whether it is collapsed, while the browser keeps neither. Default: the bottom middle, open. */
  initial?: { dock?: ViteHubPageToolsDock, collapsed?: boolean }
  /** A temporary request to fold to the mark without changing the browser's saved choices. */
  markOnly?: {
    active: () => boolean
    /** Calls `change` when the request changes, until `signal` aborts. */
    watch: (change: () => void, signal: AbortSignal) => void
    /** Starts open for this request, such as after turning the tools on from an off mark. */
    opened?: boolean
  }
  /** The button at the end that closes the tools. Without it the pill has none. */
  exit?: {
    label: string
    /** `keyboard`: the button was pressed with a key, so the focus should move to what replaces it. */
    press: (keyboard: boolean) => void
  }
  /** Runs when the pill docks somewhere or changes size, so windows and cards can open from it. */
  onPlace?: (place: ViteHubPagePillPlace) => void
  /** The node that holds the pill. Default: the root element, so a router that replaces the body keeps it. */
  parent?: ParentNode
  /** Removes the pill. */
  signal: AbortSignal
}

/**
 * Draws a pill docked to an edge of the page, with the mark, a named slot per segment, and the optional exit button.
 * The mark collapses the pill to itself, and dragging the mark docks the pill to another edge. The browser remembers
 * both. Returns the pill element; put each segment in it as a child with its `slot` name.
 */
export function mountViteHubPagePill(options: ViteHubPagePillOptions): HTMLElement {
  const { signal } = options
  const pill = document.createElement(options.name)
  // Its own name keeps the pill in place through a page's View Transition. In the page's snapshot it would fade and
  // slide away with the old page, under any part that the page names itself.
  pill.style.viewTransitionName = options.name
  const shadow = pill.attachShadow({ mode: "open" })
  const style = document.createElement("style")
  style.textContent = viteHubPagePillStyles
  const toolbar = document.createElement("div")
  toolbar.setAttribute("role", "toolbar")
  toolbar.setAttribute("aria-label", options.label)
  // The mark collapses the pill to itself. The tools keep running: their windows, pins, and modes stay.
  const mark = document.createElement("button")
  mark.className = "mark"
  mark.append(options.mark)
  const initiallyCollapsed = options.initial?.collapsed === true
  const collapse = (collapsed: boolean) => {
    if (collapsed) toolbar.scrollTo(0, 0)
    pill.toggleAttribute("collapsed", collapsed)
    mark.setAttribute("aria-expanded", String(!collapsed))
    mark.setAttribute("aria-label", `${collapsed ? "Show" : "Hide"} ${options.label}`)
    mark.title = `${mark.getAttribute("aria-label")!}. Drag to move.`
  }
  const markOnly = () => options.markOnly?.active() === true
  let opened = options.markOnly?.opened === true
  const folded = () => markOnly() ? !opened : storedCollapsed(options.storage.collapsed) ?? initiallyCollapsed
  collapse(folded())
  let dragged = false
  mark.addEventListener("click", () => {
    if (dragged) return
    const collapsed = !pill.hasAttribute("collapsed")
    collapse(collapsed)
    place(dock)
    if (markOnly()) {
      opened = !collapsed
      return
    }
    // The key stays only while the pill differs from its initial state, so a later change of that state applies.
    try {
      if (collapsed === initiallyCollapsed) localStorage.removeItem(options.storage.collapsed)
      else localStorage.setItem(options.storage.collapsed, collapsed ? "1" : "0")
    }
    catch {}
  })
  const exit = options.exit
  let button: HTMLButtonElement | undefined
  if (exit) {
    button = document.createElement("button")
    button.className = "exit"
    button.setAttribute("aria-label", exit.label)
    button.title = exit.label
    button.append(viteHubPageSvgIcon("0 0 24 24", "M18 6 6 18M6 6l12 12", { width: "15", height: "15", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round" }))
    // A click from Enter or Space has no pointer press, so its `detail` is 0.
    button.addEventListener("click", event => exit.press(event.detail === 0))
  }
  toolbar.append(mark, ...button ? [button] : [])
  shadow.append(style, toolbar)
  for (const name of options.slots) {
    const slot = document.createElement("slot")
    slot.name = name
    toolbar.insertBefore(slot, button ?? null)
  }
  let dock = storedViteHubPageDock(options.storage.dock) ?? options.initial?.dock ?? { edge: "bottom", at: 50 }
  let shown = dock
  const vertical = () => dock.edge === "left" || dock.edge === "right"
  const place = (next: ViteHubPageToolsDock) => {
    dock = next
    // Keep the person's dock while a temporary mark steps aside. A drag still follows the pointer.
    shown = markOnly() && !pill.hasAttribute("dragging") && next.edge === "bottom" ? { edge: "bottom", at: next.at < 50 ? 0 : 100 } : next
    pill.setAttribute("edge", shown.edge)
    pill.style.setProperty("--at", String(shown.at))
    const collapsed = pill.hasAttribute("collapsed")
    const thickness = collapsed ? vertical() ? hexagonSize(pill).width : hexagonSize(pill).height : vertical() ? toolbar.offsetWidth : toolbar.offsetHeight
    options.onPlace?.({ ...shown, collapsed, thickness })
    // Collapsed, the mark moves to the hexagon at the bar's center. It only translates, so the bar keeps its size and
    // the clip morph is not cut short by the resize animation below.
    mark.style.setProperty("--vitehub-mark-x", `${toolbar.clientWidth / 2 - mark.offsetLeft - mark.offsetWidth / 2}px`)
    mark.style.setProperty("--vitehub-mark-y", `${toolbar.clientHeight / 2 - mark.offsetTop - mark.offsetHeight / 2}px`)
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
      place(dock)
      try { localStorage.setItem(options.storage.dock, JSON.stringify({ edge: dock.edge, at: dock.at })) }
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
    parts = new Map([[mark, { x: 0, y: 0 }], ...[...pill.children, ...button ? [button] : []].map((part): [Element, { x: number, y: number }] => {
      const rect = part.getBoundingClientRect()
      return [part, { x: rect.left - origin.left, y: rect.top - origin.top }]
    })])
    box = { width: toolbar.offsetWidth, height: toolbar.offsetHeight }
  }
  if (signal.aborted) return pill
  const resized = new ResizeObserver(() => {
    const before = { parts, box }
    for (const part of [toolbar, ...before.parts.keys()]) for (const animation of part.getAnimations()) if (animation.id === "vitehub-pill-glide") animation.cancel()
    measure()
    place(dock)
    if (!before.box.width || pill.hasAttribute("collapsed") || pill.hasAttribute("dragging") || matchMedia("(prefers-reduced-motion: reduce)").matches) return
    // How far the bar's corner moved back: the size change times its place along the edge, and the whole change on the
    // right and bottom edges, where the bar grows away from the edge.
    const grown = { x: box.width - before.box.width, y: box.height - before.box.height }
    const corner = {
      x: vertical() ? shown.edge === "right" ? grown.x : 0 : grown.x * shown.at / 100,
      y: vertical() ? grown.y * shown.at / 100 : shown.edge === "bottom" ? grown.y : 0,
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
  signal.addEventListener("abort", () => {
    pill.remove()
    resized.disconnect()
  }, { once: true })
  // A router may replace the body. By default the tools stay connected as siblings of it throughout the swap.
  const parent = options.parent ?? document.documentElement
  parent.append(pill)
  place(dock)
  // The first observation only measures: the pill must not glide in when the page loads.
  // The initial placement callback can also end the owner's lifetime.
  if (!signal.aborted) {
    resized.observe(toolbar)
    options.markOnly?.watch(() => {
      opened = false
      collapse(folded())
      place(dock)
    }, signal)
  }
  return pill
}

/** The collapsed hexagon's size, from the pill's CSS. */
function hexagonSize(pill: HTMLElement): { width: number, height: number } {
  const height = Number.parseFloat(getComputedStyle(pill).getPropertyValue("--vitehub-hex-h")) || 24
  return { width: height * 10 / 9, height }
}

function storedCollapsed(key: string): boolean | undefined {
  try {
    const value = localStorage.getItem(key)
    return value === "1" ? true : value === "0" ? false : undefined
  }
  catch { return undefined }
}
