import { CommentLayer, CommentPanel } from "@vite-hub/ui/comments"
import { useComments } from "@vite-hub/ui/headless"
import { registerStandaloneUI, UButton } from "@vite-hub/ui/standalone/nuxt-ui"
import standaloneCss from "@vite-hub/ui/standalone/styles.css?inline"
import uiCss from "@vite-hub/ui/styles.css?inline"
import { computed, createApp, defineComponent, h, nextTick, ref, shallowRef, Teleport, toRaw, watch } from "vue"

import { createAnchor, fieldAttribute, fieldElementOf, selectorOf } from "../anchor.ts"
import { anchorRange, createCommentsClient } from "../client.ts"
import { commentRoom, commentsApiRoute, commentsRealtimeDefinition, commentsRoute, normalizeCommentPage } from "../page.ts"
import { base64, createOverlayTransport, readGuest, saveGuest } from "./api.ts"
import { captureContext } from "./context.ts"
import { createInlineEdit } from "./edit.ts"
import { overlayStyles, panelStyles } from "./styles.ts"

import type { ViteHubPageToolContext } from "@vite-hub/internal/runtime/page-tools-loader"
import type { RealtimeRoom } from "@vite-hub/realtime/client"
import type { CommentCan } from "@vite-hub/ui/headless"
import type { App, VNode } from "vue"
import type { RestCommentThread } from "../rest-transport.ts"
import type { CommentAnchor, CommentContext, CommentEvent, CommentMessage, CommentStatus, CommentThread, CommentUser } from "../types.ts"
import type { CommentsApiError, CommentsSession } from "./api.ts"

interface Cursor {
  selector: string
  x: number
  y: number
}

/** Text that the reader selected on the page, and where it is, in client coordinates. */
interface Selected {
  left: number
  top: number
  bottom: number
}

/** The names of the CSS highlights of commented text. `documentStyles` colors them. */
export const highlightNames = { open: "vitehub-comment", resolved: "vitehub-comment-resolved", active: "vitehub-comment-active" } as const

interface Toast {
  text: string
  kind: "error" | "info"
  link?: [string, string]
  action?: [string, () => void]
}

export interface OverlayAppOptions {
  /** The overlay element. Its shadow root holds the pins, the cards, and the cursors. */
  host: HTMLElement
  /** The page tools context, or undefined in tests that mount the overlay alone. */
  context?: ViteHubPageToolContext
  /** The tool's segment of the pill, where the toolbar goes. */
  toolbar?: HTMLElement
  /** Where the areas of threads go, under the page's floating controls. Without it they stay in the overlay. */
  areas?: ShadowRoot
  /** The answer of `/session`. Undefined when it failed: `failure` says why. */
  session?: CommentsSession
  failure?: CommentsApiError
  /** Sets the `vitehub-<mode>-mode` class on `<html>`, for page styles. */
  onMode: (mode: Mode) => void
  /** Turns the page tools off on every page. */
  exit: () => void
  /**
   * Whether to say at once why the person cannot comment, because they opened the tool. Without it, a page load stays
   * quiet until `promptAccess()`.
   */
  prompt?: boolean
}

export type Mode = "view" | "comment" | "edit"

/** What the overlay element calls: it owns the document listeners and the page tools hooks. */
export interface OverlayControl {
  app: App
  /** Whether a box holds text that was not sent. */
  hasUnsentComment: () => boolean
  showPanel: () => void
  setMode: (mode: Mode) => void
  /** Saves or drops the inline edit, when one is open. */
  finishEdit: (save: boolean) => Promise<void>
  /** The router went to another page, as a normalized comment page. */
  navigated: (page: string) => void
  /** Reads the threads again, for polling and a tab that becomes visible. */
  refresh: () => void
  /** The pointer moved over `target` of the page: presence cursors and the hover outline of edit mode. */
  pointer: (event: PointerEvent, target: Element | undefined) => void
  leave: () => void
  /** The page scrolled, resized, or changed, so cursors and outlines move. */
  layout: () => void
  /** The selection of the page changed, so the bar over selected text shows, moves, or goes. */
  selectionChanged: () => void
  /** Says why the person cannot comment, such as **Sign in with GitHub**, when they cannot. */
  promptAccess: () => void
  editMode: () => boolean
  editElement: () => HTMLElement | undefined
  startEdit: (element: HTMLElement) => Promise<void>
  key: (event: KeyboardEvent) => void
  destroy: () => void
}

/**
 * The stylesheet of a shadow root: the overlay's own rules, which reset the host first, then the UI's parts and the
 * stand-ins, which set its font and color. The parts' rules are in layers, so the overlay's rules still win. `:root`
 * becomes `:host`.
 */
export const shadowCss = (extra: string) => `${extra}\n${uiCss.replaceAll(":root.dark", ":host(.dark)").replaceAll(":root", ":host")}\n${standaloneCss}`

function style(text: string): HTMLStyleElement {
  const element = document.createElement("style")
  element.textContent = text
  return element
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

/** Follows the host's theme classes, `data-theme`, or `color-scheme`, then the system preference. */
export function hostIsDark(): boolean {
  const root = document.documentElement
  if (root.classList.contains("dark")) return true
  if (root.classList.contains("light")) return false
  if (root.dataset.theme === "dark") return true
  if (root.dataset.theme === "light") return false
  const scheme = getComputedStyle(root).colorScheme
  if (scheme === "dark") return true
  if (scheme === "light") return false
  return matchMedia("(prefers-color-scheme: dark)").matches
}

function isTyping(event: KeyboardEvent): boolean {
  const target = event.composedPath()[0]
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
}

const commentIcon = () => h("svg", { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" }, h("path", { d: "M7.9 20A9 9 0 1 0 4 16.1L2 22Z" }))

const listIcon = () => h("svg", { width: 15, height: 15, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" }, h("path", { d: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" }))

/** Elements of the overlay, the pill, and its windows. Anchors skip them, as they skip the comment parts. */
function ignored(element: Element): boolean {
  for (let node: Element | null = element; node;) {
    if (node.closest("[data-comments-ui], vitehub-pill, vitehub-window")) return true
    const root = node.getRootNode()
    node = root instanceof ShadowRoot ? root.host : null
  }
  return false
}

/**
 * Mounts the comment parts of `@vite-hub/ui` in the overlay's shadow root: `CommentLayer` for the pins, the cards, and
 * comment mode, `CommentPanel` in the pill's window, and the toolbar in the pill. The overlay adds what is not about
 * comment threads: presence, guests' names, inline Content edits, toasts, and the GitHub sign-in.
 */
export function mountOverlay(options: OverlayAppOptions): OverlayControl {
  const { host, context, session } = options
  const shadow = host.shadowRoot!
  const root = document.createElement("div")
  root.className = "root"
  shadow.replaceChildren(style(shadowCss(overlayStyles)), root)

  const page = ref(normalizeCommentPage(location.pathname))
  const search = ref(location.search)
  const toast = shallowRef<Toast>()
  const panelOpen = ref(false)
  const panelTarget = shallowRef<HTMLElement>()
  const editing = ref(false)
  const hover = shallowRef<Element>()
  const drafted = ref(new Set<string>())
  const naming = ref(false)
  /** The text a first-time guest selected before the name card took the focus, so the comment starts on it after. */
  let namedQuote: Range | undefined
  const guest = ref(readGuest())
  const tick = ref(0)
  const known = shallowRef<readonly CommentUser[]>([])
  const panelStatus = ref<CommentStatus>("open")
  const panelThread = ref<string | null>(null)
  const selected = shallowRef<Selected>()
  let room: RealtimeRoom | undefined
  // Counts the joins, so a join whose Realtime client loads after a newer join or `destroy()` drops itself.
  let joins = 0
  let pageWindow: ReturnType<ViteHubPageToolContext["createWindow"]> | undefined
  let toastTimer: ReturnType<typeof setTimeout> | undefined
  const listeners = new Set<(event: CommentEvent) => void>()
  const contexts = new WeakMap<CommentAnchor, CommentContext>()

  const showToast = (next: Toast, keep = false) => {
    clearTimeout(toastTimer)
    toast.value = next
    if (!keep) toastTimer = setTimeout(() => (toast.value = undefined), next.kind === "error" ? 8000 : 5000)
  }
  const failed = (error: CommentsApiError) => showToast({ text: error.fix ? `${error.why} ${error.fix}` : error.why, kind: "error" })

  /** The server-identified person. Only the unnamed Console placeholder needs a browser guest identity. */
  const account = (): CommentUser | undefined => {
    const user = session?.user
    return user && !(user.guest && user.id === "guest:console") ? user : undefined
  }
  const me = computed<CommentUser | undefined>(() => account() ?? (guest.value ? { id: `guest:${guest.value.id}`, name: guest.value.name, guest: true } : undefined))
  const canComment = Boolean(session?.can.comment)
  const needsName = computed(() => canComment && !me.value)

  /**
   * What this person may do in a thread, for the parts' controls. Each thread from the API carries `can` for its own
   * policy check, and the session's answer stands in until it does. The server checks every change again.
   */
  const can: CommentCan = (action, { thread, message }) => {
    const user = me.value
    if (!user || needsName.value) return false
    const allowed = (thread as RestCommentThread).can ?? { comment: canComment, resolve: Boolean(session?.can.resolve), delete: Boolean(session?.can.delete) }
    if (action === "reply") return thread.status === "open" && allowed.comment
    if (action === "resolve") return allowed.resolve
    // A guest id proves nothing, so a guest owns no message.
    const own = (entry: CommentMessage) => !user.guest && !entry.author.guest && entry.author.id === user.id
    if (!message) return false
    if (action === "edit") return own(message)
    // People delete their own messages, and a thread when every message in it is theirs. Moderators, with `delete`,
    // delete anyone's.
    const owns = thread.messages[0]?.id === message.id ? thread.messages.every(own) : own(message)
    return owns ? allowed.comment : allowed.delete === true && !user.guest
  }

  const transport = createOverlayTransport({
    contextOf: input => contexts.get(input.anchor) ?? captureContext(undefined),
    onPeople(people) {
      const next = new Map(known.value.map(person => [person.id, person]))
      for (const person of people) next.set(person.id, person)
      known.value = [...next.values()]
    },
    onChange: () => room?.setLocal("commentsChange", crypto.randomUUID()),
  })
  const client = createCommentsClient({
    transport: {
      ...transport,
      // Realtime tells this page when someone else changed its threads, and polling covers the server API.
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    ...(account() ? { user: account()! } : {}),
  })
  const refresh = () => {
    for (const listener of listeners) listener({ type: "reconnected" })
  }
  const upload = async (files: File[]) => await Promise.all(files.map(async file =>
    (await transport.upload({ name: file.name, type: file.type, data: await base64(file), subject: { kind: "page", id: page.value } })).key))

  const edit = createInlineEdit({
    page: () => page.value,
    openTool: async path => await context?.openTool("content", path) ?? false,
    contentPath: () => `${commentsApiRoute(import.meta.url).slice(0, -commentsRoute.length)}/_vitehub/content`,
    info: (text, link) => showToast({ text, kind: "info", link }),
    failed,
    drafted(field) {
      drafted.value = new Set([...drafted.value, field])
    },
  })

  let state!: ReturnType<typeof useComments>

  function setMode(next: Mode) {
    if (next === "comment") {
      if (!canComment) return
      if (needsName.value) {
        namedQuote = undefined
        naming.value = true
        return
      }
      void edit.finish(true)
      editing.value = false
      state.enter()
    }
    else if (next === "edit") {
      if (!session?.content || !canComment) return
      state.exit()
      if (state.active.value) return
      editing.value = true
    }
    else {
      state.exit()
      editing.value = false
      void edit.finish(true)
    }
    hover.value = undefined
  }
  const mode = computed<Mode>(() => editing.value ? "edit" : state?.active.value ? "comment" : "view")

  // The Realtime client, with Yjs, is a chunk of its own: only a site with presence loads it, after the threads.
  async function joinRoom(reconnect = false) {
    if (!session?.realtime || !host.isConnected || context?.signal.aborted || (room && !reconnect)) return
    const join = ++joins
    // Presence is extra: when its chunk does not load, the comments still work without it.
    const realtime = await import("@vite-hub/realtime/client").catch(() => undefined)
    if (!realtime || join !== joins || !host.isConnected || context?.signal.aborted) return
    room?.destroy()
    const identity = account() ?? (guest.value ? { id: `guest:${guest.value.id}`, name: `${guest.value.name} (guest)` } : undefined)
    const baseURL = commentsApiRoute(import.meta.url).slice(0, -commentsRoute.length)
    const joined = realtime.connectRealtimeRoom(commentsRealtimeDefinition, commentRoom(page.value), { identity, baseURL, params: { page: page.value } })
    let changes = new Map<number, string>()
    joined.onUpdate(() => {
      tick.value++
      const next = new Map<number, string>()
      let changed = false
      for (const [id, state] of joined.states()) {
        if (id === joined.clientId || typeof state.commentsChange !== "string") continue
        next.set(id, state.commentsChange)
        if (changes.get(id) !== state.commentsChange) changed = true
      }
      changes = next
      if (changed) refresh()
    })
    room = joined
  }
  function leaveRoom() {
    joins++
    room?.destroy()
    room = undefined
  }

  function showPanel() {
    if (!context) return
    if (!pageWindow) {
      pageWindow = context.createWindow({
        id: "comments", title: "Comments", trigger: context.bar, colorScheme: () => "dark",
        onHide: () => (panelOpen.value = false),
      })
      const panelHost = document.createElement("div")
      panelHost.setAttribute("data-comments-ui", "")
      const panelShadow = panelHost.attachShadow({ mode: "open" })
      const target = document.createElement("div")
      target.className = "panel-root dark"
      panelShadow.append(style(shadowCss(panelStyles)), target)
      pageWindow.body.append(panelHost)
      panelTarget.value = target
    }
    panelOpen.value = true
    pageWindow.show()
  }

  function nameGuest(name: string) {
    guest.value = saveGuest(name)
    naming.value = false
    void joinRoom(true)
    const quote = namedQuote
    namedQuote = undefined
    if (quote?.startContainer.isConnected) {
      const selection = getSelection()
      selection?.removeAllRanges()
      selection?.addRange(quote)
      if (commentOnSelection()) return
    }
    setMode("comment")
  }

  async function signOut(url: string) {
    await fetch(url, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => undefined)
    location.reload()
  }

  /** Why this person cannot comment, with **Sign in with GitHub** when the site offers it. */
  function denied(current: CommentsSession) {
    const signIn = current.signIn && `${current.signIn.url}?return=${encodeURIComponent(location.pathname + location.search + location.hash)}`
    const github = current.github
    if (github && current.signOut) {
      const url = current.signOut
      const text = github.repository
        ? `@${github.login} cannot push to ${github.repository}, so cannot comment here.`
        : `Signed in as @${github.login}, but this site does not say which GitHub repository it is built from.`
      showToast({ text, kind: "error", action: ["Use another account", () => void signOut(url)] }, true)
    }
    else if (signIn) showToast({ text: "Sign in to comment on this page.", kind: "info", link: ["Sign in with GitHub", signIn], action: ["Close", options.exit] }, true)
    else showToast({ text: "Comments are only for the site's team. Sign in with an account that may comment.", kind: "error", action: ["Close", options.exit] }, true)
  }

  /** The text that the reader selected on the page, when they may comment on it. */
  function pageSelection(): Selection | undefined {
    const selection = getSelection()
    if (!canComment || editing.value || !selection || selection.isCollapsed || selection.rangeCount === 0 || !selection.toString().trim()) return
    const container = selection.getRangeAt(0).commonAncestorContainer
    const element = container instanceof Element ? container : container.parentElement
    if (!element?.isConnected || ignored(element) || element.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) return
    return selection
  }
  /** Shows or moves the bar over the selected text. */
  function trackSelection() {
    const selection = state?.draft.value ? undefined : pageSelection()
    const rect = selection?.getRangeAt(0).getBoundingClientRect()
    selected.value = rect && (rect.width || rect.height) ? { left: rect.left + rect.width / 2, top: rect.top, bottom: rect.bottom } : undefined
  }
  /** Starts a comment on the selected text, as Drop does: the composer opens at the end of the quote. */
  function commentOnSelection(): boolean {
    const selection = pageSelection()
    if (!selection) return false
    if (needsName.value) {
      namedQuote = selection.getRangeAt(0).cloneRange()
      naming.value = true
      return true
    }
    void edit.finish(true)
    const rect = selection.getRangeAt(0).getBoundingClientRect()
    try {
      state.startDraft(selection, { point: { x: rect.right, y: rect.top } })
      selection.removeAllRanges()
    }
    catch {
      return false
    }
    selected.value = undefined
    return true
  }

  /**
   * Colors the commented text with the CSS Custom Highlight API, so the page's DOM stays as it is: open threads, resolved
   * ones when they show, and the thread that is open, hovered, or being written, darker.
   */
  const highlights = typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight === "function"
  function paintHighlights() {
    if (!highlights) return
    const groups = { open: [] as Range[], resolved: [] as Range[], active: [] as Range[] }
    const active = new Set([state.openId.value, state.hoverId.value].filter(Boolean))
    const threads: CommentThread[] = [...state.pageThreads.value]
    const opened = state.opened.value
    if (opened && opened.subject.id === page.value && !threads.includes(opened)) threads.push(opened)
    for (const thread of threads) {
      if (thread.anchor.kind !== "text") continue
      const range = anchorRange(thread.anchor)
      if (range) groups[active.has(thread.id) ? "active" : thread.status === "resolved" ? "resolved" : "open"].push(range)
    }
    const draft = state.draft.value?.anchor
    if (draft?.kind === "text") {
      const range = anchorRange(toRaw(draft))
      if (range) groups.active.push(range)
    }
    for (const [group, name] of Object.entries(highlightNames)) CSS.highlights.set(name, new Highlight(...groups[group as keyof typeof groups]))
  }
  function clearHighlights() {
    if (highlights) for (const name of Object.values(highlightNames)) CSS.highlights.delete(name)
  }

  const NameCard = defineComponent({
    setup() {
      const input = ref<HTMLInputElement | null>(null)
      void nextTick(() => input.value?.focus())
      const submit = (event: Event) => {
        event.preventDefault()
        const value = input.value?.value.trim()
        if (value) nameGuest(value)
        else input.value?.focus()
      }
      return () => h("form", { class: "card", role: "dialog", "aria-label": "Your name", onSubmit: submit, onKeydown: (event: KeyboardEvent) => event.key === "Escape" && (naming.value = false) }, [
        h("label", ["Your name", h("input", { "aria-label": "Your name", autocomplete: "name", maxlength: 64, placeholder: "Shown next to your comments", ref: input })]),
        h("div", { class: "row" }, [
          h(UButton, { color: "neutral", label: "Cancel", onClick: () => (naming.value = false), size: "sm", variant: "ghost" }),
          h(UButton, { label: "Comment", size: "sm", type: "submit" }),
        ]),
      ])
    },
  })

  const Overlay = defineComponent({
    name: "CommentsOverlay",
    setup() {
      state = useComments({
        client,
        subject: () => ({ kind: "page", id: page.value }),
        location: () => ({ href: location.href, origin: location.origin, search: search.value }),
        user: () => me.value,
        people: known,
        hotkey: false,
        ignore: ignored,
        can,
        uiRoot: () => shadow,
        autoStart: Boolean(session?.can.read),
      })
      // Page styles read the mode class at once, as the toolbar button changes it.
      watch(mode, value => options.onMode(value), { immediate: true, flush: "sync" })
      // Presence starts once the page's threads are listed, as on each new page.
      watch(() => state.status.value, (status) => {
        if (status === "ready" && !room) void joinRoom()
      })
      watch(() => state.counts.value.open, () => tick.value++)
      // The list's Open and Resolved switch also shows resolved pins, as Show resolved did.
      watch(panelStatus, (status) => {
        state.filters.resolved = status === "resolved"
      })
      watch(() => state.filters.resolved, (resolved) => {
        if (resolved) panelStatus.value = "resolved"
      })
      // A new comment keeps the hints of the overlay's anchors, such as the Content field and a fallback point, and
      // the page context: the element, its Vue components, and the browser.
      watch(() => state.draft.value, (draft) => {
        if (!draft || draft.anchor.kind === "page") return
        const target = document.elementsFromPoint(draft.point.x, draft.point.y).find(element => !ignored(element) && element !== document.documentElement)
        if (!target) return
        if (draft.anchor.kind === "element") draft.anchor = createAnchor(target, draft.point.x, draft.point.y)
        // The state sends the raw anchor, so the context is kept by it, not by its reactive proxy.
        contexts.set(toRaw(draft.anchor), captureContext(target))
      }, { flush: "sync" })
      // Positions change when the page scrolls, resizes, or changes, so the ranges are found again then too.
      watch([state.positions, state.pageThreads, state.openId, state.hoverId, () => state.draft.value?.anchor], paintHighlights, { flush: "post" })
      watch(() => state.draft.value, trackSelection)

      return () => {
        const nodes: Array<VNode | null> = []
        if (session?.can.read) {
          nodes.push(h(CommentLayer, { comments: state, readOnly: !me.value, upload: canComment ? upload : undefined, attachmentUrl: transport.attachmentUrl }, { default: () => [] }))
          nodes.push(h("div", { class: "cursors" }, cursors()))
          nodes.push(h("div", { class: "outlines" }, outlines()))
          nodes.push(options.areas ? h(Teleport, { to: options.areas }, areas()) : h("div", { class: "areas" }, areas()))
          const bar = selected.value
          if (bar && !state.draft.value) {
            const below = bar.top < 56
            nodes.push(h("div", {
              class: "selection-bar",
              "data-below": below ? "true" : undefined,
              role: "group",
              "aria-label": "Selected text",
              style: { left: `${Math.min(Math.max(64, bar.left), innerWidth - 64)}px`, top: `${below ? bar.bottom + 8 : bar.top - 8}px` },
              // A press here must not take the selection away from the page.
              onMousedown: (event: MouseEvent) => event.preventDefault(),
            }, h("button", { type: "button", "aria-keyshortcuts": "C", title: "Comment on the selected text (C)", onClick: commentOnSelection }, [commentIcon(), "Comment"])))
          }
          if (panelTarget.value) {
            nodes.push(h(Teleport, { to: panelTarget.value }, h(CommentPanel, {
              key: page.value,
              comments: state,
              attachmentUrl: transport.attachmentUrl,
              readOnly: !me.value || (!state.threads.value.some(thread => thread.id === panelThread.value) && !canComment),
              "onUpdate:thread": (value: string | null) => (panelThread.value = value),
              status: panelStatus.value,
              "onUpdate:status": (value: CommentStatus) => (panelStatus.value = value),
              title: page.value,
              upload: canComment ? upload : undefined,
              // The thread opens in the list. Its spot on the page comes into view.
              onSelect: (thread: { id: string }) => {
                const position = state.positions.value.get(thread.id)
                if (position && !position.detached) position.element?.scrollIntoView({ block: "center", behavior: "smooth" })
              },
            })))
          }
          if (options.toolbar) nodes.push(h(Teleport, { to: options.toolbar }, toolbar()))
        }
        if (naming.value) nodes.push(h(NameCard))
        const current = toast.value
        if (current) {
          nodes.push(h("div", { class: "toast", role: "status", "data-kind": current.kind }, [
            h("span", current.text),
            current.link ? h("a", { href: current.link[1] }, current.link[0]) : null,
            current.action ? h(UButton, { color: "neutral", label: current.action[0], onClick: current.action[1], size: "sm", variant: "ghost" }) : null,
          ]))
        }
        return nodes
      }
    },
  })

  function toolbar(): VNode {
    void tick.value
    const people = room?.people() ?? []
    const seen = new Set<string>()
    const avatars = people.filter(person => !seen.has(person.id) && seen.add(person.id)).slice(0, 5).map(person =>
      h("span", { class: "avatar", key: person.id, title: person.name, style: { background: person.color } }, person.image ? h("img", { src: person.image, alt: "" }) : initials(person.name)))
    const open = state.counts.value.open
    const count = `${open} open ${open === 1 ? "thread" : "threads"}`
    const signOutUrl = session?.signOut
    return h("div", { class: "toolbar", role: "group", "aria-label": "Comments" }, [
      canComment ? h("button", { "aria-keyshortcuts": "C", "aria-pressed": String(mode.value === "comment"), onClick: () => setMode(mode.value === "comment" ? "view" : "comment"), title: "Comment (C)", type: "button" }, "Comment") : null,
      session?.content && canComment ? h("button", { "aria-keyshortcuts": "E", "aria-pressed": String(mode.value === "edit"), onClick: () => setMode(mode.value === "edit" ? "view" : "edit"), title: "Edit text (E)", type: "button" }, "Edit") : null,
      h("span", { class: "sep" }),
      h("button", {
        "aria-label": `Comments on this page, ${count}`,
        "aria-pressed": String(panelOpen.value),
        onClick: () => (panelOpen.value ? pageWindow?.hide() : showPanel()),
        title: "Comments on this page",
        type: "button",
      }, [listIcon(), String(open)]),
      avatars.length > 0 ? h("span", { "aria-label": `${people.length} on this page`, class: "people" }, avatars) : null,
      signOutUrl && session?.github
        ? h("button", { "aria-label": `Sign out @${session.github.login}`, onClick: () => void signOut(signOutUrl), title: `Signed in as @${session.github.login}. Sign out`, type: "button" },
            session.user?.image ? h("img", { alt: "", class: "me", src: session.user.image }) : initials(session.user?.name ?? session.github.login))
        : null,
    ])
  }

  /** The outlines of the areas that threads point at, and of the one being written. Resolved ones are dashed. */
  function areas(): VNode[] {
    const nodes: VNode[] = []
    const box = (key: string, kind: CommentAnchor["kind"], status: string) => {
      const position = state.positions.value.get(key)
      if (!position || position.detached || position.clipped || (kind !== "area" && kind !== "image") || !position.width || !position.height) return
      nodes.push(h("div", {
        class: "area",
        key,
        "data-status": status,
        style: { left: `${position.x}px`, top: `${position.y}px`, width: `${position.width}px`, height: `${position.height}px` },
      }))
    }
    const active = new Set([state.openId.value, state.hoverId.value])
    for (const thread of state.pageThreads.value) box(thread.id, thread.anchor.kind, active.has(thread.id) ? "active" : thread.status)
    const opened = state.opened.value
    if (opened && !state.pageThreads.value.includes(opened)) box(opened.id, opened.anchor.kind, "active")
    const draft = state.draft.value
    if (draft) box("draft", draft.anchor.kind, "active")
    return nodes
  }

  function cursors(): VNode[] {
    void tick.value
    const nodes: VNode[] = []
    for (const [id, presence] of room?.states() ?? []) {
      // SAFETY: the overlay of each person sets `cursor` with `setLocal`. Each field is checked before use.
      const cursor = presence.cursor as Cursor | undefined
      const user = presence.user as { name?: string, id?: string, color?: string } | undefined
      if (!cursor || !user?.id || user.id === me.value?.id) continue
      let element: Element | null = null
      try {
        element = document.querySelector(cursor.selector)
      }
      catch {}
      if (!element) continue
      const box = element.getBoundingClientRect()
      const color = typeof user.color === "string" && /^#[\da-f]{6}$/i.test(user.color) ? user.color : colorOf(user.id)
      nodes.push(h("div", { class: "cursor", key: id, style: { left: `${box.left + (cursor.x / 1000) * box.width}px`, top: `${box.top + (cursor.y / 1000) * box.height}px` } }, [
        h("svg", { width: 15, height: 15, viewBox: "0 0 24 24", "aria-hidden": "true" }, h("path", { d: "M4 2l16 7-7 2-3 8z", fill: color, stroke: "#000", "stroke-width": 1.5 })),
        h("span", { style: { background: color } }, user.name ?? "Someone"),
      ]))
    }
    return nodes
  }

  function outlines(): VNode[] {
    void tick.value
    if (!editing.value) return []
    const nodes: VNode[] = []
    for (const element of document.querySelectorAll(`[${fieldAttribute}]`)) {
      const field = element.getAttribute(fieldAttribute)!
      const kind = element === hover.value ? "hover" : drafted.value.has(field) ? "draft" : undefined
      if (!kind) continue
      const box = element.getBoundingClientRect()
      nodes.push(h("div", { class: "outline", "data-kind": kind, key: `${field}-outline`, style: { left: `${box.left - 3}px`, top: `${box.top - 3}px`, width: `${box.width + 6}px`, height: `${box.height + 6}px` } }))
      nodes.push(h("div", { class: "tag", key: `${field}-tag`, style: { left: `${box.left - 3}px`, top: `${box.top - 3}px` } }, kind === "draft" ? "Draft" : field))
    }
    return nodes
  }

  const app = createApp(Overlay)
  registerStandaloneUI(app)
  app.mount(root)
  if (session && !session.can.read) {
    if (options.prompt !== false) denied(session)
  }
  else if (options.failure) showToast({ text: options.failure.why, kind: "error", action: ["Close", options.exit] }, true)

  const hasUnsentComment = () => [shadow, panelTarget.value?.getRootNode()].some(node =>
    node instanceof ShadowRoot && node.querySelector("[data-slot='comment-composer'][data-dirty='true']") !== null)

  return {
    app,
    hasUnsentComment,
    showPanel,
    setMode,
    finishEdit: edit.finish,
    navigated(next) {
      if (next === page.value) {
        search.value = location.search
        return
      }
      // Routers may already have swapped the page. Keep the previous comments and draft until the person agrees.
      if (hasUnsentComment() && !window.confirm("Discard your unsent comment and show comments for the new page?")) return
      page.value = next
      search.value = location.search
      panelThread.value = null
      // The state lists the threads of the new page. The page then joins its room.
      leaveRoom()
    },
    refresh,
    pointer(event, target) {
      if (editing.value) {
        const field = target ? fieldElementOf(target) : undefined
        if (field !== hover.value) hover.value = field
      }
      if (!room || !target) return
      const box = target.getBoundingClientRect()
      room.setLocal("cursor", {
        selector: selectorOf(target),
        x: box.width ? Math.round(((event.clientX - box.left) / box.width) * 1000) : 0,
        y: box.height ? Math.round(((event.clientY - box.top) / box.height) * 1000) : 0,
      } satisfies Cursor)
    },
    leave: () => room?.setLocal("cursor", null),
    layout: () => {
      tick.value++
      if (selected.value) trackSelection()
    },
    selectionChanged: trackSelection,
    promptAccess: () => {
      if (session && !session.can.read) denied(session)
    },
    editMode: () => editing.value,
    editElement: () => edit.element,
    startEdit: element => edit.start(element),
    key(event) {
      if (event.key === "Escape" && editing.value) {
        setMode("view")
        return
      }
      if (isTyping(event) || event.metaKey || event.ctrlKey || event.altKey) return
      // The key acts here only. Without preventDefault it would also type into the name box that comment mode opens.
      if (event.key === "c" && canComment) {
        event.preventDefault()
        // With text selected, C comments on it and leaves the mode as it is, like Drop's selection bar.
        if (!commentOnSelection()) setMode(mode.value === "comment" ? "view" : "comment")
      }
      if (event.key === "e" && session?.content && canComment) {
        event.preventDefault()
        setMode(mode.value === "edit" ? "view" : "edit")
      }
    },
    destroy() {
      clearHighlights()
      clearTimeout(toastTimer)
      void edit.finish(false)
      leaveRoom()
      app.unmount()
      pageWindow?.destroy()
    },
  }
}
