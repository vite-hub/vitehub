import { contentFieldAttribute, parseContentField } from "@vite-hub/content/client"
import { viteHubPillButtonStyles } from "@vite-hub/internal/runtime/page-tools-shared"
import type { ViteHubPageToolModule } from "@vite-hub/internal/runtime/page-tools-loader"

const styles = `:host{display:flex;flex-direction:var(--vitehub-pill-flow,row);gap:2px}${viteHubPillButtonStyles}`
// The editor fades in once it is ready, over the window's own surface, so it never flashes a blank page. The status
// only shows when the wait is long enough to notice.
const windowStyles = `iframe{opacity:0;transition:opacity 150ms ease-out}iframe.ready{opacity:1}
.loading{position:absolute;inset:0;display:grid;place-content:center;justify-items:center;gap:8px;padding:24px;text-align:center;color:var(--muted);font-size:.8125rem;opacity:0;animation:vitehub-loading 150ms ease-out 400ms forwards}
.loading p{margin:0}.loading a{color:var(--text);text-underline-offset:3px;text-decoration-color:var(--line)}.loading a:hover{text-decoration-color:currentColor}.loading a:not(.shown){display:none}
@keyframes vitehub-loading{to{opacity:1}}
@media(prefers-reduced-motion:reduce){iframe,.loading{transition:none;animation:none;opacity:1}iframe:not(.ready){opacity:0}}`
// The Console keeps its appearance in this key (see the client's appearance.ts). The page shares its storage.
const appearanceKey = "vitehub-console:appearance"
const appearance = () => {
  try {
    const value = localStorage.getItem(appearanceKey)
    return value === "light" || value === "dark" ? value : undefined
  }
  catch { return undefined }
}
const start: ViteHubPageToolModule["default"] = (context) => {
  const { bar, tool, signal } = context
  const shadow = bar.attachShadow({ mode: "open" })
  const style = document.createElement("style")
  style.textContent = styles
  const button = document.createElement("button")
  button.type = "button"
  button.setAttribute("aria-haspopup", "dialog")
  button.setAttribute("aria-expanded", "false")
  button.textContent = tool.label
  shadow.append(style, button)
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
  const panel = context.createWindow({ id: `${base}:${tool.id}`, title: tool.label, trigger: button, colorScheme: appearance })
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
      const frameStyle = document.createElement("style")
      frameStyle.textContent = windowStyles
      loading = document.createElement("div")
      loading.className = "loading"
      const status = document.createElement("p")
      status.setAttribute("role", "status")
      status.textContent = `Loading ${tool.label}…`
      const link = document.createElement("a")
      link.href = url.href
      link.target = "_blank"
      link.rel = "noopener"
      link.textContent = "Open in a new tab"
      loading.append(status, link)
      panel.body.append(frameStyle, frame, loading)
      loadTimer = setTimeout(() => {
        status.textContent = "The editor did not load. Open it in a new tab to continue."
        link.classList.add("shown")
      }, 8000)
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
      frame?.classList.add("ready")
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
    select.title = "Select a field on the page to edit it. Esc cancels."
    select.setAttribute("aria-pressed", "false")
    shadow.append(select)
    const style = document.createElement("style")
    style.textContent = `.vitehub-select-content [${contentFieldAttribute}]{outline:1px dashed #3b82f6;outline-offset:3px;cursor:crosshair}.vitehub-select-content [${contentFieldAttribute}]:hover{outline-style:solid}`
    document.head.append(style)
    // Selecting moves the open window out of the way until a field is picked; a cancel brings it back. When the window
    // was already minimized, it stays minimized, and only a picked field opens it.
    let selecting = false
    let restore = false
    // Astro and Turbo can replace the head and root classes while the Content tool stays connected.
    const mutations = new MutationObserver(() => {
      if (style.parentElement !== document.head) document.head.append(style)
      if (selecting && !document.documentElement.classList.contains("vitehub-select-content")) document.documentElement.classList.add("vitehub-select-content")
    })
    mutations.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] })
    const stop = (picked: boolean) => {
      if (!selecting) return
      selecting = false
      select.setAttribute("aria-pressed", "false")
      document.documentElement.classList.remove("vitehub-select-content")
      if (restore && !picked) panel.show()
      restore = false
    }
    select.addEventListener("click", () => {
      if (selecting) return stop(false)
      selecting = true
      select.setAttribute("aria-pressed", "true")
      document.documentElement.classList.add("vitehub-select-content")
      restore = button.getAttribute("aria-expanded") === "true"
      if (restore) {
        panel.hide()
        select.focus({ preventScroll: true })
      }
    })
    document.addEventListener("click", (event) => {
      if (!selecting || event.composedPath().some(target => target instanceof HTMLElement && target.localName.startsWith("vitehub-"))) return
      // A click while selecting never reaches the page, so a link that is not a field does not navigate.
      event.preventDefault()
      event.stopImmediatePropagation()
      const element = event.target instanceof Element ? event.target.closest(`[${contentFieldAttribute}]`) : null
      const address = element && parseContentField(element.getAttribute(contentFieldAttribute) ?? "")
      if (!address) return stop(false)
      stop(true)
      open(`/content/${encodeURIComponent(address.collection)}${address.id ? `/${address.id.split("/").map(encodeURIComponent).join("/")}` : ""}`)
    }, { capture: true, signal })
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !selecting) return
      event.preventDefault()
      stop(false)
    }, { capture: true, signal })
    signal.addEventListener("abort", () => { mutations.disconnect(); stop(true); style.remove() }, { once: true })
  }
}
export default start
