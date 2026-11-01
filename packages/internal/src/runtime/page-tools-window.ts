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

// The window docks above the pill like Drop's review dock: centered, 8px over the pill's top edge, and it grows out of
// the pill when it opens. The pill is 38px tall, or 54px with 44px touch buttons.
const styles = `
:host{all:initial;--surface:light-dark(#fff,#0a0a0a);--text:light-dark(#18181b,#fafafa);--muted:light-dark(#71717a,#a1a1aa);--line:light-dark(rgb(0 0 0/8%),rgb(255 255 255/9%));--hover:light-dark(rgb(0 0 0/5%),rgb(255 255 255/7%));--focus:light-dark(#18181b,#fafafa);--dock:calc(max(16px,env(safe-area-inset-bottom)) + 46px);position:fixed;inset:0;z-index:2147483000;pointer-events:none;color:var(--text);font:400 .875rem/1.5 system-ui,sans-serif;color-scheme:light dark;transition:display 150ms allow-discrete}
@media(any-pointer:coarse){:host{--dock:calc(max(16px,env(safe-area-inset-bottom)) + 62px)}.grip{display:none}}
:host([hidden]){display:none}
.window{position:absolute;left:50%;bottom:var(--dock);translate:-50% 0;width:min(600px,calc(100vw - 32px));height:min(640px,calc(100dvh - var(--dock) - 16px));min-width:300px;min-height:240px;max-width:calc(100vw - 32px);max-height:calc(100dvh - var(--dock) - 16px);display:flex;flex-direction:column;pointer-events:auto;background:var(--surface);border-radius:12px;box-shadow:0 0 0 1px light-dark(rgb(0 0 0/8%),rgb(255 255 255/10%)),0 2px 4px light-dark(rgb(0 0 0/4%),rgb(0 0 0/24%)),0 16px 40px -8px light-dark(rgb(0 0 0/18%),rgb(0 0 0/56%));outline:none;transform-origin:50% 100%;transition:opacity 200ms cubic-bezier(.23,1,.32,1),scale 200ms cubic-bezier(.23,1,.32,1)}
@starting-style{.window{opacity:0;scale:.96}}
:host([hidden]) .window{opacity:0;scale:.96;transition-duration:150ms;transition-timing-function:ease-in}
.window.expanded{left:12px;right:12px;top:12px;translate:none;width:auto!important;height:auto!important;max-width:none;max-height:none}
.frame{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden;border-radius:inherit}
.grip{position:absolute;z-index:1;touch-action:none}
.grip.top{left:12px;right:12px;top:-4px;height:8px;cursor:ns-resize}
.grip.left,.grip.right{top:12px;bottom:12px;width:8px;cursor:ew-resize}
.grip.left{left:-4px}.grip.right{right:-4px}
.expanded .grip{display:none}
header{display:flex;align-items:center;gap:2px;min-height:44px;padding:0 6px 0 8px;border-bottom:1px solid var(--line);flex:none}
h2{font:600 .875rem/1.5 system-ui,sans-serif;margin:0;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 8px}
button{display:grid;place-items:center;width:32px;height:32px;border:0;border-radius:8px;background:transparent;color:var(--muted);cursor:pointer;font:inherit;transition:background-color 150ms ease-out,color 150ms ease-out}
@media(hover:hover){button:hover{background:var(--hover);color:var(--text)}}
button:focus-visible{outline:2px solid var(--focus);outline-offset:-2px}
.body{flex:1;min-height:0;overflow:auto;position:relative}iframe{display:block;border:0;width:100%;height:100%;background:var(--surface)}
@media(max-width:640px){.window,.window.expanded{left:0;right:0;top:0;translate:none;width:auto!important;height:auto!important;max-width:none;max-height:none;min-width:0;min-height:0;border-radius:0}.grip{display:none}button{width:44px;height:44px}.expand{display:none}}
@media(prefers-reduced-motion:reduce){:host,.window{transition:none}}
@media(forced-colors:active){.window{border:1px solid CanvasText}button:focus-visible{outline-color:Highlight}}
`

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
  // Grips on the top and side edges: the window stays docked on the pill, so it grows up, and evenly to both sides.
  const grips = (["top", "left", "right"] as const).map((side) => {
    const grip = document.createElement("div")
    grip.className = `grip ${side}`
    grip.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      grip.setPointerCapture(event.pointerId)
      const start = { width: panel.offsetWidth, height: panel.offsetHeight }
      const move = (moved: PointerEvent) => {
        if (side === "top") panel.style.height = `${Math.max(240, start.height + event.clientY - moved.clientY)}px`
        else panel.style.width = `${Math.max(300, start.width + 2 * (side === "left" ? event.clientX - moved.clientX : moved.clientX - event.clientX))}px`
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
  const destroy = () => { resize.disconnect(); host.remove() }
  if (options.signal.aborted) destroy()
  else {
    options.signal.addEventListener("abort", destroy, { once: true })
    document.body.append(host)
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
