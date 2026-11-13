import { CommentLayer, CommentPanel } from "@vite-hub/ui/comments"
import { useComments } from "@vite-hub/ui/headless"
import { registerStandaloneUI, UButton } from "@vite-hub/ui/standalone/nuxt-ui"
import standaloneCss from "@vite-hub/ui/standalone/styles.css?inline"
import uiCss from "@vite-hub/ui/styles.css?inline"
import { computed, createApp, defineComponent, h, nextTick, ref, shallowRef, Teleport, toRaw, watch } from "vue"

import { createAnchor, fieldAttribute, fieldElementOf, selectorOf } from "../anchor.ts"
import { anchorRange, createCommentsClient } from "../client.ts"
import { commentRoom, commentsApiRoute, commentsRealtimeDefinition, commentsRoute, normalizeCommentPage } from "../page.ts"
import { api, base64, createOverlayTransport, readGuest, saveGuest } from "./api.ts"
import { captureContext } from "./context.ts"
import { createInlineEdit } from "./edit.ts"
import { captureMarked, markerBox, markerColors, markerWidth, startMarker } from "./marker.ts"
import { overlayStyles, panelStyles } from "./styles.ts"

import type { ViteHubPageToolContext } from "@vite-hub/internal/runtime/page-tools-loader"
import type { RealtimeRoom } from "@vite-hub/realtime/client"
import type { CommentCan } from "@vite-hub/ui/headless"
import type { App, VNode } from "vue"
import type { RestCommentThread } from "../rest-transport.ts"
import type { CommentAnchor, CommentContext, CommentEvent, CommentMessage, CommentStatus, CommentSubject, CommentThread, CommentUser } from "../types.ts"
import type { CommentsApiError, CommentsSession } from "./api.ts"
import type { MarkerBox, MarkerColor, MarkerSession } from "./marker.ts"

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

export type Mode = "view" | "comment" | "edit" | "mark"

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
  /**
   * The page scrolled, resized, or changed, so cursors and outlines move. `changed`: the DOM of the page changed, so the
   * highlights find their text again. A scroll does not move a range, so it does not repaint them.
   */
  layout: (changed?: boolean) => void
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

const highlightIcon = () => h("svg", { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" }, h("path", { d: "m9 11-6 6v3h9l3-3M22 12l-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4" }))

const undoIcon = () => h("svg", { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" }, h("path", { d: "M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11" }))

const pageIcon = () => h("svg", { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" }, h("path", { d: "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7ZM14 2v4a2 2 0 0 0 2 2h4" }))

const editIcon = () => h("svg", { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" }, h("path", { d: "M21.17 6.81a1 1 0 0 0-3.98-3.98L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5zM15 5l4 4" }))

const closeIcon = () => h("svg", { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" }, h("path", { d: "M18 6 6 18M6 6l12 12" }))

const listIcon = () => h("svg", { width: 15, height: 15, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" }, h("path", { d: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" }))

/**
 * The element of the page that holds the box: the innermost one under its center whose box contains it, as an area drawn
 * in comment mode finds it. `slack` lets the box reach a little past the element, such as the half width of a highlighter
 * stroke along the edge of a paragraph.
 */
function areaContainer(box: MarkerBox, slack = 1): Element | undefined {
  const under = document.elementsFromPoint(box.left + box.width / 2, box.top + box.height / 2).find(element => !ignored(element) && element !== document.documentElement)
  for (let element: Element | null = under ?? null; element && element !== document.documentElement; element = element.parentElement) {
    const rect = element.getBoundingClientRect()
    if (rect.left <= box.left + slack && rect.top <= box.top + slack && rect.right >= box.left + box.width - slack && rect.bottom >= box.top + box.height - slack) return element
  }
  return undefined
}

/** The part of `box` inside `element`. */
function clip(box: MarkerBox, element: Element): MarkerBox {
  const rect = element.getBoundingClientRect()
  const left = Math.max(box.left, rect.left)
  const top = Math.max(box.top, rect.top)
  return { left, top, width: Math.min(box.left + box.width, rect.right) - left, height: Math.min(box.top + box.height, rect.bottom) - top }
}

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
  /** The server decides the subject of a page. Without its answer, it is the page itself. */
  const subject = shallowRef<CommentSubject>(session?.subject ?? { kind: "page", id: page.value })
  /** The version of the subject that `/session` gave with it. New threads send it, so they start on the version shown. */
  let revision = session?.revision
  /**
   * After a navigation, until the server names the subject of the new page. The overlay then shows no threads and
   * starts no comment, so a draft is not lost when the subject changes.
   */
  const resolving = ref(false)
  /** Whether comment mode was on when the navigation started, so it comes back once the subject is known. */
  const paused = ref(false)
  /** Counts the navigations, so only the answer for the latest one applies. */
  let navigations = 0
  const search = ref(location.search)
  const toast = shallowRef<Toast>()
  const panelOpen = ref(false)
  const panelTarget = shallowRef<HTMLElement>()
  const editing = ref(false)
  /** The highlighter strokes being drawn, how many there are, their color, and whether Done is taking the screenshot. */
  let marker: MarkerSession | undefined
  const marking = ref(false)
  const marks = ref(0)
  const markColor = ref<MarkerColor>("yellow")
  const finishing = ref(false)
  /** Strokes that stay on the page while their comment is written, and that comment. */
  let ink: { session: MarkerSession, draft: unknown } | undefined
  const hover = shallowRef<Element>()
  const drafted = ref(new Set<string>())
  const naming = ref(false)
  /** The action to resume after a first-time guest gives their name. */
  const namedMode = ref<"comment" | "mark" | "page">("comment")
  /** The text a first-time guest selected before the name card took the focus, so the comment starts on it after. */
  let namedQuote: Range | undefined
  const guest = ref(readGuest())
  const tick = ref(0)
  const known = shallowRef<readonly CommentUser[]>([])
  const panelStatus = ref<CommentStatus>("open")
  const panelThread = ref<string | null>(null)
  const selected = shallowRef<Selected>()
  /** Counts the DOM changes of the page, so the highlights find their text again after one. */
  const pageChanges = ref(0)
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

  /** The server-identified person. */
  const account = (): CommentUser | undefined => session?.user ?? undefined
  const me = computed<CommentUser | undefined>(() => account() ?? (guest.value ? { id: `guest:${guest.value.id}`, name: guest.value.name, guest: true } : undefined))
  /** What this person may do on the current page. The answer of `/session` for each new page replaces it. */
  const pageCan = shallowRef(session?.can)
  const canComment = computed(() => Boolean(pageCan.value?.comment))
  const needsName = computed(() => canComment.value && !me.value)

  /**
   * What this person may do in a thread, for the parts' controls. Each thread from the API carries `can` for its own
   * policy check, and the session's answer stands in until it does. The server checks every change again.
   */
  const can: CommentCan = (action, { thread, message }) => {
    const user = me.value
    if (!user || needsName.value) return false
    const allowed = (thread as RestCommentThread).can ?? { comment: canComment.value, resolve: Boolean(pageCan.value?.resolve), delete: Boolean(pageCan.value?.delete) }
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
    revisionOf: () => revision,
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
    (await transport.upload({ name: file.name, type: file.type, data: await base64(file), subject: subject.value })).key))

  const edit = createInlineEdit({
    page: () => page.value,
    info: text => showToast({ text, kind: "info" }),
    failed,
    drafted(field) {
      drafted.value = new Set([...drafted.value, field])
    },
  })

  let state!: ReturnType<typeof useComments>

  function setMode(next: Mode) {
    if (next !== "mark") stopMarking()
    // While the new page loads, the last choice wins: any mode but comment ends the paused comment mode. Edit and view
    // need no subject, so they apply now.
    if (resolving.value) paused.value = next === "comment" && canComment.value
    if (resolving.value && next !== "edit" && next !== "view") return
    if (next === "mark") {
      if (!canComment.value || marking.value) return
      if (needsName.value) {
        namedMode.value = next
        namedQuote = undefined
        naming.value = true
        return
      }
      void edit.finish(true)
      editing.value = false
      state.exit()
      startMarking()
    }
    else if (next === "comment") {
      if (!canComment.value) return
      if (needsName.value) {
        namedMode.value = next
        namedQuote = undefined
        naming.value = true
        return
      }
      void edit.finish(true)
      editing.value = false
      state.enter()
    }
    else if (next === "edit") {
      if (!session?.content || !canComment.value) return
      state.exit()
      if (state.active.value) return
      editing.value = true
    }
    else {
      naming.value = false
      namedQuote = undefined
      state.exit()
      editing.value = false
      void edit.finish(true)
    }
    hover.value = undefined
  }
  const mode = computed<Mode>(() => marking.value ? "mark" : editing.value ? "edit" : state?.active.value ? "comment" : "view")
  /** Whether comment mode is on, waiting for a guest name, or paused until the new page is known. */
  const commentOn = computed(() => mode.value === "comment" || (resolving.value && paused.value) || (naming.value && namedMode.value !== "mark"))

  function startMarking() {
    dropInk()
    marker = startMarker({ color: () => markerColors[markColor.value], onChange: () => (marks.value = marker?.strokes().length ?? 0) })
    marks.value = 0
    marking.value = true
  }
  function stopMarking() {
    marker?.remove()
    marker = undefined
    marks.value = 0
    marking.value = false
  }
  function dropInk() {
    ink?.session.remove()
    ink = undefined
  }
  /**
   * Done: a screenshot of the screen with the strokes on it, then a new comment on the area they cover, as in Drop. The
   * screenshot starts in the comment's box as an attached file, and the strokes stay on the page while it is written.
   */
  async function finishMarking() {
    const session = marker
    const strokes = session?.strokes() ?? []
    const box = markerBox(strokes)
    if (!session || !box || finishing.value) return
    finishing.value = true
    session.freeze()
    try {
      const shot = await captureMarked(strokes, node => node instanceof Element && ignored(node))
      // Cancel or Esc while the screenshot was taken.
      if (marker !== session) return
      marker = undefined
      marking.value = false
      marks.value = 0
      if (!shot) showToast({ text: "This page could not be drawn as a picture. The comment marks the area without one.", kind: "info" })
      const files = shot ? [new File([shot], "highlight.webp", { type: shot.type })] : []
      const before = state.draft.value
      const element = areaContainer(box, markerWidth / 2 + 1)
      try {
        if (element) {
          const area = clip(box, element)
          state.startDraft(element, { area, point: { x: area.left, y: area.top }, files })
        }
        else state.startDraft("page", { files })
      }
      catch {
        // The area is outside the page.
      }
      // A box that still holds text keeps its draft, and the strokes go.
      if (state.draft.value === before) session.remove()
      else ink = { session, draft: state.draft.value }
    }
    finally {
      finishing.value = false
    }
  }

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
    const next = namedMode.value
    namedMode.value = "comment"
    const quote = namedQuote
    namedQuote = undefined
    if (quote?.startContainer.isConnected) {
      const selection = getSelection()
      selection?.removeAllRanges()
      selection?.addRange(quote)
      if (commentOnSelection()) return
    }
    if (next === "page") commentOnPage()
    else setMode(next)
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
  function pageSelection(): Range | undefined {
    const selection = getSelection()
    if (!canComment.value || editing.value || resolving.value || !selection || selection.isCollapsed || selection.rangeCount === 0 || !selection.toString().trim()) return
    const range = selection.getRangeAt(0)
    const container = range.commonAncestorContainer
    const element = container instanceof Element ? container : container.parentElement
    if (!element?.isConnected || ignored(element) || element.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) return
    return range.cloneRange()
  }
  /**
   * The text under the bar. The bar comments on it, not on the live selection: on a phone, a tap on the bar can clear the
   * selection before the click.
   */
  let barRange: Range | undefined
  /** Whether a press on the bar is in progress, so the selection change that it causes keeps the bar. */
  let pressingBar = false
  /** Shows or moves the bar over the selected text. */
  function trackSelection() {
    if (pressingBar) return
    barRange = state?.draft.value ? undefined : pageSelection()
    const rect = barRange?.getBoundingClientRect()
    selected.value = rect && (rect.width || rect.height) ? { left: rect.left + rect.width / 2, top: rect.top, bottom: rect.bottom } : undefined
  }
  /** Starts a comment on the selected text, as Drop does: the composer opens at the end of the quote. */
  function commentOnSelection(range = pageSelection()): boolean {
    pressingBar = false
    if (!range) return false
    if (needsName.value) {
      namedMode.value = "comment"
      namedQuote = range
      naming.value = true
      return true
    }
    void edit.finish(true)
    const rect = range.getBoundingClientRect()
    try {
      state.startDraft(range, { point: { x: rect.right, y: rect.top } })
      getSelection()?.removeAllRanges()
    }
    catch {
      return false
    }
    barRange = undefined
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
    if (opened && opened.subject.kind === subject.value.kind && opened.subject.id === subject.value.id && !threads.includes(opened)) threads.push(opened)
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
        subject: () => subject.value,
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
      // A range follows its text when the page scrolls. A change to the page's DOM can replace the text, so the ranges
      // are found again then.
      watch([pageChanges, state.pageThreads, state.openId, state.hoverId, () => state.draft.value?.anchor], paintHighlights, { flush: "post" })
      watch(() => state.draft.value, trackSelection)
      // The strokes go once their comment is sent or closed.
      watch(() => state.draft.value, (draft) => {
        if (ink && draft !== ink.draft) dropInk()
      })

      return () => {
        const nodes: Array<VNode | null> = []
        if (pageCan.value?.read && !resolving.value) {
          nodes.push(h(CommentLayer, { comments: state, readOnly: !me.value, upload: canComment.value ? upload : undefined, attachmentUrl: transport.attachmentUrl }, { default: () => [] }))
          nodes.push(h("div", { class: "cursors" }, cursors()))
          nodes.push(h("div", { class: "outlines" }, outlines()))
          nodes.push(options.areas ? h(Teleport, { to: options.areas }, areas()) : h("div", { class: "areas" }, areas()))
          const bar = selected.value
          if (bar && !state.draft.value) {
            // Near the top of the screen there is no room above. On a touch screen the system's own menu takes that place,
            // and the selection handles hang under the text, so the bar goes above only when its 38px do not fit below.
            // Above the text on a touch screen, it leaves 64px for the system's menu, which on Android is about 48px tall and 8px above the text.
            const touch = matchMedia("(pointer: coarse)").matches
            const under = bar.bottom + (touch ? 20 : 8)
            const below = bar.top < (touch ? 102 : 56) || (touch && under <= innerHeight - 46)
            const top = below ? Math.min(under, innerHeight - 46) : bar.top - (touch ? 64 : 8)
            nodes.push(h("div", {
              class: "selection-bar",
              "data-below": below ? "true" : undefined,
              role: "group",
              "aria-label": "Selected text",
              style: { left: `${Math.min(Math.max(64, bar.left), innerWidth - 64)}px`, top: `${top}px` },
              // A press here must not take the selection away from the page, nor hide the bar before the click.
              onPointerdown: (event: PointerEvent) => {
                event.preventDefault()
                pressingBar = true
                // The click comes right after the release. A press that ends without one lets the bar follow the page again.
                addEventListener("pointerup", () => setTimeout(() => {
                  if (!pressingBar) return
                  pressingBar = false
                  trackSelection()
                }, 300), { capture: true, once: true })
              },
              onMousedown: (event: MouseEvent) => event.preventDefault(),
            }, h("button", { type: "button", "aria-keyshortcuts": "C", title: "Comment on the selected text (C)", onClick: () => commentOnSelection(barRange) }, [commentIcon(), "Comment"])))
          }
          if (panelTarget.value && !resolving.value) {
            nodes.push(h(Teleport, { to: panelTarget.value }, h(CommentPanel, {
              key: page.value,
              comments: state,
              attachmentUrl: transport.attachmentUrl,
              readOnly: !me.value || (!state.threads.value.some(thread => thread.id === panelThread.value) && !canComment.value),
              "onUpdate:thread": (value: string | null) => (panelThread.value = value),
              status: panelStatus.value,
              "onUpdate:status": (value: CommentStatus) => (panelStatus.value = value),
              title: page.value,
              upload: canComment.value ? upload : undefined,
              // The thread opens in the list. Its spot on the page comes into view.
              onSelect: (thread: { id: string }) => {
                const position = state.positions.value.get(thread.id)
                if (position && !position.detached) position.element?.scrollIntoView({ block: "center", behavior: "smooth" })
              },
            })))
          }
        }
        // The toolbar stays while the subject of a new page loads, so its buttons do not jump.
        if (pageCan.value?.read && options.toolbar) nodes.push(h(Teleport, { to: options.toolbar }, toolbar()))
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

  /** While the person highlights: the colors, Undo, Cancel, and Done, as Drop's Marker controls. */
  function markerToolbar(): VNode {
    const busy = finishing.value
    return h("div", { class: "toolbar", role: "group", "aria-label": "Highlight" }, [
      h("div", { class: "swatches" }, (Object.keys(markerColors) as MarkerColor[]).map(name => h("button", {
        key: name,
        class: "swatch",
        type: "button",
        "aria-label": `${name[0]!.toUpperCase()}${name.slice(1)} highlighter`,
        "aria-pressed": String(markColor.value === name),
        disabled: busy,
        onClick: () => {
          markColor.value = name
          marker?.recolor()
        },
      }, h("span", { style: { background: markerColors[name] } })))),
      h("span", { class: "sep" }),
      h("button", { type: "button", class: "icon", "aria-label": "Undo", "aria-keyshortcuts": "Meta+Z Control+Z", title: "Undo", disabled: busy || marks.value === 0, onClick: () => marker?.undo() }, undoIcon()),
      h("button", { type: "button", disabled: busy, onClick: () => setMode("view"), title: "Cancel (Esc)" }, "Cancel"),
      h("button", { type: "button", class: "done", "aria-keyshortcuts": "Enter", "aria-busy": busy ? "true" : undefined, disabled: !busy && marks.value === 0, onClick: () => void finishMarking(), title: "Comment on the highlighted area (Enter)" }, busy ? "Taking picture…" : "Done"),
    ])
  }

  /** Starts a comment on the whole page, as Drop's **Whole page**. Its box opens near the top. */
  function commentOnPage() {
    if (!canComment.value || resolving.value) return
    if (needsName.value) {
      namedMode.value = "page"
      namedQuote = undefined
      naming.value = true
      return
    }
    void edit.finish(true)
    state.startDraft("page")
  }

  /**
   * Drop's Comments segment: one **Comments** button with the open count. For people who may comment it turns comment
   * mode on (C), says **Click anywhere**, and grows the actions beside it: **Whole page**, **All comments**, and ×. For
   * people who may only read, it opens the list. **Highlight** and **Edit** follow.
   */
  function toolbar(): VNode {
    void tick.value
    if (marking.value || finishing.value) return markerToolbar()
    const signOutUrl = session?.signOut
    const github = signOutUrl ? session?.github : undefined
    // Each person shows once, however many tabs they have open. The sign-out button shows the person themselves, so
    // presence then lists only the others.
    const seen = new Set(github && session?.user ? [session.user.id] : [])
    const people = (room?.people() ?? []).filter(person => !seen.has(person.id) && seen.add(person.id))
    const avatars = people.slice(0, 5).map(person =>
      h("span", { class: "avatar", key: person.id, title: person.name, style: { background: person.color } }, person.image ? h("img", { src: person.image, alt: "" }) : initials(person.name)))
    const peopleLabel = `${people.length} ${github ? "other " : ""}${people.length === 1 ? "person" : "people"} on this page`
    const open = state.counts.value.open
    const commenting = commentOn.value
    const badge = (shown: boolean) => shown && open > 0 ? h("span", { class: "count" }, String(open)) : null
    const togglePanel = () => (panelOpen.value ? pageWindow?.hide() : showPanel())
    return h("div", { class: "toolbar", role: "group", "aria-label": "Comments" }, [
      canComment.value
        ? h("button", {
            "aria-keyshortcuts": "C",
            "aria-label": commenting ? "Comments: click anywhere on the page" : open ? `Comments, ${open} open` : "Comments",
            "aria-pressed": String(commenting),
            onClick: () => setMode(commenting ? "view" : "comment"),
            title: commenting ? "Stop commenting (C)" : "Comment on the page (C)",
            type: "button",
          }, [commentIcon(), commenting ? "Click anywhere" : "Comments", badge(!commenting)])
        : h("button", {
            "aria-expanded": String(panelOpen.value),
            "aria-label": open ? `Comments, ${open} open` : "Comments",
            onClick: togglePanel,
            title: "Show comments",
            type: "button",
          }, [commentIcon(), "Comments", badge(true)]),
      commenting
        ? h("div", { class: "actions", role: "group", "aria-label": "Comment actions" }, [
            h("span", { class: "divider", "aria-hidden": "true" }),
            h("button", { onClick: commentOnPage, title: "Comment on the whole page", type: "button" }, [pageIcon(), "Whole page"]),
            h("button", { "aria-expanded": String(panelOpen.value), onClick: togglePanel, title: "All comments on this page", type: "button" }, [listIcon(), "All comments", badge(!panelOpen.value)]),
            h("button", { "aria-label": "Stop commenting", onClick: () => setMode("view"), title: "Stop commenting (Esc)", type: "button" }, closeIcon()),
            h("span", { class: "divider", "aria-hidden": "true" }),
          ])
        : null,
      canComment.value ? h("button", { "aria-keyshortcuts": "B", "aria-pressed": "false", onClick: () => setMode("mark"), title: "Highlight the page and comment (B)", type: "button" }, [highlightIcon(), "Highlight"]) : null,
      session?.content && canComment.value ? h("button", { "aria-keyshortcuts": "E", "aria-pressed": String(mode.value === "edit"), onClick: () => setMode(mode.value === "edit" ? "view" : "edit"), title: "Edit text (E)", type: "button" }, [editIcon(), "Edit"]) : null,
      avatars.length > 0 ? h("span", { "aria-label": peopleLabel, class: "people" }, avatars) : null,
      signOutUrl && github
        ? h("button", { "aria-label": `Sign out @${github.login}`, onClick: () => void signOut(signOutUrl), title: `Signed in as @${github.login}. Sign out`, type: "button" },
            session?.user?.image ? h("img", { alt: "", class: "me", src: session.user.image }) : initials(session?.user?.name ?? github.login))
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

  let retryToast: Toast | undefined
  function clearRetry() {
    if (toast.value === retryToast) toast.value = undefined
    retryToast = undefined
  }
  /**
   * Asks `/session` for the subject and the permissions of a new page. Until it answers, comments stay paused. A failed
   * answer keeps them paused, because the subject is not known, and offers Retry.
   */
  function resolvePage(next: string) {
    const current = ++navigations
    void api.session(next).then(async ([error, answer]) => {
      if (current !== navigations || page.value !== next) return
      if (error) {
        retryToast = { text: `${error.why} Comments are paused on this page.`, kind: "error", action: ["Retry", () => {
          // The Retry of a page that the person left must not cancel the request for the page they are on now.
          if (page.value === next) resolvePage(next)
        }] }
        showToast(retryToast, true)
        return
      }
      clearRetry()
      pageCan.value = answer.can
      revision = answer.revision
      const mapped = answer.subject ?? { kind: "page", id: next }
      if (mapped.kind !== subject.value.kind || mapped.id !== subject.value.id) subject.value = mapped
      // The same subject lists no threads again, so the new page joins its room here.
      else if (!room && state.status.value === "ready") void joinRoom()
      // A new subject cancels the draft of the old one. Comment mode turns a selected text into a draft, so it waits.
      await nextTick()
      if (current !== navigations) return
      resolving.value = false
      const resume = paused.value
      paused.value = false
      // Through setMode, so comment mode ends edit mode, and a guest without a name gets the name card first.
      if (resume) setMode("comment")
    })
  }

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
      if (hasUnsentComment()) {
        if (!window.confirm("Discard your unsent comment and show comments for the new page?")) return
        // The new page can have the same subject, which keeps the state's draft. The person said to discard it.
        state.cancelDraft()
      }
      naming.value = false
      namedQuote = undefined
      page.value = next
      search.value = location.search
      panelThread.value = null
      // Strokes mark the screen of the old page.
      if (marking.value) setMode("view")
      dropInk()
      // The Retry of the previous page does not apply here.
      clearRetry()
      // Comment mode pauses until the subject is known: in it, Enter on an element starts a comment.
      paused.value = paused.value || state.active.value
      state.active.value = false
      resolving.value = true
      resolvePage(next)
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
    layout: (changed) => {
      tick.value++
      if (changed) pageChanges.value++
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
      if (marking.value) {
        if (event.key === "Escape") setMode("view")
        else if (event.key === "Enter") void finishMarking()
        else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") marker?.undo()
        // The strokes stay where they were drawn, so the keys do not scroll the page either.
        else if (![" ", "PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", "b"].includes(event.key)) return
        if (event.key !== "b") {
          event.preventDefault()
          return
        }
      }
      if (isTyping(event) || event.metaKey || event.ctrlKey || event.altKey) return
      // The key acts here only. Without preventDefault it would also type into the name box that comment mode opens.
      if (event.key === "c" && canComment.value) {
        event.preventDefault()
        // With text selected, C comments on it and leaves the mode as it is, like Drop's selection bar.
        if (!commentOnSelection()) setMode(commentOn.value ? "view" : "comment")
      }
      if (event.key === "b" && canComment.value) {
        event.preventDefault()
        setMode(mode.value === "mark" ? "view" : "mark")
      }
      if (event.key === "e" && session?.content && canComment.value) {
        event.preventDefault()
        setMode(mode.value === "edit" ? "view" : "edit")
      }
    },
    destroy() {
      stopMarking()
      dropInk()
      clearHighlights()
      clearTimeout(toastTimer)
      void edit.finish(false)
      leaveRoom()
      app.unmount()
      pageWindow?.destroy()
    },
  }
}
