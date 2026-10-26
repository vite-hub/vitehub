import { viteHubPageToolsQuery } from "@vite-hub/internal/runtime/page-tools-loader"
import { connectRealtimeRoom } from "@vite-hub/realtime/client"

import { createAnchor, fieldAttribute, fieldElementOf, placeAnchor, selectorOf } from "../anchor.ts"
import { commentRoom, commentsRealtimeDefinition, normalizeCommentPage } from "../page.ts"
import { api, readGuest, saveGuest } from "./api.ts"
import { captureContext } from "./context.ts"
import { documentStyles, overlayStyles } from "./styles.ts"

import type { ViteHubPageToolContext, ViteHubPageToolModule } from "@vite-hub/internal/runtime/page-tools-loader"
import type { RealtimeRoom } from "@vite-hub/realtime/client"
import type { CommentAnchor, CommentAuthor, CommentContext, CommentMention } from "../types.ts"
import type { CommentsApiError, CommentsSession, PageThread } from "./api.ts"

type Mode = "view" | "comment" | "edit"

interface Cursor {
  selector: string
  x: number
  y: number
}

type Child = Node | string | false | null | undefined

/** Creates an element with attributes, listeners (`on<event>`), and children. */
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false || value === null) continue
    if (key.startsWith("on") && value instanceof Function) element.addEventListener(key.slice(2).toLowerCase(), value as EventListener)
    else if (key === "className") element.className = String(value)
    else element.setAttribute(key, value === true ? "" : String(value))
  }
  for (const child of children) if (child) element.append(child)
  return element
}

/** The children that are present, for `replaceChildren()`. */
function present(...children: Child[]): Array<Node | string> {
  return children.filter((child): child is Node | string => Boolean(child))
}

const svg = (path: string) => {
  const template = document.createElement("template")
  template.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`
  return template.content.firstChild!
}
const icons = {
  comment: () => svg("<path d=\"M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z\"/>"),
  edit: () => svg("<path d=\"M12 20h9\"/><path d=\"M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z\"/>"),
  list: () => svg("<path d=\"M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01\"/>"),
  close: () => svg("<path d=\"M18 6 6 18M6 6l12 12\"/>"),
  check: () => svg("<path d=\"M20 6 9 17l-5-5\"/>"),
  reopen: () => svg("<path d=\"M3 12a9 9 0 1 0 3-6.7L3 8\"/><path d=\"M3 3v5h5\"/>"),
  trash: () => svg("<path d=\"M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6\"/>"),
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]!.toUpperCase()).join("") || "?"
}

function colorOf(id: string): string {
  const colors = ["#fb7185", "#fbbf24", "#34d399", "#22d3ee", "#60a5fa", "#a78bfa", "#f472b6"]
  let hash = 0
  for (let index = 0; index < id.length; index++) hash = Math.imul(31, hash) + id.charCodeAt(index) | 0
  return colors[Math.abs(hash) % colors.length]!
}

function avatar(person: { id: string, name: string, image?: string | null }): HTMLElement {
  return h("span", { className: "avatar", style: `background:${colorOf(person.id)}`, "aria-hidden": "true" }, person.image ? h("img", { src: person.image, alt: "" }) : initials(person.name))
}

/** Whether the host page shows its dark scheme: a `dark` class, as Nuxt UI and Tailwind set, or `color-scheme`. */
function hostIsDark(): boolean {
  const root = document.documentElement
  if (root.classList.contains("dark")) return true
  if (root.classList.contains("light")) return false
  const scheme = getComputedStyle(root).colorScheme
  if (scheme === "dark") return true
  return scheme.includes("dark") && matchMedia("(prefers-color-scheme: dark)").matches
}

function ago(iso: string): string {
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000)
  if (seconds < 60) return "now"
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h`
  return new Date(iso).toLocaleDateString()
}

function isTyping(event: KeyboardEvent): boolean {
  const target = event.composedPath()[0]
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
}

/** Mentions whose `@name` is still in the text. */
function keptMentions(body: string, mentions: CommentMention[]): CommentMention[] {
  const seen = new Set<string>()
  return mentions.filter(mention => body.includes(`@${mention.name}`) && !seen.has(mention.id) && seen.add(mention.id))
}

function renderBody(body: string, mentions: CommentMention[]): Node {
  const element = h("div", { className: "body" })
  if (!mentions.length) {
    element.textContent = body
    return element
  }
  const names = mentions.map(mention => `@${mention.name}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  for (const part of body.split(new RegExp(`(${names.join("|")})`, "g"))) {
    element.append(mentions.some(mention => `@${mention.name}` === part) ? h("span", { className: "mention" }, part) : part)
  }
  return element
}

class CommentsOverlay extends HTMLElement {
  /** The page tools context that started the overlay. */
  context?: ViteHubPageToolContext
  private readonly shadow = this.attachShadow({ mode: "open" })
  private readonly root = h("div", { className: "root" })
  private readonly layer = h("div", { className: "layer" })
  private readonly pins = h("div")
  private readonly outlines = h("div")
  private readonly pinElements = new Map<string, HTMLElement>()
  private readonly cursors = h("div", { className: "layer" })
  private readonly floating = h("div")
  private readonly toolbar = h("div", { className: "toolbar", role: "toolbar", "aria-label": "Comments" })
  private session?: CommentsSession
  private page = normalizeCommentPage(location.pathname)
  private threads: PageThread[] = []
  private mode: Mode = "view"
  private openThread?: string
  private draft?: { anchor: CommentAnchor, context: CommentContext, x: number, y: number }
  private panel = false
  private showResolved = false
  private room?: RealtimeRoom
  private frame = 0
  private hover?: Element
  private drafted = new Set<string>()
  private editing?: { element: HTMLElement, field: string, digest: string, original: string }
  private editStop?: () => void
  private toastTimer?: ReturnType<typeof setTimeout>
  private toast?: HTMLElement
  private lastCursor = 0
  private readonly cleanups: Array<() => void> = []

  async connectedCallback() {
    this.shadow.append(h("style", {}, overlayStyles), this.root)
    this.root.append(this.layer, this.cursors, this.floating, this.toolbar)
    this.layer.append(this.outlines, this.pins)
    this.root.style.setProperty("--font", getComputedStyle(document.body).fontFamily)
    this.followTheme()
    const style = h("style", { "data-vitehub-comments": true }, documentStyles)
    document.head.append(style)
    this.cleanups.push(() => style.remove())

    const [error, session] = await api.session()
    if (error || !session.can.read) {
      // The page tools session allowed the overlay, so this is an error or a change of access since then.
      this.showToast(error ? error.why : "Comments are only for the site's team. Sign in with an account that may comment.", "error", { keep: true, action: ["Close", () => this.exit()] })
      return
    }
    this.session = session
    this.listen()
    this.renderToolbar()
    await this.load()
    this.joinRoom()
    this.openFromHash()
  }

  disconnectedCallback() {
    for (const cleanup of this.cleanups.splice(0)) cleanup()
    this.room?.destroy()
    cancelAnimationFrame(this.frame)
  }

  // Events

  /** Keeps the overlay in the page's light or dark scheme when the page or the system switches. */
  private followTheme() {
    const apply = () => {
      this.root.dataset.theme = hostIsDark() ? "dark" : "light"
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

  private listen() {
    const schedule = () => this.schedule()
    this.on(window, "scroll", schedule, { capture: true, passive: true })
    this.on(window, "resize" as keyof DocumentEventMap, schedule)
    const resize = new ResizeObserver(schedule)
    resize.observe(document.documentElement)
    // Content and route changes move anchors. One debounced observer re-places every pin.
    let timer: ReturnType<typeof setTimeout> | undefined
    const mutations = new MutationObserver((records) => {
      if (records.every(record => record.target === this || this.contains(record.target))) return
      clearTimeout(timer)
      timer = setTimeout(schedule, 50)
    })
    mutations.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class", "style", "hidden"] })
    this.cleanups.push(() => {
      resize.disconnect()
      mutations.disconnect()
    })

    // Client navigation: Nuxt and other routers use the History API.
    const navigate = () => queueMicrotask(() => this.navigated())
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
    this.on(window, "hashchange" as keyof DocumentEventMap, () => this.openFromHash())

    this.on(document, "pointermove", event => this.pointerMoved(event), { passive: true })
    this.on(document, "pointerleave" as keyof DocumentEventMap, () => this.room?.setLocal("cursor", null))
    this.on(document, "click", event => this.clicked(event), { capture: true })
    this.on(document, "keydown", event => this.keyed(event))
    this.on(document, "visibilitychange", () => {
      if (document.visibilityState === "visible") void this.load()
    })
    // Writes from the server API (Console, Agents) reach open pages within 30 seconds.
    const poll = setInterval(() => {
      if (document.visibilityState === "visible") void this.load()
    }, 30_000)
    this.cleanups.push(() => clearInterval(poll))
  }

  private ours(event: Event): boolean {
    return event.composedPath().includes(this)
  }

  private elementAt(x: number, y: number): Element | undefined {
    return document.elementsFromPoint(x, y).find(element => element !== this && !this.contains(element) && element !== document.documentElement)
  }

  private pointerMoved(event: PointerEvent) {
    if (this.ours(event)) return
    if (this.mode === "edit") {
      const target = this.elementAt(event.clientX, event.clientY)
      const field = target ? fieldElementOf(target) : undefined
      if (field !== this.hover) {
        this.hover = field
        this.schedule()
      }
    }
    if (!this.room || event.timeStamp - this.lastCursor < 80) return
    this.lastCursor = event.timeStamp
    const target = this.elementAt(event.clientX, event.clientY)
    if (!target) return
    const box = target.getBoundingClientRect()
    const cursor: Cursor = {
      selector: selectorOf(target),
      x: box.width ? Math.round(((event.clientX - box.left) / box.width) * 1000) : 0,
      y: box.height ? Math.round(((event.clientY - box.top) / box.height) * 1000) : 0,
    }
    this.room.setLocal("cursor", cursor)
  }

  private clicked(event: MouseEvent) {
    if (this.ours(event) || this.mode === "view") return
    const target = this.elementAt(event.clientX, event.clientY)
    if (!target) return
    if (this.mode === "edit") {
      const field = fieldElementOf(target)
      if (!field || field === this.editing?.element) return
      event.preventDefault()
      event.stopPropagation()
      void this.startEdit(field as HTMLElement)
      return
    }
    event.preventDefault()
    event.stopPropagation()
    this.openThread = undefined
    this.draft = { anchor: createAnchor(target, event.clientX, event.clientY), context: captureContext(target, viteHubPageToolsQuery), x: event.clientX, y: event.clientY }
    this.render()
  }

  private keyed(event: KeyboardEvent) {
    if (event.key === "Escape") {
      if (this.draft || this.openThread) {
        this.draft = undefined
        this.openThread = undefined
      }
      else this.setMode("view")
      this.render()
      return
    }
    if (isTyping(event) || event.metaKey || event.ctrlKey || event.altKey) return
    if (event.key === "c" && this.session?.can.comment) this.setMode(this.mode === "comment" ? "view" : "comment")
    if (event.key === "e" && this.session?.content) this.setMode(this.mode === "edit" ? "view" : "edit")
  }

  private setMode(mode: Mode) {
    this.mode = mode
    this.hover = undefined
    document.documentElement.classList.toggle("vitehub-comment-mode", mode === "comment")
    document.documentElement.classList.toggle("vitehub-edit-mode", mode === "edit")
    if (mode !== "comment") this.draft = undefined
    this.renderToolbar()
    this.render()
  }

  private async navigated() {
    const page = normalizeCommentPage(location.pathname)
    if (page === this.page) return
    this.page = page
    this.threads = []
    this.openThread = undefined
    this.draft = undefined
    this.room?.destroy()
    this.room = undefined
    this.render()
    await this.load()
    this.joinRoom()
  }

  private openFromHash() {
    const match = /^#comment-(.+)$/.exec(location.hash)
    if (!match) return
    const thread = this.threads.find(candidate => candidate.id === match[1])
    if (!thread) return
    this.showResolved ||= thread.status === "resolved"
    this.openThread = thread.id
    const placed = placeAnchor(thread.anchor)
    if (placed.state === "exact") placed.element.scrollIntoView({ block: "center" })
    this.render()
  }

  // Data

  private async load() {
    const page = this.page
    const [error, threads] = await api.threads(page)
    if (page !== this.page) return
    if (error) {
      this.showToast(error.why, "error")
      return
    }
    this.threads = threads
    this.renderToolbar()
    this.render()
  }

  /** The signed-in person. A guest of a Console without accounts names itself like any guest. */
  private account(): CommentAuthor | undefined {
    const user = this.session?.user
    return user && !user.guest ? user : undefined
  }

  private joinRoom() {
    if (!this.session?.realtime) return
    const guest = readGuest()
    const identity = this.account() ?? (guest ? { id: `guest:${guest.id}`, name: `${guest.name} (guest)` } : this.session.user ?? undefined)
    const room = connectRealtimeRoom(commentsRealtimeDefinition, commentRoom(this.page), { identity, changes: true })
    room.onUpdate(() => {
      this.renderToolbar()
      this.schedule()
    })
    room.onChange((change) => {
      if ("path" in change && change.path === commentRoom(this.page)) void this.load()
    })
    this.room = room
  }

  /** Tells the other people on this page that its threads changed. They read them again. */
  private changed() {
    this.room?.notify({ operation: "update", path: commentRoom(this.page) })
  }

  private failed(error: CommentsApiError) {
    this.showToast(error.fix ? `${error.why} ${error.fix}` : error.why, "error")
  }

  private ensureAuthor(nameInput?: HTMLInputElement): boolean {
    if (this.session?.user) return true
    if (readGuest()) return true
    const name = nameInput?.value.trim()
    if (!name) {
      nameInput?.focus()
      return false
    }
    saveGuest(name)
    return true
  }

  private async create(body: string, mentions: CommentMention[], nameInput?: HTMLInputElement) {
    if (!this.draft || !this.ensureAuthor(nameInput)) return
    const [error, thread] = await api.create({ page: this.page, anchor: this.draft.anchor, context: this.draft.context, body, mentions: keptMentions(body, mentions) })
    if (error) return this.failed(error)
    this.threads = [thread, ...this.threads]
    this.draft = undefined
    this.openThread = thread.id
    this.changed()
    this.renderToolbar()
    this.render()
  }

  private async reply(thread: PageThread, body: string, mentions: CommentMention[], nameInput?: HTMLInputElement) {
    if (!this.ensureAuthor(nameInput)) return
    const [error, comment] = await api.reply(thread.id, { body, mentions: keptMentions(body, mentions) })
    if (error) return this.failed(error)
    thread.comments.push(comment)
    this.changed()
    this.render()
  }

  private async setStatus(thread: PageThread, resolve: boolean) {
    const [error, updated] = resolve ? await api.resolve(thread.id) : await api.reopen(thread.id)
    if (error) return this.failed(error)
    this.threads = this.threads.map(candidate => candidate.id === thread.id ? updated : candidate)
    if (resolve && !this.showResolved) this.openThread = undefined
    this.changed()
    this.renderToolbar()
    this.render()
  }

  private async removeComment(thread: PageThread, commentId: string) {
    const first = thread.comments[0]?.id === commentId
    const [error] = first ? await api.remove(thread.id) : await api.removeComment(thread.id, commentId)
    if (error) return this.failed(error)
    if (first) {
      this.threads = this.threads.filter(candidate => candidate.id !== thread.id)
      this.openThread = undefined
    }
    else thread.comments = thread.comments.filter(comment => comment.id !== commentId)
    this.changed()
    this.renderToolbar()
    this.render()
  }

  // Inline edits

  private async startEdit(element: HTMLElement) {
    await this.finishEdit(true)
    const field = element.getAttribute(fieldAttribute)
    if (!field) return
    const [error, value] = await api.field(field)
    if (error) return this.failed(error)
    if (!value.editable || value.value === null) {
      this.showToast("This field is not plain text. Edit it in the Console.", "info", { link: ["Open Content", "/_vitehub/content"] })
      return
    }
    this.editing = { element, field, digest: value.digest, original: element.textContent ?? "" }
    element.textContent = value.value
    element.setAttribute("data-vitehub-editing", "")
    element.contentEditable = "plaintext-only"
    if (element.contentEditable !== "plaintext-only") element.contentEditable = "true"
    element.focus()
    const range = document.createRange()
    range.selectNodeContents(element)
    getSelection()?.removeAllRanges()
    getSelection()?.addRange(range)
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault()
        void this.finishEdit(true)
      }
      if (event.key === "Escape") {
        event.preventDefault()
        event.stopPropagation()
        void this.finishEdit(false)
      }
    }
    const blur = () => void this.finishEdit(true)
    element.addEventListener("keydown", keydown)
    element.addEventListener("blur", blur, { once: true })
    this.editStop = () => {
      element.removeEventListener("keydown", keydown)
      element.removeEventListener("blur", blur)
    }
  }

  private async finishEdit(save: boolean) {
    const editing = this.editing
    if (!editing) return
    this.editing = undefined
    this.editStop?.()
    const { element, field, digest, original } = editing
    element.contentEditable = "inherit"
    element.removeAttribute("data-vitehub-editing")
    const value = (element.textContent ?? "").trim()
    if (!save || value === original.trim()) {
      element.textContent = original
      return
    }
    const [error] = await api.saveField({ field, value, ifDigest: digest })
    if (error) {
      element.textContent = original
      return this.failed(error)
    }
    this.drafted.add(field)
    this.showToast("Saved as a draft. Publish it in the Console.", "info", { link: ["Review and publish", "/_vitehub/content"] })
    this.schedule()
  }

  // Rendering

  private schedule() {
    cancelAnimationFrame(this.frame)
    this.frame = requestAnimationFrame(() => this.render())
  }

  private visibleThreads(): PageThread[] {
    return this.threads.filter(thread => this.showResolved || thread.status === "open")
  }

  private renderToolbar() {
    const session = this.session
    if (!session) return
    const open = this.threads.filter(thread => thread.status === "open").length
    const people = this.room?.people() ?? []
    const seen = new Set<string>()
    const avatars = people.filter(person => !seen.has(person.id) && seen.add(person.id)).slice(0, 5).map(person =>
      h("span", { className: "avatar", title: person.name, style: `background:${person.color}` }, person.image ? h("img", { src: person.image, alt: "" }) : initials(person.name)))
    const count = `${open} open ${open === 1 ? "thread" : "threads"}`
    this.toolbar.replaceChildren(...present(
      session.can.comment && h("button", { className: "tool", "aria-pressed": String(this.mode === "comment"), title: "Comment (C)", onClick: () => this.setMode(this.mode === "comment" ? "view" : "comment") }, icons.comment(), "Comment", h("kbd", {}, "C")),
      session.content && h("button", { className: "tool", "aria-pressed": String(this.mode === "edit"), title: "Edit text (E)", onClick: () => this.setMode(this.mode === "edit" ? "view" : "edit") }, icons.edit(), "Edit", h("kbd", {}, "E")),
      h("span", { className: "sep" }),
      h("button", { className: "tool", "aria-pressed": String(this.panel), title: "Comments on this page", "aria-label": `Comments on this page, ${count}`, onClick: () => {
        this.panel = !this.panel
        this.renderToolbar()
        this.render()
      } }, icons.list(), String(open)),
      avatars.length > 0 && h("span", { className: "people", "aria-label": `${people.length} on this page` }, ...avatars),
      h("span", { className: "sep" }),
      h("button", { className: "tool square", title: "Leave comment mode", "aria-label": "Leave comment mode", onClick: () => this.exit() }, icons.close()),
    ))
  }

  private render() {
    if (!this.session) return
    this.renderPins()
    this.renderCursors()
    this.renderFloating()
  }

  private renderPins() {
    const nodes: Node[] = []
    const taken: Array<{ x: number, y: number }> = []
    const visible = this.visibleThreads()
    visible.forEach((thread, index) => {
      const placed = placeAnchor(thread.anchor)
      if (placed.state === "hidden") return
      // Threads on the same spot fan out, so each pin stays clickable.
      while (taken.some(point => Math.abs(point.x - placed.x) < 20 && Math.abs(point.y - placed.y) < 20)) placed.x += 22
      taken.push({ x: placed.x, y: placed.y })
      if (placed.x < -40 || placed.y < -40 || placed.x > innerWidth + 40 || placed.y > innerHeight + 40) return
      const state = thread.status === "resolved" ? "resolved" : placed.state === "moved" ? "moved" : "open"
      const author = thread.comments[0]?.author ?? thread.createdBy
      // Reuse each pin's element, so a click that starts during a re-render still lands on the same button.
      let pin = this.pinElements.get(thread.id)
      if (!pin) {
        pin = h("div", { className: "pin" }, h("button", {
          className: "pin-button",
          onClick: (event: MouseEvent) => {
            event.stopPropagation()
            this.draft = undefined
            this.openThread = this.openThread === thread.id ? undefined : thread.id
            this.render()
          },
        }))
        this.pinElements.set(thread.id, pin)
      }
      const button = pin.firstElementChild!
      pin.dataset.state = state
      ;(button as HTMLElement).style.background = colorOf(author.id)
      pin.dataset.open = String(this.openThread === thread.id)
      pin.style.left = `${placed.x}px`
      pin.style.top = `${placed.y}px`
      button.setAttribute("title", `${author.name}: ${thread.comments[0]?.body ?? ""}${state === "moved" ? " (the element moved)" : ""}`)
      button.setAttribute("aria-label", `Thread ${index + 1} by ${author.name}`)
      button.textContent = initials(author.name)
      nodes.push(pin)
    })
    if (this.draft) {
      // Where the new comment will sit, until it is sent or dropped.
      const me = this.session?.user ?? { id: "guest", name: readGuest()?.name ?? "You" }
      nodes.push(h("div", { className: "pin", "data-state": "draft", style: `left:${this.draft.x}px;top:${this.draft.y}px` },
        h("span", { className: "pin-button", style: `background:${colorOf(me.id)}`, "aria-hidden": "true" }, initials(me.name))))
    }
    for (const id of this.pinElements.keys()) {
      if (!this.threads.some(thread => thread.id === id)) this.pinElements.delete(id)
    }
    const outlines: Node[] = []
    if (this.mode === "edit") {
      for (const element of document.querySelectorAll(`[${fieldAttribute}]`)) {
        const field = element.getAttribute(fieldAttribute)!
        const kind = element === this.hover ? "hover" : this.drafted.has(field) ? "draft" : undefined
        if (!kind) continue
        const box = element.getBoundingClientRect()
        outlines.push(h("div", { className: "outline", "data-kind": kind, style: `left:${box.left - 3}px;top:${box.top - 3}px;width:${box.width + 6}px;height:${box.height + 6}px` }))
        outlines.push(h("div", { className: "tag", style: `left:${box.left - 3}px;top:${box.top - 3}px` }, kind === "draft" ? "Draft" : field))
      }
    }
    this.outlines.replaceChildren(...outlines)
    // Move, add, and remove pins without replacing the ones that stay.
    // A copy, because removing children from the live collection while iterating it skips some.
    for (const child of Array.from(this.pins.children)) {
      if (!nodes.includes(child)) child.remove()
    }
    nodes.forEach((node, index) => {
      if (this.pins.children[index] !== node) this.pins.insertBefore(node, this.pins.children[index] ?? null)
    })
  }

  private renderCursors() {
    const nodes: Node[] = []
    for (const [, state] of this.room?.states() ?? []) {
      const cursor = state.cursor as Cursor | undefined
      const user = state.user as { name?: string, id?: string, color?: string } | undefined
      if (!cursor || !user?.id || user.id === this.session?.user?.id) continue
      let element: Element | null = null
      try {
        element = document.querySelector(cursor.selector)
      }
      catch {}
      if (!element) continue
      const box = element.getBoundingClientRect()
      const x = box.left + (cursor.x / 1000) * box.width
      const y = box.top + (cursor.y / 1000) * box.height
      const color = user.color ?? colorOf(user.id)
      const arrow = svg(`<path d="M4 2l16 7-7 2-3 8z" fill="${color}" stroke="#000" stroke-width="1.5"/>`)
      nodes.push(h("div", { className: "cursor", style: `left:${x}px;top:${y}px` }, arrow, h("span", { style: `background:${color}` }, user.name ?? "Someone")))
    }
    this.cursors.replaceChildren(...nodes)
  }

  private place(card: HTMLElement, x: number, y: number) {
    // Beside the pin, with its top edge at the pin's top: on the right, or on the left when the window edge or the open
    // panel leaves no room.
    const right = innerWidth - (this.panel ? 16 + 340 + 12 : 8)
    const left = Math.max(8, x + 24 + 320 <= right ? x + 24 : Math.min(x - 24 - 320, right - 320))
    const top = Math.min(Math.max(8, y - 14), innerHeight - 200)
    card.style.left = `${left}px`
    card.style.top = `${top}px`
  }

  private renderFloating() {
    const nodes: Node[] = []
    if (this.panel) nodes.push(this.renderPanel())
    if (this.draft) {
      const card = this.renderComposer()
      this.place(card, this.draft.x, this.draft.y)
      nodes.push(card)
    }
    const thread = this.threads.find(candidate => candidate.id === this.openThread)
    if (thread) {
      const placed = placeAnchor(thread.anchor)
      const card = this.renderThread(thread)
      if (placed.state !== "hidden") this.place(card, placed.x, placed.y)
      else this.place(card, innerWidth / 2, innerHeight / 3)
      nodes.push(card)
    }
    if (this.toast) nodes.push(this.toast)
    // Keep focus and typed text: only replace the cards when what they show changed.
    const key = JSON.stringify([this.panel, this.showResolved, this.draft?.anchor, thread?.id, thread?.status, thread?.comments.length, this.threads.length, Boolean(this.toast)])
    if (this.floating.dataset.key === key) {
      for (const card of this.floating.querySelectorAll<HTMLElement>(".card")) {
        const fresh = nodes.find((node): node is HTMLElement => node instanceof HTMLElement && node.dataset.card === card.dataset.card)
        if (fresh) {
          card.style.left = fresh.style.left
          card.style.top = fresh.style.top
        }
      }
      return
    }
    this.floating.dataset.key = key
    // Only a card that was not on screen before plays its enter animation, so a new reply does not replay it.
    const shown = new Set(Array.from(this.floating.querySelectorAll<HTMLElement>("[data-card]"), card => card.dataset.card))
    for (const node of nodes) {
      if (node instanceof HTMLElement && (this.floating.contains(node) || shown.has(node.dataset.card))) node.dataset.static = ""
    }
    this.floating.replaceChildren(...nodes)
    this.floating.querySelector<HTMLTextAreaElement>("textarea[data-autofocus]")?.focus()
  }

  private renderPanel(): HTMLElement {
    const threads = this.visibleThreads()
    return h("div", { className: "panel", role: "dialog", "aria-labelledby": "vitehub-comments-panel-title", "data-card": "panel" },
      h("div", { className: "panel-head" },
        h("div", { className: "title" },
          h("h2", { id: "vitehub-comments-panel-title" }, "Comments"),
          h("div", { className: "page", title: this.page }, this.page)),
        h("button", { className: "switch", role: "switch", "aria-checked": String(this.showResolved), onClick: () => {
          this.showResolved = !this.showResolved
          this.render()
        } }, "Show resolved", h("span", { className: "track", "aria-hidden": "true" })),
        h("button", { className: "icon", "aria-label": "Close comments", title: "Close", onClick: () => {
          this.panel = false
          this.renderToolbar()
          this.render()
        } }, icons.close())),
      threads.length
        ? h("div", { className: "panel-list" }, ...threads.map((thread) => {
            const first = thread.comments[0]
            const author = first?.author ?? thread.createdBy
            const placed = placeAnchor(thread.anchor)
            const replies = thread.comments.length - 1
            return h("button", { className: "panel-item", "data-state": thread.status, "aria-current": String(this.openThread === thread.id), onClick: () => {
              this.openThread = thread.id
              if (placed.state === "exact") placed.element.scrollIntoView({ block: "center", behavior: "smooth" })
              this.render()
            } },
            avatar(author),
            h("div", { className: "top" }, h("span", { className: "name" }, author.name), h("span", { className: "time" }, ago(thread.updatedAt))),
            h("div", { className: "excerpt" }, first?.body ?? ""),
            (replies > 0 || thread.status === "resolved" || placed.state === "moved") && h("div", { className: "meta" },
              replies > 0 && h("span", {}, `${replies} ${replies === 1 ? "reply" : "replies"}`),
              thread.status === "resolved" && h("span", {}, "Resolved"),
              placed.state === "moved" && h("span", {}, "The element moved")))
          }))
        : h("div", { className: "empty" },
            h("strong", {}, this.showResolved ? "No comments on this page" : "No open comments"),
            this.session?.can.comment ? h("span", {}, "Press C, then click anything on the page.") : null))
  }

  private renderThread(thread: PageThread): HTMLElement {
    const session = this.session!
    const me = this.account()?.id ?? (readGuest() ? `guest:${readGuest()!.id}` : undefined)
    const resolved = thread.status === "resolved"
    const card = h("div", { className: "card", role: "dialog", "aria-label": "Comment thread", "data-card": `thread-${thread.id}` },
      h("div", { className: "card-head" },
        h("span", { className: "grow" }, thread.anchor.field ? `On ${thread.anchor.field}` : resolved ? `Resolved by ${thread.resolvedBy?.name ?? "someone"}` : `${thread.comments.length} ${thread.comments.length === 1 ? "comment" : "comments"}`),
        session.can.resolve && h("button", { className: "icon", title: resolved ? "Reopen" : "Resolve", "aria-label": resolved ? "Reopen" : "Resolve", onClick: () => void this.setStatus(thread, !resolved) }, resolved ? icons.reopen() : icons.check()),
        h("button", { className: "icon", "aria-label": "Close", onClick: () => {
          this.openThread = undefined
          this.render()
        } }, icons.close())),
      h("div", { className: "messages" }, ...thread.comments.map(comment => h("div", { className: "message" },
        avatar(comment.author),
        h("div", { className: "message-head" },
          h("span", { className: "name" }, comment.author.guest ? `${comment.author.name} (guest)` : comment.author.name),
          h("time", { className: "time", datetime: comment.createdAt, title: new Date(comment.createdAt).toLocaleString() }, ago(comment.createdAt)),
          (comment.author.id === me || session.can.resolve) && h("button", { className: "icon danger", title: "Delete", "aria-label": "Delete comment", onClick: () => void this.removeComment(thread, comment.id) }, icons.trash())),
        renderBody(comment.body, comment.mentions)))),
      !resolved && session.can.comment && this.renderCompose("Reply", (body, mentions, name) => this.reply(thread, body, mentions, name)),
    )
    return card
  }

  private renderComposer(): HTMLElement {
    return h("div", { className: "card", role: "dialog", "aria-label": "New comment", "data-card": "new" },
      this.renderCompose("Comment", (body, mentions, name) => this.create(body, mentions, name), true))
  }

  /** A text box with `@` suggestions, and a name field for guests. */
  private renderCompose(label: string, submit: (body: string, mentions: CommentMention[], name?: HTMLInputElement) => Promise<void>, autofocus = false): HTMLElement {
    const mentions: CommentMention[] = []
    const needsName = !this.account() && !readGuest()
    const name = needsName ? h("input", { placeholder: "Your name", "aria-label": "Your name", maxlength: 64 }) : undefined
    const input = h("textarea", { placeholder: this.account() || readGuest() ? `${label}… Use @ to mention` : `${label}…`, "aria-label": label, "data-autofocus": autofocus || undefined, maxlength: 4000 })
    const button = h("button", { className: "primary", disabled: true }, label)
    const suggest = h("div", { className: "suggest", role: "listbox", hidden: true })
    let options: CommentMention[] = []
    let selected = 0
    let query: { start: number, text: string } | undefined

    const send = async () => {
      const body = input.value.trim()
      if (!body) return
      button.disabled = true
      await submit(body, mentions, name)
      button.disabled = false
    }
    const pick = (person: CommentMention) => {
      if (!query) return
      const before = input.value.slice(0, query.start)
      const after = input.value.slice(input.selectionStart)
      input.value = `${before}@${person.name} ${after}`
      mentions.push(person)
      query = undefined
      suggest.hidden = true
      input.focus()
    }
    const showOptions = () => {
      suggest.hidden = !options.length
      suggest.replaceChildren(...options.map((person, index) => h("button", { role: "option", "aria-selected": String(index === selected), onMousedown: (event: MouseEvent) => {
        event.preventDefault()
        pick(person)
      } }, avatar(person), person.name)))
    }
    input.addEventListener("input", async () => {
      button.disabled = !input.value.trim()
      const before = input.value.slice(0, input.selectionStart)
      const match = /(^|\s)@([^\s@]{0,32})$/.exec(before)
      if (!match) {
        query = undefined
        suggest.hidden = true
        return
      }
      query = { start: before.length - match[2]!.length - 1, text: match[2]! }
      const [error, people] = await api.people(match[2]!)
      if (error || query?.text !== match[2]) return
      options = people
      selected = 0
      showOptions()
    })
    input.addEventListener("keydown", (event) => {
      if (!suggest.hidden && options.length) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault()
          selected = (selected + (event.key === "ArrowDown" ? 1 : options.length - 1)) % options.length
          showOptions()
          return
        }
        if (event.key === "Enter" || event.key === "Tab") {
          event.preventDefault()
          pick(options[selected]!)
          return
        }
      }
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        void send()
      }
    })
    button.addEventListener("click", () => void send())
    return h("div", { className: "compose" }, suggest, name, input, h("div", { className: "row" }, h("span", { className: "hint" }, `${/Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘" : "Ctrl"} Enter to send`), button))
  }

  private showToast(text: string, kind: "error" | "info", options: { keep?: boolean, link?: [string, string], action?: [string, () => void] } = {}) {
    clearTimeout(this.toastTimer)
    this.toast = h("div", { className: "toast", role: "status", "data-kind": kind },
      h("span", {}, text),
      options.link && h("a", { href: options.link[1] }, options.link[0]),
      options.action && h("button", { className: "secondary", onClick: options.action[1] }, options.action[0]))
    if (!this.session) this.floating.replaceChildren(this.toast)
    else this.render()
    if (!options.keep) {
      this.toastTimer = setTimeout(() => {
        this.toast = undefined
        this.render()
      }, kind === "error" ? 8000 : 5000)
    }
  }

  /** Turns the page tools off on every page, through the loader, then removes the overlay. */
  private exit() {
    void this.finishEdit(false)
    this.setMode("view")
    this.context?.exit()
    this.remove()
  }
}

/**
 * The `comments` page tool: the page tools loader calls it for people that may read comments. It mounts the
 * `<vitehub-comments>` element and returns its cleanup. The toolbar always shows, so `context.open` changes nothing.
 */
const start: ViteHubPageToolModule["default"] = (context) => {
  if (!customElements.get("vitehub-comments")) customElements.define("vitehub-comments", CommentsOverlay)
  const overlay = document.createElement("vitehub-comments")
  if (overlay instanceof CommentsOverlay) overlay.context = context
  document.body.append(overlay)
  return () => overlay.remove()
}

export default start
