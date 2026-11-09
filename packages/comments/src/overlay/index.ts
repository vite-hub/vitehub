import { viteHubPillButtonStyles } from "@vite-hub/internal/runtime/page-tools-shared"

import { fieldElementOf } from "../anchor.ts"
import { normalizeCommentPage } from "../page.ts"
import { api } from "./api.ts"
import { hostIsDark, mountOverlay } from "./app.ts"
import { areaStyles, documentStyles, pillBarStyles } from "./styles.ts"

import type { ViteHubPageToolContext, ViteHubPageToolModule } from "@vite-hub/internal/runtime/page-tools-loader"
import type { Mode, OverlayControl } from "./app.ts"

function style(text: string): HTMLStyleElement {
  const element = document.createElement("style")
  element.textContent = text
  return element
}

/**
 * The `<vitehub-comments>` element: the shadow root of the comment UI, and the document listeners that it needs. The
 * comment UI itself is Vue and the comment parts of `@vite-hub/ui`, which `mountOverlay()` mounts once the session
 * says who the person is.
 */
class CommentsOverlay extends HTMLElement {
  /** The page tools context that started the overlay. */
  context?: ViteHubPageToolContext
  private readonly documentStyle = style(documentStyles)
  /** The areas of threads, under the page's floating controls. See `areaStyles`. */
  private readonly areas = document.createElement("vitehub-comment-areas")
  private readonly toolbar = document.createElement("div")
  private control?: OverlayControl
  private mode: Mode = "view"
  private frame = 0
  /** Whether the DOM of the page changed since the last layout frame. */
  private changed = false
  private lastCursor = 0
  private readonly cleanups: Array<() => void> = []

  private get active() {
    return this.isConnected && !this.context?.signal.aborted
  }

  async connectedCallback() {
    // Anchors and the comment parts skip the overlay's own elements by this attribute.
    this.setAttribute("data-comments-ui", "")
    if (!this.shadowRoot) this.attachShadow({ mode: "open" })
    const bar = this.context?.bar
    if (bar) {
      bar.tabIndex = -1
      bar.setAttribute("data-comments-ui", "")
      // Until the session answers, the segment keeps the launch button's place and busy look, so the pill does not shrink
      // and grow again. A session that does not allow the overlay hides the segment.
      const segment = bar.shadowRoot ?? bar.attachShadow({ mode: "open" })
      const busy = document.createElement("button")
      busy.disabled = true
      busy.setAttribute("aria-busy", "true")
      busy.textContent = this.context?.tool.label ?? "Comments"
      segment.replaceChildren(style(viteHubPillButtonStyles + pillBarStyles), this.toolbar)
      this.toolbar.replaceChildren(busy)
    }
    this.followTheme()
    this.restoreDocumentState()
    this.cleanups.push(() => this.documentStyle.remove())
    const areaRoot = this.areas.shadowRoot ?? this.areas.attachShadow({ mode: "open" })
    areaRoot.replaceChildren(style(areaStyles))
    this.areas.setAttribute("data-comments-ui", "")
    document.documentElement.append(this.areas)
    this.cleanups.push(() => this.areas.remove())

    const [error, session] = await api.session(normalizeCommentPage(location.pathname))
    const allowed = this.active && !error && session.can.read
    if (bar) bar.hidden = !allowed
    if (!this.active) return
    this.toolbar.replaceChildren()
    this.control = mountOverlay({
      host: this,
      ...(this.context ? { context: this.context } : {}),
      ...(bar ? { toolbar: this.toolbar } : {}),
      areas: areaRoot,
      ...(error ? { failure: error } : { session }),
      onMode: (mode) => {
        this.mode = mode
        this.restoreDocumentState()
      },
      exit: () => this.context?.exit(),
      prompt: this.context?.open !== false,
    })
    if (!allowed) {
      // Someone who may sign in, or switch accounts, keeps the tool's button, as before it loaded. Pressing it says how.
      if (bar && session && this.active && !this.context?.open && (session.signIn || session.signOut)) {
        const launch = document.createElement("button")
        launch.type = "button"
        launch.textContent = this.context?.tool.label ?? "Comments"
        launch.addEventListener("click", () => this.control?.promptAccess())
        this.toolbar.replaceChildren(launch)
        bar.hidden = false
      }
      return
    }
    this.listen()
    this.context?.onOpen(() => this.control?.showPanel())
    this.context?.beforeExit(() => !this.control?.hasUnsentComment() || window.confirm("Turn off tools without sending your comment?"))
    // A `?comment=<n>` link opens its thread on the page, not the list.
    if (this.context?.open && !new URLSearchParams(location.search).has("comment")) this.control.showPanel()
  }

  disconnectedCallback() {
    for (const cleanup of this.cleanups.splice(0)) cleanup()
    cancelAnimationFrame(this.frame)
    this.control?.destroy()
    this.control = undefined
  }

  /** Keeps the overlay in the page's light or dark scheme when the page or the system switches. */
  private followTheme() {
    const apply = () => {
      const dark = hostIsDark()
      this.style.colorScheme = dark ? "dark" : "light"
      this.classList.toggle("dark", dark)
      this.areas.classList.toggle("dark", dark)
      this.dataset.theme = dark ? "dark" : "light"
    }
    apply()
    const classes = new MutationObserver(apply)
    classes.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] })
    const media = matchMedia("(prefers-color-scheme: dark)")
    media.addEventListener("change", apply)
    this.cleanups.push(() => {
      classes.disconnect()
      media.removeEventListener("change", apply)
    })
  }

  private on<K extends keyof DocumentEventMap>(target: Document | Window, type: K, listener: (event: DocumentEventMap[K]) => void, options?: AddEventListenerOptions) {
    target.addEventListener(type, listener as EventListener, options)
    this.cleanups.push(() => target.removeEventListener(type, listener as EventListener, options))
  }

  private schedule() {
    cancelAnimationFrame(this.frame)
    this.frame = requestAnimationFrame(() => {
      const changed = this.changed
      this.changed = false
      this.control?.layout(changed)
    })
  }

  private listen() {
    const schedule = () => this.schedule()
    this.on(window, "scroll", schedule, { capture: true, passive: true })
    this.on(window, "resize" as keyof DocumentEventMap, schedule)
    const mutations = new MutationObserver((records) => {
      if (records.every(record => record.target === this || this.contains(record.target))) return
      // A direct body or field replacement need not blur the detached editable element.
      const editing = this.control?.editElement()
      if (editing && !editing.isConnected) void this.control?.finishEdit(true)
      // Astro replaces html attributes; Astro and Turbo both merge the head. The retained overlay must restore its
      // stylesheet and mode class without resetting its mode or drafts, even when the URL stays the same.
      this.restoreDocumentState()
      this.changed = true
      schedule()
    })
    // Follow the new page as well when its router replaces the body.
    mutations.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class", "style", "hidden"] })
    this.cleanups.push(() => mutations.disconnect())

    // Client navigation: Nuxt and other routers use the History API.
    const navigate = () => queueMicrotask(() => {
      if (this.active) this.control?.navigated(normalizeCommentPage(location.pathname))
    })
    // Finalize the inline draft before Astro or Turbo removes its field, as a normal blur would.
    for (const event of ["astro:before-swap", "turbo:before-render"]) {
      this.on(document, event as keyof DocumentEventMap, () => void this.control?.finishEdit(true))
    }
    for (const method of ["pushState", "replaceState"] as const) {
      const original = history[method]
      history[method] = function (this: History, ...args: Parameters<History["pushState"]>) {
        const result = original.apply(this, args)
        navigate()
        return result
      }
      this.cleanups.push(() => {
        history[method] = original
      })
    }
    this.on(window, "popstate" as keyof DocumentEventMap, navigate)

    // The bar over selected text: shown once the selection settles, so it does not chase a drag.
    let selectionTimer: ReturnType<typeof setTimeout> | undefined
    const selectionChanged = (delay: number) => {
      clearTimeout(selectionTimer)
      selectionTimer = setTimeout(() => this.control?.selectionChanged(), delay)
    }
    this.on(document, "selectionchange", () => selectionChanged(200))
    this.on(document, "pointerup", () => selectionChanged(0))
    this.cleanups.push(() => clearTimeout(selectionTimer))

    this.on(document, "pointermove", event => this.pointerMoved(event), { passive: true })
    this.on(document, "pointerleave" as keyof DocumentEventMap, () => this.control?.leave())
    this.on(document, "click", event => this.clicked(event), { capture: true })
    this.on(document, "keydown", event => this.control?.key(event))
    this.on(document, "visibilitychange", () => {
      if (document.visibilityState === "visible") this.control?.refresh()
    })
    // Writes from the server API (Console, Agents) reach open pages within 30 seconds.
    const poll = setInterval(() => {
      if (document.visibilityState === "visible") this.control?.refresh()
    }, 30_000)
    this.cleanups.push(() => clearInterval(poll))
  }

  /** Whether the event happened on the overlay, or on the page tools pill that holds its toolbar and the other tools. */
  private ours(event: Event): boolean {
    const path = event.composedPath()
    const pill = this.context?.bar.parentElement
    return path.includes(this) || path.some(node => node instanceof Element && node.localName === "vitehub-window") || Boolean(pill && path.includes(pill))
  }

  private elementAt(x: number, y: number): Element | undefined {
    return document.elementsFromPoint(x, y).find(element => element !== this && !this.contains(element) && element !== document.documentElement)
  }

  private pointerMoved(event: PointerEvent) {
    if (this.ours(event)) return
    // Presence sends at most one cursor every 80ms.
    const edit = this.control?.editMode()
    if (!edit && event.timeStamp - this.lastCursor < 80) return
    this.lastCursor = event.timeStamp
    this.control?.pointer(event, this.elementAt(event.clientX, event.clientY))
  }

  /** In edit mode, a click on a Content field edits it. Comment mode's clicks go to the comment layer. */
  private clicked(event: MouseEvent) {
    if (this.ours(event) || !this.control?.editMode()) return
    const target = this.elementAt(event.clientX, event.clientY)
    const field = target ? fieldElementOf(target) : undefined
    if (!field || field === this.control.editElement()) return
    event.preventDefault()
    event.stopPropagation()
    void this.control.startEdit(field as HTMLElement)
  }

  private restoreDocumentState() {
    if (this.documentStyle.parentElement !== document.head) document.head.append(this.documentStyle)
    for (const mode of ["comment", "edit"] as const) {
      const name = `vitehub-${mode}-mode`
      const active = this.mode === mode
      if (document.documentElement.classList.contains(name) !== active) document.documentElement.classList.toggle(name, active)
    }
  }

  /** Ends comment and edit mode, then removes the overlay. The loader calls it when the page tools stop. */
  stop() {
    void this.control?.finishEdit(false)
    this.control?.setMode("view")
    this.mode = "view"
    this.restoreDocumentState()
    this.remove()
  }
}

/**
 * The `comments` page tool: the page tools loader calls it for people that may read comments. It mounts the
 * `<vitehub-comments>` element for pins, cursors, and cards, and draws the toolbar in `context.bar`, the tool's segment
 * of the pill. It returns its cleanup. The toolbar always shows, so `context.open` only opens the list.
 */
const start: ViteHubPageToolModule["default"] = (context) => {
  if (!customElements.get("vitehub-comments")) customElements.define("vitehub-comments", CommentsOverlay)
  const overlay = document.createElement("vitehub-comments")
  if (!(overlay instanceof CommentsOverlay)) return
  overlay.context = context
  // Like the pill and its windows, stay connected throughout a router's body swap. A detach would stop listeners,
  // polling and Realtime, and reconnecting would initialize the toolbar's shadow root a second time.
  document.documentElement.append(overlay)
  return () => overlay.stop()
}

export default start
