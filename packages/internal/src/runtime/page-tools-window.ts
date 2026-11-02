export interface ViteHubPageWindow {
  body: HTMLElement
  show(): void
  hide(): void
  destroy(): void
}

export interface ViteHubPageWindowOptions {
  id: string
  title: string
  trigger: HTMLElement
  signal: AbortSignal
  onHide?: () => void
  /**
   * The color scheme of what the window shows, such as an app with its own appearance setting. The header and the
   * loading state take it, so the frame and its content read as one surface. Without it, the window follows the system.
   */
  colorScheme?: () => "light" | "dark" | undefined
}

/** The screen edge that the pill docks to. */
export type ViteHubPageToolsEdge = "top" | "right" | "bottom" | "left"

/**
 * Where the pill docks, so windows open from it. `at` is the place along the edge, from 0 (the left or top end) to 100
 * (the right or bottom end): the pill and its windows move with it and stay inside the screen. `thickness` is the
 * visible pill's size across the edge, in pixels. `collapsed` selects the hexagon's 2px edge margin.
 */
export interface ViteHubPageToolsDock {
  edge: ViteHubPageToolsEdge
  at: number
  thickness?: number
  collapsed?: boolean
}

// The window docks to the pill like Drop's review dock: 8px from the pill, on the screen side of it, and it grows out of
// the pill when it opens. Along the edge it takes the pill's place, so a pill at the left end opens its window at the
// left end. The pill is 38px thick, or 54px with 44px touch buttons, until the loader reports its real thickness.
const styles = `
:host{all:initial;--surface:light-dark(#fff,#0a0a0a);--text:light-dark(#18181b,#fafafa);--muted:light-dark(#71717a,#a1a1aa);--line:light-dark(rgb(0 0 0/8%),rgb(255 255 255/9%));--hover:light-dark(rgb(0 0 0/5%),rgb(255 255 255/7%));--focus:light-dark(#18181b,#fafafa);--safe-top:env(safe-area-inset-top,0px);--safe-right:env(safe-area-inset-right,0px);--safe-bottom:env(safe-area-inset-bottom,0px);--safe-left:env(safe-area-inset-left,0px);--at:50;--margin:16px;--start:max(var(--margin),var(--safe-left));--end:max(var(--margin),var(--safe-right));--far:max(16px,var(--safe-top));--along:calc(var(--start) + (100% - var(--start) - var(--end)) * var(--at) / 100);--shift:calc(var(--at) * -1%);--dock:calc(max(var(--margin),var(--safe-bottom)) + var(--thickness,38px) + 8px);--width:calc(100vw - var(--start) - var(--end));--height:calc(100dvh - var(--dock) - var(--far));position:fixed;inset:0;z-index:2147483000;pointer-events:none;color:var(--text);font:400 .875rem/1.5 system-ui,sans-serif;color-scheme:light dark;transition:display 150ms allow-discrete}
:host([collapsed]){--margin:2px}
:host([edge=top]){--dock:calc(max(var(--margin),var(--safe-top)) + var(--thickness,38px) + 8px);--far:max(16px,var(--safe-bottom))}
:host(:is([edge=left],[edge=right])){--start:max(var(--margin),var(--safe-top));--end:max(var(--margin),var(--safe-bottom));--width:calc(100vw - var(--dock) - var(--far));--height:calc(100dvh - var(--start) - var(--end))}
:host([edge=right]){--dock:calc(max(var(--margin),var(--safe-right)) + var(--thickness,38px) + 8px);--far:max(16px,var(--safe-left))}
:host([edge=left]){--dock:calc(max(var(--margin),var(--safe-left)) + var(--thickness,38px) + 8px);--far:max(16px,var(--safe-right))}
@media(any-pointer:coarse){:host{--thickness:54px}.grip{display:none}}
:host([hidden]){display:none}
.window{position:absolute;width:min(600px,var(--width));height:min(640px,var(--height));min-width:min(300px,var(--width));min-height:min(240px,var(--height));max-width:var(--width);max-height:var(--height);display:flex;flex-direction:column;pointer-events:auto;background:var(--surface);border-radius:12px;box-shadow:0 0 0 1px light-dark(rgb(0 0 0/8%),rgb(255 255 255/10%)),0 2px 4px light-dark(rgb(0 0 0/4%),rgb(0 0 0/24%)),0 16px 40px -8px light-dark(rgb(0 0 0/18%),rgb(0 0 0/56%));outline:none;transition:opacity 200ms cubic-bezier(.23,1,.32,1),scale 200ms cubic-bezier(.23,1,.32,1)}
:host([edge=bottom]) .window{bottom:var(--dock);left:var(--along);translate:var(--shift) 0;transform-origin:calc(var(--at) * 1%) 100%}
:host([edge=top]) .window{top:var(--dock);left:var(--along);translate:var(--shift) 0;transform-origin:calc(var(--at) * 1%) 0}
:host([edge=right]) .window{right:var(--dock);top:var(--along);translate:0 var(--shift);transform-origin:100% calc(var(--at) * 1%)}
:host([edge=left]) .window{left:var(--dock);top:var(--along);translate:0 var(--shift);transform-origin:0 calc(var(--at) * 1%)}
@starting-style{.window{opacity:0;scale:.96}}
:host([hidden]) .window{opacity:0;scale:.96;transition-duration:150ms;transition-timing-function:ease-in}
:host([edge]) .window.expanded{inset:max(12px,var(--safe-top)) max(12px,var(--safe-right)) max(12px,var(--safe-bottom)) max(12px,var(--safe-left));translate:none;width:auto!important;height:auto!important;max-width:none;max-height:none}
:host([edge=bottom]) .window.expanded{bottom:var(--dock)}:host([edge=top]) .window.expanded{top:var(--dock)}:host([edge=right]) .window.expanded{right:var(--dock)}:host([edge=left]) .window.expanded{left:var(--dock)}
.frame{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden;border-radius:inherit}
.grip{position:absolute;z-index:1;touch-action:none}
.grip.top,.grip.bottom{left:12px;right:12px;height:8px;cursor:ns-resize}
.grip.top{top:-4px}.grip.bottom{bottom:-4px}
.grip.left,.grip.right{top:12px;bottom:12px;width:8px;cursor:ew-resize}
.grip.left{left:-4px}.grip.right{right:-4px}
:host([edge=bottom]) .grip.bottom,:host([edge=top]) .grip.top,:host([edge=right]) .grip.right,:host([edge=left]) .grip.left,.expanded .grip{display:none}
header{display:flex;align-items:center;gap:2px;min-height:44px;padding:0 6px 0 8px;border-bottom:1px solid var(--line);flex:none}
h2{font:600 .875rem/1.5 system-ui,sans-serif;margin:0;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 8px}
button{display:grid;place-items:center;width:32px;height:32px;border:0;border-radius:8px;background:transparent;color:var(--muted);cursor:pointer;font:inherit;transition:background-color 150ms ease-out,color 150ms ease-out}
@media(hover:hover){button:hover{background:var(--hover);color:var(--text)}}
button:focus-visible{outline:2px solid var(--focus);outline-offset:-2px}
.body{flex:1;min-height:0;overflow:auto;position:relative}iframe{display:block;border:0;width:100%;height:100%;background:var(--surface)}
@media(max-width:640px){:host([edge]) .window,:host([edge]) .window.expanded{inset:var(--safe-top) var(--safe-right) var(--safe-bottom) var(--safe-left);translate:none;width:auto!important;height:auto!important;max-width:none;max-height:none;min-width:0;min-height:0;border-radius:0}:host([edge=bottom]) :is(.window,.window.expanded){bottom:var(--dock)}:host([edge=top]) :is(.window,.window.expanded){top:var(--dock)}:host([edge=right]) :is(.window,.window.expanded){right:var(--dock)}:host([edge=left]) :is(.window,.window.expanded){left:var(--dock)}:host(:is([edge=top],[edge=bottom])) .window:not(.expanded){left:var(--start);right:var(--end)}:host(:is([edge=left],[edge=right])) .window:not(.expanded){top:var(--start);bottom:var(--end)}.grip{display:none}button{width:44px;height:44px}.expand{display:none}}
@media(prefers-reduced-motion:reduce){:host,.window{transition:none}}
@media(forced-colors:active){.window{border:1px solid CanvasText}button:focus-visible{outline-color:Highlight}}
`

let dock: ViteHubPageToolsDock = { edge: "bottom", at: 50 }
const hosts = new Set<HTMLElement>()
let names = 0

function placeHost(host: HTMLElement) {
  host.setAttribute("edge", dock.edge)
  host.toggleAttribute("collapsed", Boolean(dock.collapsed))
  host.style.setProperty("--at", String(dock.at))
  if (dock.thickness) host.style.setProperty("--thickness", `${dock.thickness}px`)
  else host.style.removeProperty("--thickness")
  for (const side of ["top", "right", "bottom", "left"] as const) {
    host.shadowRoot!.querySelector<HTMLElement>(`.grip.${side}`)!.hidden = resizeShare(side) === 0
  }
}

function resizeShare(side: ViteHubPageToolsEdge): number {
  const vertical = side === "top" || side === "bottom"
  const far = vertical === (dock.edge === "top" || dock.edge === "bottom")
  return far ? 1 : side === "top" || side === "left" ? dock.at / 100 : 1 - dock.at / 100
}

/** Moves every window, open or hidden, to where the pill docks. The loader calls it when the pill moves. */
export function dockViteHubPageWindows(next: ViteHubPageToolsDock): void {
  dock = next
  for (const host of hosts) placeHost(host)
}

function icon(data: string): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  for (const [name, value] of Object.entries({ width: "16", height: "16", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.75", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(name, value)
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path")
  path.setAttribute("d", data)
  svg.append(path)
  return svg
}

/** A retained window: hiding and resizing never unmount its editor. */
export function createViteHubPageWindow(options: ViteHubPageWindowOptions): ViteHubPageWindow {
  const host = document.createElement("vitehub-window")
  host.hidden = true
  const shadow = host.attachShadow({ mode: "open" })
  const style = document.createElement("style")
  style.textContent = styles
  const panel = document.createElement("section")
  panel.className = "window"
  panel.setAttribute("role", "dialog")
  panel.setAttribute("aria-labelledby", "title")
  panel.tabIndex = -1
  const header = document.createElement("header")
  const title = document.createElement("h2")
  title.id = "title"
  title.textContent = options.title
  const body = document.createElement("div")
  body.className = "body"
  const control = (name: string, label: string, path: string) => {
    const button = document.createElement("button")
    button.className = name
    button.type = "button"
    button.setAttribute("aria-label", label)
    button.title = label
    button.append(icon(path))
    return button
  }
  const expand = control("expand", "Expand window", "M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5")
  const hideButton = control("hide", "Minimize window", "M5 12h14")
  header.append(title, expand, hideButton)
  const frame = document.createElement("div")
  frame.className = "frame"
  frame.append(header, body)
  // Grips on every side but the pill's: the window stays docked on the pill. The far grip moves only its own side. A
  // side grip grows the window around its place along the edge, so the grabbed side follows the pointer.
  const grips = (["top", "right", "bottom", "left"] as const).map((side) => {
    const grip = document.createElement("div")
    grip.className = `grip ${side}`
    grip.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return
      const share = resizeShare(side)
      if (share === 0) return
      event.preventDefault()
      grip.setPointerCapture(event.pointerId)
      const vertical = side === "top" || side === "bottom"
      const start = vertical ? panel.offsetHeight : panel.offsetWidth
      const move = (moved: PointerEvent) => {
        const delta = vertical ? moved.clientY - event.clientY : moved.clientX - event.clientX
        const size = start + (side === "top" || side === "left" ? -delta : delta) / share
        if (vertical) panel.style.height = `${Math.max(240, size)}px`
        else panel.style.width = `${Math.max(300, size)}px`
      }
      grip.addEventListener("pointermove", move)
      grip.addEventListener("lostpointercapture", () => grip.removeEventListener("pointermove", move), { once: true })
    })
    return grip
  })
  panel.append(frame, ...grips)
  shadow.append(style, panel)
  const key = `vitehub-window:${options.id}`
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) ?? "null")
    if (saved && typeof saved === "object" && "width" in saved && "height" in saved && typeof saved.width === "number" && typeof saved.height === "number") {
      if (Number.isFinite(saved.width)) panel.style.width = `${Math.max(300, saved.width)}px`
      if (Number.isFinite(saved.height)) panel.style.height = `${Math.max(240, saved.height)}px`
    }
  }
  catch { /* Storage may be disabled. The default size still works. */ }
  const resize = new ResizeObserver(() => {
    if (host.hidden || panel.classList.contains("expanded") || innerWidth <= 640) return
    // The opening scale changes visual bounds, but restored sizes must keep the untransformed layout dimensions.
    const width = panel.offsetWidth
    const height = panel.offsetHeight
    try { localStorage.setItem(key, JSON.stringify({ width, height })) } catch {}
  })
  resize.observe(panel)
  const hide = () => {
    host.hidden = true
    options.trigger.setAttribute("aria-expanded", "false")
    options.trigger.focus({ preventScroll: true })
    options.onHide?.()
  }
  expand.addEventListener("click", () => {
    const expanded = panel.classList.toggle("expanded")
    expand.setAttribute("aria-label", expanded ? "Restore window size" : "Expand window")
    expand.title = expanded ? "Restore window size" : "Expand window"
    expand.setAttribute("aria-pressed", String(expanded))
  })
  hideButton.addEventListener("click", hide)
  // The content may change its appearance while the window is open; same-origin pages report it as a storage change.
  if (options.colorScheme) addEventListener("storage", () => { host.style.colorScheme = options.colorScheme?.() ?? "" }, { signal: options.signal })
  shadow.addEventListener("keydown", event => {
    if (event instanceof KeyboardEvent && event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault()
      event.stopPropagation()
      hide()
    }
  })
  // Each window has its own name, so a page's View Transition leaves it in place instead of fading it with the page.
  host.style.viewTransitionName = `vitehub-window-${++names}`
  placeHost(host)
  const destroy = () => { hosts.delete(host); resize.disconnect(); host.remove() }
  if (options.signal.aborted) destroy()
  else {
    options.signal.addEventListener("abort", destroy, { once: true })
    hosts.add(host)
    // Stay outside the router's replaceable body from the first mount. Reattaching a detached iframe would reload
    // its editor and lose unsaved drafts, even if its DOM host were restored immediately after the swap.
    document.documentElement.append(host)
  }
  return {
    body,
    show() {
      if (options.signal.aborted) return
      host.style.colorScheme = options.colorScheme?.() ?? ""
      host.hidden = false
      options.trigger.setAttribute("aria-expanded", "true")
      // Focus moves into the window, not onto a control: a restored window would otherwise ring its first button.
      panel.focus({ preventScroll: true })
    },
    hide,
    destroy,
  }
}
