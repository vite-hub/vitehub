import { contentFieldAttribute, parseContentField } from "@vite-hub/content/client"
import type { ViteHubPageToolModule } from "@vite-hub/internal/runtime/page-tools-loader"

const styles = `:host{display:flex}button{display:inline-flex;align-items:center;gap:6px;min-height:36px;padding:0 12px;border:0;border-radius:999px;background:transparent;color:inherit;font:500 .875rem/1.5 system-ui,sans-serif;white-space:nowrap;cursor:pointer}button:hover,button[aria-expanded=true]{background:light-dark(#f4f4f5,#27272a)}button:focus-visible{outline:2px solid #3b82f6;outline-offset:-2px}@media(pointer:coarse){button{min-height:44px}}`
const start: ViteHubPageToolModule["default"] = (context) => {
  const { bar, tool, signal } = context
  const shadow = bar.attachShadow({ mode: "open" })
  shadow.innerHTML = `<style>${styles}</style><button type="button" aria-haspopup="dialog" aria-expanded="false"></button>`
  const button = shadow.querySelector("button")!
  button.textContent = tool.label
  const assetPath = new URL(import.meta.url).pathname
  const base = assetPath.slice(0, assetPath.lastIndexOf("/assets/"))
  const isContent = tool.id === "content"
  const key = `vitehub-editor:${base}:${tool.id}`
  let route = isContent ? "/content" : "/"
  try {
    const saved = sessionStorage.getItem(key)
    if (saved?.startsWith("/") && !saved.startsWith("//")) route = saved
  } catch {}
  let frame: HTMLIFrameElement | undefined
  let ready = false
  let dirty = false
  let requested: string | undefined
  let loading: HTMLElement | undefined
  let loadTimer: ReturnType<typeof setTimeout> | undefined
  const panel = context.createWindow({ id: `${base}:${tool.id}`, title: tool.label, trigger: button })
  const open = (path?: string) => {
    if (path) {
      const target = new URL(`${base}${path}`, location.origin)
      if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || target.origin !== location.origin || !target.pathname.startsWith(`${base}/`)) return
      requested = path
    }
    if (!frame) {
      frame = document.createElement("iframe")
      frame.title = `${tool.label} editor`
      const url = new URL(`${base}${requested ?? route}`, location.origin)
      url.searchParams.set("embed", "1")
      frame.src = url.href
      requested = undefined
      loading = document.createElement("div")
      loading.style.cssText = "position:absolute;inset:0;display:grid;place-content:center;gap:12px;padding:24px;background:light-dark(#fff,#000)"
      const status = document.createElement("p")
      status.setAttribute("role", "status")
      status.textContent = `Loading ${tool.label}…`
      const link = document.createElement("a")
      link.href = url.href
      link.target = "_blank"
      link.rel = "noopener"
      link.textContent = "Open in a new tab"
      loading.append(status, link)
      panel.body.append(frame, loading)
      loadTimer = setTimeout(() => { status.textContent = "The editor did not load. Open it in a new tab to continue." }, 8000)
    }
    else if (ready && requested) {
      frame.contentWindow?.postMessage({ type: "vitehub:navigate", path: requested }, location.origin)
      requested = undefined
    }
    panel.show()
  }
  window.addEventListener("message", event => {
    if (event.origin !== location.origin || event.source !== frame?.contentWindow || !event.data || typeof event.data !== "object") return
    const data: unknown = event.data
    if (!data || typeof data !== "object" || !("type" in data)) return
    if (data.type === "vitehub:minimize") panel.hide()
    if (data.type === "vitehub:ready") {
      ready = true
      clearTimeout(loadTimer)
      loading?.remove()
      if (requested) open(requested)
    }
    if (data.type === "vitehub:dirty" && "dirty" in data && typeof data.dirty === "boolean") dirty = data.dirty
    if (data.type === "vitehub:route" && "path" in data && typeof data.path === "string" && data.path.startsWith("/") && !data.path.startsWith("//")) {
      route = data.path
      try { sessionStorage.setItem(key, route) } catch {}
    }
  }, { signal })
  window.addEventListener("beforeunload", event => { if (dirty) event.preventDefault() }, { signal })
  signal.addEventListener("abort", () => clearTimeout(loadTimer), { once: true })
  context.beforeExit(() => !dirty || window.confirm("Turn off tools without saving? Your changes will be lost."))
  button.addEventListener("click", () => button.getAttribute("aria-expanded") === "true" ? panel.hide() : open())
  context.onOpen(open)
  if (context.open) open()

  // The Content owner supplies field addresses. No DOM text is treated as stored content.
  if (isContent) {
    const select = document.createElement("button")
    select.type = "button"
    select.textContent = "Select field"
    select.setAttribute("aria-pressed", "false")
    shadow.append(select)
    let selecting = false
    const stop = () => { selecting = false; select.setAttribute("aria-pressed", "false"); document.documentElement.classList.remove("vitehub-select-content") }
    select.addEventListener("click", () => {
      selecting = !selecting
      select.setAttribute("aria-pressed", String(selecting))
      document.documentElement.classList.toggle("vitehub-select-content", selecting)
    })
    const style = document.createElement("style")
    style.textContent = `.vitehub-select-content [${contentFieldAttribute}]{outline:1px dashed #3b82f6;outline-offset:3px;cursor:crosshair}.vitehub-select-content [${contentFieldAttribute}]:hover{outline-style:solid}`
    document.head.append(style)
    document.addEventListener("click", event => {
      if (!selecting || !(event.target instanceof Element)) return
      const element = event.target.closest(`[${contentFieldAttribute}]`)
      const address = element && parseContentField(element.getAttribute(contentFieldAttribute) ?? "")
      if (!address) return
      event.preventDefault()
      event.stopImmediatePropagation()
      stop()
      open(`/content/${encodeURIComponent(address.collection)}${address.id ? `/${address.id.split("/").map(encodeURIComponent).join("/")}` : ""}`)
    }, { capture: true, signal })
    document.addEventListener("keydown", event => { if (event.key === "Escape") stop() }, { signal })
    signal.addEventListener("abort", () => { stop(); style.remove() }, { once: true })
  }
}
export default start
