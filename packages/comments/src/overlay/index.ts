import { viteHubPillButtonStyles } from "@vite-hub/internal/runtime/page-tools-shared"
import commentMarks from "@vite-hub/ui/comment-marks.css?inline"
import commentSend from "@vite-hub/ui/comment-send.css?inline"

import { fieldElementOf } from "../anchor.ts"
import { commentsClientDiagnostics, warnDiagnostic } from "../client-diagnostics.ts"
import { normalizeCommentPage } from "../page.ts"
import { api } from "./api.ts"
import { hostIsDark, mountOverlay } from "./app.ts"
import { appOverlayElement, hostedDraftEvent, hostedOverlayElement, pendingHostedDraft } from "./element.ts"
import { areaStyles, documentStyles, pillBarStyles } from "./styles.ts"

import type { ViteHubPageToolContext, ViteHubPageToolModule } from "@vite-hub/internal/runtime/page-tools-loader"
import type { Mode, OverlayControl } from "./app.ts"
import type { HostedDraftRequest } from "./element.ts"

function style(text: string): HTMLStyleElement {
  const element = document.createElement("style")
  element.textContent = text
  return element
}

class CommentsOverlay extends HTMLElement {
  context?: ViteHubPageToolContext
  private readonly documentStyle = style(`@layer components {\n${commentMarks}\n}\n${documentStyles}`)
  private readonly areas = document.createElement("vitehub-comment-areas")
  private readonly toolbar = document.createElement("div")
  private control?: OverlayControl
  private mode: Mode = "view"
  private frame = 0
  private changed = false
  private lastCursor = 0
  private readonly cleanups: Array<() => void> = []

  waitForPendingComment() {
    return this.control?.waitForPendingComment()
  }

  private get active() {
    return this.isConnected && !this.context?.signal.aborted
  }

  async connectedCallback() {
    this.setAttribute("data-comments-ui", "")
    if (!this.shadowRoot) this.attachShadow({ mode: "open" })
    const bar = this.context?.bar
    if (bar) {
      bar.tabIndex = -1
      bar.setAttribute("data-comments-ui", "")
      const segment = bar.shadowRoot ?? bar.attachShadow({ mode: "open" })
      const busy = document.createElement("button")
      busy.disabled = true
      busy.setAttribute("aria-busy", "true")
      busy.textContent = this.context?.tool.label ?? "Comments"
      segment.replaceChildren(style(viteHubPillButtonStyles + pillBarStyles + commentSend), this.toolbar)
      this.toolbar.replaceChildren(busy)
    }
    this.restoreDocumentState()
    this.cleanups.push(() => this.documentStyle.remove())
    const areaRoot = this.areas.shadowRoot ?? this.areas.attachShadow({ mode: "open" })
    areaRoot.replaceChildren(style(commentMarks + areaStyles))
    this.areas.setAttribute("data-comments-ui", "")
    document.documentElement.append(this.areas)
    this.cleanups.push(() => this.areas.remove())
    this.followTheme()

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
    if (new URLSearchParams(location.search).has("comment")) return
    if (this.context?.linked) this.control.pressComments()
    else if (this.context?.open) this.control.showPanel()
  }

  disconnectedCallback() {
    for (const cleanup of this.cleanups.splice(0)) cleanup()
    cancelAnimationFrame(this.frame)
    this.control?.destroy()
    this.control = undefined
  }

  private followTheme() {
    const apply = () => {
      const dark = hostIsDark()
      this.style.colorScheme = dark ? "dark" : "light"
      this.classList.toggle("dark", dark)
      this.areas.classList.toggle("dark", dark)
      this.dataset.theme = dark ? "dark" : "light"
      const ink = getComputedStyle(this.areas).getPropertyValue("--vh-comment-default-ink").trim()
      const text = `@layer components {\n${commentMarks}\n:root { --vh-comment-ink: var(--vh-ui-comment-ink, var(--vh-highlighted, ${ink})); }\n}\n${documentStyles}`
      if (this.documentStyle.textContent !== text) this.documentStyle.textContent = text
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
      const editing = this.control?.editElement()
      if (editing && !editing.isConnected) void this.control?.finishEdit(true)
      this.restoreDocumentState()
      this.changed = true
      schedule()
    })
    mutations.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class", "style", "hidden"] })
    this.cleanups.push(() => mutations.disconnect())

    const navigate = () => queueMicrotask(() => {
      if (this.active) this.control?.navigated(normalizeCommentPage(location.pathname))
    })
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
    const poll = setInterval(() => {
      if (document.visibilityState === "visible") this.control?.refresh()
    }, 30_000)
    this.cleanups.push(() => clearInterval(poll))
  }

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
    const edit = this.control?.editMode()
    if (!edit && event.timeStamp - this.lastCursor < 80) return
    this.lastCursor = event.timeStamp
    this.control?.pointer(event, this.elementAt(event.clientX, event.clientY))
  }

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

  stop() {
    if (!this.isConnected) return
    void this.control?.finishEdit(false)
    this.control?.setMode("view")
    this.mode = "view"
    this.restoreDocumentState()
    this.remove()
  }
}

function overlayTool(name: string): ViteHubPageToolModule["default"] {
  return (context) => {
    if (!customElements.get(name)) customElements.define(name, class extends CommentsOverlay {})
    const overlay = document.createElement(name)
    if (!(overlay instanceof CommentsOverlay)) {
      warnDiagnostic(commentsClientDiagnostics.COMMENTS_OVERLAY_ELEMENT_TAKEN({ name }))
      return
    }
    overlay.context = context
    if (name === hostedOverlayElement) overlay.addEventListener(hostedDraftEvent, (event) => {
      if (!(event instanceof CustomEvent)) return
      const detail: HostedDraftRequest = event.detail
      const ready = overlay.waitForPendingComment()
      if (ready) detail.draft = { ready, stop: () => overlay.stop() }
    })
    document.documentElement.append(overlay)
    return () => overlay.stop()
  }
}

const startAppOverlay = overlayTool(appOverlayElement)

const start: ViteHubPageToolModule["default"] = (context) => {
  const draft = pendingHostedDraft()
  if (!draft) return startAppOverlay(context)
  let cancelled = false
  let stop: (() => void) | void
  void draft.ready.then(() => {
    if (cancelled || context.signal.aborted) return
    draft.stop()
    stop = startAppOverlay(context)
  })
  return () => {
    cancelled = true
    stop?.()
  }
}

export default start

/** The `comments` tool of the Hosted Comments pill: the same overlay in its own `<vitehub-hosted-comments>` element. */
export const startHostedOverlay: ViteHubPageToolModule["default"] = overlayTool(hostedOverlayElement)
