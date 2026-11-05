import { contentFieldAttribute, contentPreviewFrameParameter, contentPreviewPublishedParameter, parseContentField } from "@vite-hub/content/client"
import { viteHubPillButtonStyles } from "@vite-hub/internal/runtime/page-tools-shared"
import type { ViteHubPageToolModule } from "@vite-hub/internal/runtime/page-tools-loader"
import { appPathname } from "../../comments-overlay/loader-core.ts"

const styles = `:host{display:flex;flex-direction:var(--vitehub-pill-flow,row);gap:2px}${viteHubPillButtonStyles}
button.view-draft{gap:6px}button.view-draft[hidden]{display:none}
.dot{width:7px;height:7px;border-radius:50%;background:#f59e0b;flex:none}`
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
/**
 * The full page of what a Console window shows: the same route, query, and hash, without the `embed` frame mode. The
 * window's **Open in new tab** link and the fallback link both use it.
 */
export function consolePageUrl(base: string, route: string, origin = location.origin): string {
  const url = new URL(`${base}${route}`, origin)
  // Filter the raw query, so the other parameters keep their exact text.
  url.search = url.search.slice(1).split("&").filter(part => part && part.split("=")[0] !== "embed").join("&")
  return url.href
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
  const panel = context.createWindow({ id: `${base}:${tool.id}`, title: tool.label, trigger: button, colorScheme: appearance, href: () => consolePageUrl(base, route) })
  const open = (path?: string) => {
    if (path) {
      const target = new URL(`${base}${path}`, location.origin)
      if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || target.origin !== location.origin || !target.pathname.startsWith(`${base}/`)) return
      requested = path
    }
    if (!frame) {
      frame = document.createElement("iframe")
      frame.title = `${tool.label} editor`
      route = requested ?? route
      requested = undefined
      const url = new URL(`${base}${route}`, location.origin)
      url.searchParams.set("embed", "1")
      frame.src = url.href
      const frameStyle = document.createElement("style")
      frameStyle.textContent = windowStyles
      loading = document.createElement("div")
      loading.className = "loading"
      const status = document.createElement("p")
      status.setAttribute("role", "status")
      status.textContent = `Loading ${tool.label}…`
      const link = document.createElement("a")
      link.href = consolePageUrl(base, route)
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
    draftSwitch(base, shadow, context.createTab, signal)
  }
}
/** The Console RPC header. It matches `consoleRpcHeader`, which the page tool does not import to stay small. */
const rpcHeader = "x-vitehub-console"

/** The document that a page shows and its state, from the Content `resolve` action. */
export interface PageDocument {
  collection: string
  id: string
  state: "draft" | "published" | "changed" | "deleted"
}

/** Calls one Content document action over the Console RPC below `base`, the Console mount such as `/_vitehub`. */
async function documentAction(base: string, action: "preview" | "resolve", body: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(`${base}/rpc/__call`, {
    body: JSON.stringify({ operation: "documents.action", input: { action, body, section: "content" } }),
    cache: "no-store",
    credentials: "same-origin",
    headers: { "content-type": "application/json", [rpcHeader]: "1" },
    method: "POST",
    signal,
  })
  const result: unknown = response.ok ? await response.json().catch(() => undefined) : undefined
  if (!result || typeof result !== "object" || !("ok" in result) || result.ok !== true || !("value" in result)) throw new Error(`The Content ${action} action failed (${response.status}).`)
  return result.value
}

function pageDocument(value: unknown): PageDocument | undefined {
  if (!value || typeof value !== "object" || !("collection" in value) || !("id" in value) || !("state" in value)) return
  const { collection, id, state } = value
  if (String(collection) !== collection || String(id) !== id) return
  if (state !== "draft" && state !== "published" && state !== "changed" && state !== "deleted") return
  return { collection, id, state }
}

/** Whether this page is the draft view: the browser posted the preview form to it. The parameter alone grants nothing. */
export function isDraftView(search: string): boolean {
  return new URLSearchParams(search).has(contentPreviewFrameParameter)
}

/** The live address of the page: its URL without the draft view parameter. */
export function liveUrl(href: string): string {
  const url = new URL(href)
  url.searchParams.delete(contentPreviewFrameParameter)
  return url.href
}

/** The address of the live page for the change marks: published reads, even for a browser with a preview cookie. */
function publishedUrl(href: string): string {
  const url = new URL(liveUrl(href))
  url.searchParams.set(contentPreviewPublishedParameter, "")
  return url.href
}

/** The elements that the change marks compare. Each is text that a reader sees as one unit. */
const blockSelector = "h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,figcaption,dt,dd,th,td"
/** The attribute on a draft block that the live page does not have. */
export const draftChangeAttribute = "data-vitehub-draft-change"

/** The innermost blocks below `root` that have text. A list item that holds a paragraph counts once, as the paragraph. */
function textBlocks(root: ParentNode): Array<{ element: Element, text: string }> {
  const blocks: Array<{ element: Element, text: string }> = []
  for (const element of root.querySelectorAll(blockSelector)) {
    if (element.querySelector(blockSelector)) continue
    const text = (element.textContent ?? "").replace(/\s+/g, " ").trim()
    if (text) blocks.push({ element, text })
  }
  return blocks
}

/**
 * Compares the text blocks of the draft page with those of the live page. Blocks match by their text, so a moved
 * paragraph is not a change. `changed` lists the draft blocks that the live page does not have. `removed` counts the
 * live blocks that are gone and that no changed block took the place of.
 */
export function draftChanges(draft: ParentNode, live: ParentNode): { changed: Element[], removed: number } {
  const left = new Map<string, number>()
  for (const { text } of textBlocks(live)) left.set(text, (left.get(text) ?? 0) + 1)
  const changed: Element[] = []
  for (const { element, text } of textBlocks(draft)) {
    const count = left.get(text) ?? 0
    if (count) left.set(text, count - 1)
    else changed.push(element)
  }
  let gone = 0
  for (const count of left.values()) gone += count
  return { changed, removed: Math.max(0, gone - changed.length) }
}

/**
 * Loads the live page in a hidden same-origin frame at the width of this window, and resolves with its document once
 * it loaded. A frame, not `fetch`, so that components that render only in the browser show on both sides.
 */
function loadLivePage(href: string, signal: AbortSignal): Promise<Document> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement("iframe")
    frame.setAttribute("aria-hidden", "true")
    frame.tabIndex = -1
    frame.style.cssText = `position:fixed;left:-10000px;top:0;width:${innerWidth}px;height:${innerHeight}px;border:0;visibility:hidden;pointer-events:none`
    const done = () => { clearTimeout(timer); frame.remove() }
    const timer = setTimeout(() => { done(); reject(new Error("The live page did not load.")) }, 15_000)
    signal.addEventListener("abort", () => { done(); reject(signal.reason) }, { once: true })
    frame.addEventListener("load", () => {
      // Give the page a moment to hydrate, as this page did before the comparison.
      setTimeout(() => {
        const live = frame.contentDocument
        if (!live?.body) { done(); return reject(new Error("The live page is not readable.")) }
        const copy = document.implementation.createHTMLDocument("")
        copy.body.replaceWith(copy.importNode(live.body, true))
        done()
        resolve(copy)
      }, 500)
    }, { once: true })
    frame.src = publishedUrl(href)
    document.documentElement.append(frame)
  })
}

const tabStyles = `:host{display:flex;align-items:center;gap:2px}${viteHubPillButtonStyles}
.label{display:inline-flex;align-items:center;gap:6px;padding:0 8px;color:var(--vitehub-pill-strong);white-space:nowrap}
.dot{width:7px;height:7px;border-radius:50%;background:#f59e0b;flex:none}
.gone{padding:0 8px 0 0;color:var(--vitehub-pill-muted);white-space:nowrap}
button.marks:disabled{cursor:default;color:var(--vitehub-pill-muted)}[hidden]{display:none!important}`
const changeStyles = `[${draftChangeAttribute}]{background-color:rgb(245 158 11 / .16);outline:2px solid rgb(245 158 11 / .85);outline-offset:2px;border-radius:2px}`

/**
 * The tab of the draft view, on top of the pill: it says that this page shows the draft, marks the blocks that the
 * draft changed, and leads back to the live page.
 */
function draftTab(tab: HTMLElement, signal: AbortSignal): () => void {
  const shadow = tab.attachShadow({ mode: "open" })
  const style = document.createElement("style")
  style.textContent = tabStyles
  const label = document.createElement("span")
  label.className = "label"
  label.title = "This page shows its saved draft. Only you see it."
  const dot = document.createElement("span")
  dot.className = "dot"
  dot.setAttribute("aria-hidden", "true")
  label.append(dot, "Draft")
  const marks = document.createElement("button")
  marks.type = "button"
  marks.className = "marks"
  marks.disabled = true
  marks.textContent = "Finding changes…"
  const gone = document.createElement("span")
  gone.className = "gone"
  gone.hidden = true
  const back = document.createElement("button")
  back.type = "button"
  back.textContent = "Back to live"
  back.addEventListener("click", () => location.assign(liveUrl(location.href)))
  shadow.append(style, label, marks, gone, back)

  const markStyle = document.createElement("style")
  markStyle.textContent = changeStyles
  let changed: Element[] = []
  let shown = false
  const show = (on: boolean) => {
    shown = on && changed.length > 0
    for (const element of changed) element.toggleAttribute(draftChangeAttribute, shown)
    if (shown) document.head.append(markStyle)
    else markStyle.remove()
    marks.setAttribute("aria-pressed", String(shown))
    marks.textContent = changed.length === 1 ? "1 change" : `${changed.length} changes`
    marks.title = shown ? "Hide the marks on the changed blocks." : "Mark the changed blocks."
  }
  marks.addEventListener("click", () => show(!shown))

  const controller = new AbortController()
  signal.addEventListener("abort", () => controller.abort(), { once: true, signal: controller.signal })
  void loadLivePage(location.href, controller.signal).then((live) => {
    const result = draftChanges(document.body, live.body)
    changed = result.changed
    if (result.removed) {
      gone.textContent = `${result.removed} removed`
      gone.hidden = false
    }
    if (!changed.length) {
      marks.hidden = !!result.removed
      marks.textContent = "No text changes"
      return
    }
    marks.disabled = false
    show(true)
  }, () => {
    if (controller.signal.aborted) return
    marks.hidden = true
  })

  const remove = () => {
    controller.abort()
    show(false)
    tab.remove()
  }
  signal.addEventListener("abort", remove, { once: true })
  return remove
}

/**
 * The draft view of the Content segment. On a live page whose document has an unpublished draft, the pill shows
 * **View draft**. It posts the preview form of that one document to this page, as the side browser of the editor does,
 * so the token stays in the form body and only this browser sees the draft. The draft page shows a tab on top of the
 * pill instead, with the changes marked and **Back to live**. Client-side navigation resolves the next page again.
 */
export function draftSwitch(base: string, shadow: ShadowRoot, createTab: () => HTMLElement, signal: AbortSignal): void {
  const appBase = base.replace(/\/_vitehub$/, "")
  const view = document.createElement("button")
  view.type = "button"
  view.className = "view-draft"
  view.hidden = true
  const dot = document.createElement("span")
  dot.className = "dot"
  dot.setAttribute("aria-hidden", "true")
  view.append(dot, "View draft")
  view.title = "Show this page with its saved draft. Only you see it."
  shadow.append(view)

  let current: PageDocument | undefined
  let pending: AbortController | undefined
  let removeTab: (() => void) | undefined
  const render = () => {
    const drafted = isDraftView(location.search)
    view.hidden = drafted || !current || (current.state !== "changed" && current.state !== "draft")
    if (drafted && !removeTab) removeTab = draftTab(createTab(), signal)
    if (!drafted && removeTab) { removeTab(); removeTab = undefined }
  }
  const refresh = async () => {
    if (signal.aborted) return
    pending?.abort()
    const controller = new AbortController()
    pending = controller
    signal.addEventListener("abort", () => controller.abort(), { once: true, signal: controller.signal })
    try {
      current = pageDocument(await documentAction(base, "resolve", { path: appPathname(location.pathname, appBase) }, controller.signal))
    }
    catch {
      if (controller.signal.aborted) return
      current = undefined
    }
    if (!controller.signal.aborted) render()
  }

  view.addEventListener("click", async () => {
    if (!current || isDraftView(location.search)) return
    view.disabled = true
    try {
      const signed = await documentAction(base, "preview", { collection: current.collection, id: current.id }, signal)
      const token: unknown = signed && typeof signed === "object" && "token" in signed ? signed.token : undefined
      if (String(token) !== token) throw new Error("The preview token is missing.")
      // A top-level same-origin form, like **Open in a new tab** of the side browser. Without `document` the page shows
      // the stored draft.
      const form = document.createElement("form")
      form.method = "post"
      const action = new URL(location.href)
      action.searchParams.set(contentPreviewFrameParameter, "")
      form.action = action.href
      form.hidden = true
      const field = document.createElement("input")
      field.type = "hidden"
      field.name = contentPreviewFrameParameter
      field.value = JSON.stringify({ token })
      form.append(field)
      document.body.append(form)
      form.submit()
      form.remove()
    }
    catch {
      view.disabled = false
      view.title = "The draft could not open. Try again."
    }
  })

  // Routers also call `replaceState` for scroll positions, so only a new path resolves again.
  let path = location.pathname
  const navigated = () => queueMicrotask(() => {
    if (signal.aborted) return
    if (location.pathname === path) return render()
    path = location.pathname
    current = undefined
    render()
    void refresh()
  })
  for (const method of ["pushState", "replaceState"] as const) {
    const original = history[method]
    const wrapped = function (this: History, ...args: Parameters<History["pushState"]>) {
      const result = original.apply(this, args)
      if (!signal.aborted) navigated()
      return result
    }
    history[method] = wrapped
    // Another tool may retain this wrapper. Leave its chain intact; the aborted signal makes ours inert.
    signal.addEventListener("abort", () => { if (history[method] === wrapped) history[method] = original }, { once: true })
  }
  window.addEventListener("popstate", navigated, { signal })
  render()
  void refresh()
}

export default start
