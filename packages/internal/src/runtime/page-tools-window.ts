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
}

const styles = `
:host{all:initial;--surface:light-dark(#fff,#000);--text:light-dark(#18181b,#fafafa);--muted:light-dark(#52525b,#a1a1aa);--line:light-dark(#d4d4d8,#3f3f46);--hover:light-dark(#f4f4f5,#27272a);--focus:#3b82f6;position:fixed;inset:0;z-index:2147483000;pointer-events:none;color:var(--text);font:400 .875rem/1.5 system-ui,sans-serif;color-scheme:light dark}
:host([hidden]){display:none}
.window{position:absolute;right:16px;bottom:76px;width:min(600px,calc(100vw - 32px));height:min(640px,calc(100dvh - 100px));min-width:300px;min-height:240px;max-width:calc(100vw - 32px);max-height:calc(100dvh - 100px);display:flex;flex-direction:column;overflow:hidden;resize:both;pointer-events:auto;background:var(--surface);border:1px solid var(--line);border-radius:12px;box-shadow:0 8px 32px #0002}
.window.expanded{inset:12px 12px 76px;width:auto!important;height:auto!important;max-width:none;max-height:none;resize:none}
header{display:flex;align-items:center;gap:4px;min-height:44px;padding:0 8px;border-bottom:1px solid var(--line);flex:none}
h2{font:600 .875rem/1.5 system-ui,sans-serif;margin:0;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 8px}
button{display:grid;place-items:center;width:36px;height:36px;border:0;border-radius:6px;background:transparent;color:var(--muted);cursor:pointer;font:inherit}
button:hover{background:var(--hover);color:var(--text)}
button:focus-visible{outline:2px solid var(--focus);outline-offset:-2px}
.body{flex:1;min-height:0;overflow:auto;position:relative}iframe{display:block;border:0;width:100%;height:100%;background:var(--surface)}
@media(max-width:640px){.window,.window.expanded{inset:0 0 68px;width:auto!important;height:auto!important;max-width:none;max-height:none;min-width:0;min-height:0;border-radius:0;resize:none}button{width:44px;height:44px}.expand{display:none}}
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
  panel.append(header, body)
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
    const { width, height } = panel.getBoundingClientRect()
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
      host.style.colorScheme = getComputedStyle(options.trigger).colorScheme
      host.hidden = false
      options.trigger.setAttribute("aria-expanded", "true")
      hideButton.focus({ preventScroll: true })
    },
    hide,
    destroy,
  }
}
