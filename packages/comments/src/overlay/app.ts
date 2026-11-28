import { viteHubPageToolsQuery } from "@vite-hub/internal/runtime/page-tools-shared"
import { CommentLayer, CommentPanel, CommentSelectionBar, CommentSend } from "@vite-hub/ui/comments"
import { useComments } from "@vite-hub/ui/headless"
import { createMotionList, installMotion, rollNumber } from "@vite-hub/ui/motion"
import { registerStandaloneUI, UButton, UIcon } from "@vite-hub/ui/standalone/nuxt-ui"
import standaloneCss from "@vite-hub/ui/standalone/styles.css?inline"
import uiCss from "@vite-hub/ui/styles.css?inline"
import { computed, createApp, defineComponent, h, nextTick, onBeforeUnmount, onMounted, onUpdated, ref, shallowRef, Teleport, toRaw, watch } from "vue"

import { createAnchor, fieldAttribute, fieldElementOf, selectorOf } from "../anchor.ts"
import { anchorRange, createCommentsClient } from "../client.ts"
import { commentsAgentPrompt, commentsPagePrompt, commentsT3CodeLink } from "../agent-prompt.ts"
import { createCommentSend } from "../client-send.ts"
import { commentNoticeRoom, commentRoom, commentsApiRoute, commentsNoticeDefinition, commentsRealtimeDefinition, commentsRoute, normalizeCommentPage } from "../page.ts"
import { api, createOverlaySendTransport, createOverlayTransport, overlayOutboxNamespace, readGuest, saveGuest } from "./api.ts"
import { captureContext } from "./context.ts"
import { createInlineEdit } from "./edit.ts"
import { usePillClearance } from "./island-top.ts"
import { captureMarked, markerBox, markerColors, markerTips, startMarker } from "./marker.ts"
import { overlayStyles, panelStyles } from "./styles.ts"

import type { ViteHubPageToolContext } from "@vite-hub/internal/runtime/page-tools-loader"
import type { RealtimeRoom } from "@vite-hub/realtime/client"
import type { CommentStatusSlotScope } from "@vite-hub/ui/comments"
import type { CommentCan, CommentVisibility } from "@vite-hub/ui/headless"
import type { MotionList } from "@vite-hub/ui/motion"
import type { App, VNode } from "vue"
import type { CommentsClientFiles } from "../client.ts"
import type { RestCommentThread } from "../rest-transport.ts"
import type { CommentsAgentPromptInput, CommentsAgentPromptThread } from "../agent-prompt.ts"
import type { CommentAnchor, CommentContext, CommentCreateInput, CommentEvent, CommentMessage, CommentStatus, CommentSubject, CommentThread, CommentUser } from "../types.ts"
import type { CommentsApiError, CommentsSession } from "./api.ts"
import type { MarkerBox, MarkerColor, MarkerSession, MarkerTip } from "./marker.ts"

interface Cursor {
  selector: string
  x: number
  y: number
}

interface Selected {
  left: number
  top: number
  bottom: number
}

/** The names of the CSS highlights of commented text. `@vite-hub/ui/comment-marks.css` colors them. */
export const highlightNames = { open: "vh-comment", resolved: "vh-comment-resolved", active: "vh-comment-active", draft: "vh-comment-draft" } as const

interface Toast {
  text: string
  kind: "error" | "info"
  link?: { label: string, href: string, newTab?: true }
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
  waitForPendingComment: () => Promise<void> | undefined
  showPanel: () => void
  /** What the Comments button does, for a `?vitehub=comments` link: comment mode, or the list for a reader. */
  pressComments: () => void
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

type RealtimePerson = ReturnType<RealtimeRoom["people"]>[number]

function others(people: readonly RealtimePerson[], me: string | undefined): { person: RealtimePerson, tabs: number }[] {
  const byId = new Map<string, { person: RealtimePerson, tabs: number }>()
  for (const person of people) {
    if (person.id === me) continue
    const seen = byId.get(person.id)
    if (seen) seen.tabs++
    else byId.set(person.id, { person, tabs: 1 })
  }
  return [...byId.values()]
}

const OpenCount = defineComponent({
  props: { value: { required: true, type: Number } },
  setup(props) {
    const element = ref<HTMLElement>()
    const first = String(props.value)
    onMounted(() => element.value && rollNumber(element.value, props.value))
    watch(() => props.value, value => element.value && rollNumber(element.value, value), { flush: "post" })
    return () => h("span", { class: "count", ref: element }, first)
  },
})

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]!.toUpperCase()).join("") || "?"
}

function colorOf(id: string): string {
  const colors = ["#fb7185", "#fbbf24", "#34d399", "#22d3ee", "#60a5fa", "#a78bfa", "#f472b6"]
  let hash = 0
  for (let index = 0; index < id.length; index++) hash = Math.imul(31, hash) + id.charCodeAt(index) | 0
  return colors[Math.abs(hash) % colors.length]!
}

function withPicture<T extends CommentsClientFiles>(input: T, picture: Promise<File[]>): Omit<T, "files" | "deferredFiles"> & CommentsClientFiles {
  const { files, deferredFiles, ...rest } = input
  const after = (first: Promise<Blob[]>) => Promise.all([first, picture]).then(lists => lists.flat())
  if (files !== undefined && !Array.isArray(files)) return { ...rest, files: after(files) }
  return { ...rest, ...(files ? { files } : {}), deferredFiles: deferredFiles ? after(deferredFiles) : picture }
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

const tipIcons: Record<MarkerTip, () => VNode> = {
  marker: highlightIcon,
  pen: () => h("svg", { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" }, h("path", { d: "M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" })),
  arrow: () => h("svg", { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" }, h("path", { d: "M7 17 17 7M7 7h10v10" })),
  text: () => h("svg", { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" }, h("path", { d: "M4 7V4h16v3M9 20h6M12 4v16" })),
}

function tipOfKey(event: KeyboardEvent): MarkerTip | undefined {
  if (event.metaKey || event.ctrlKey || event.altKey) return undefined
  return (Object.keys(markerTips) as MarkerTip[]).find(tip => markerTips[tip].key === event.key.toUpperCase())
}

const undoIcon = () => h("svg", { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" }, h("path", { d: "M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11" }))

const editIcon = () => h("svg", { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" }, h("path", { d: "M21.17 6.81a1 1 0 0 0-3.98-3.98L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5zM15 5l4 4" }))

const plusIcon = () => h("svg", { class: "plus", width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" }, h("path", { d: "M12 5v14M5 12h14" }))

const eyeIcon = () => h("svg", { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" }, [h("path", { d: "M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0" }), h("circle", { cx: 12, cy: 12, r: 3 })])

const eyeOffIcon = () => h("svg", { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" }, h("path", { d: "M10.73 5.08A10.43 10.43 0 0 1 12 5c4.97 0 8.9 3.06 9.94 6.65a1 1 0 0 1 0 .7 10.8 10.8 0 0 1-1.44 2.49M14.08 14.16a3 3 0 0 1-4.24-4.24M17.48 17.5a10.75 10.75 0 0 1-15.42-5.15 1 1 0 0 1 0-.7 10.75 10.75 0 0 1 4.45-5.14M2 2l20 20" }))

const visibilityKey = "vitehub-comments-visibility"
function readVisibility(): CommentVisibility {
  try {
    return localStorage.getItem(visibilityKey) === "hidden" ? "hidden" : "all"
  }
  catch {
    return "all"
  }
}
function saveVisibility(value: CommentVisibility) {
  try {
    if (value === "hidden") localStorage.setItem(visibilityKey, value)
    else localStorage.removeItem(visibilityKey)
  }
  catch {}
}

const copyIcon = () => h("svg", { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" }, [h("rect", { width: 14, height: 14, x: 8, y: 8, rx: 2 }), h("path", { d: "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" })])
const checkIcon = () => h("svg", { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" }, h("path", { d: "M20 6 9 17l-5-5" }))
const listIcon = () => h("svg", { width: 15, height: 15, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" }, h("path", { d: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" }))

function areaContainer(box: MarkerBox, slack = 1): Element | undefined {
  const under = document.elementsFromPoint(box.left + box.width / 2, box.top + box.height / 2).find(element => !ignored(element) && element !== document.documentElement)
  for (let element: Element | null = under ?? null; element && element !== document.documentElement; element = element.parentElement) {
    const rect = element.getBoundingClientRect()
    if (rect.left <= box.left + slack && rect.top <= box.top + slack && rect.right >= box.left + box.width - slack && rect.bottom >= box.top + box.height - slack) return element
  }
  return undefined
}

function clip(box: MarkerBox, element: Element): MarkerBox {
  const rect = element.getBoundingClientRect()
  const left = Math.max(box.left, rect.left)
  const top = Math.max(box.top, rect.top)
  return { left, top, width: Math.min(box.left + box.width, rect.right) - left, height: Math.min(box.top + box.height, rect.bottom) - top }
}

const threadParam = "comment"

function dropThreadLink() {
  const url = new URL(location.href)
  if (!url.searchParams.has(threadParam)) return
  url.searchParams.delete(threadParam)
  history.replaceState(history.state, "", url)
}

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
  const stopMotion = [shadow, options.toolbar?.getRootNode(), options.areas].filter((node): node is ShadowRoot => node instanceof ShadowRoot).map(node => installMotion(node))

  const page = ref(normalizeCommentPage(location.pathname))
  const subject = shallowRef<CommentSubject>(session?.subject ?? { kind: "page", id: page.value })
  let revision = session?.revision
  const resolving = ref(false)
  const paused = ref(false)
  let navigations = 0
  const search = ref(location.search)
  const toast = shallowRef<Toast>()
  const toastKeys = new WeakMap<Toast, number>()
  let toastCount = 0
  const toastKey = (value: Toast) => {
    let key = toastKeys.get(value)
    if (key === undefined) toastKeys.set(value, key = ++toastCount)
    return key
  }
  const cursorLayer = ref<HTMLElement>()
  const panelOpen = ref(false)
  const panelTarget = shallowRef<HTMLElement>()
  const editing = ref(false)
  let marker: MarkerSession | undefined
  const marking = ref(false)
  const marks = ref(0)
  const markTip = ref<MarkerTip>("marker")
  const markColor = ref<MarkerColor>("pink")
  let ink: { session: MarkerSession, draft: unknown } | undefined
  const pictures = new WeakMap<CommentAnchor, { files: Promise<File[]>, sent: boolean }>()
  const hover = shallowRef<Element>()
  const drafted = ref(new Set<string>())
  const naming = ref(false)
  const namedMode = ref<"comment" | "mark">("comment")
  let namedQuote: Range | undefined
  const guest = ref(readGuest())
  const tick = ref(0)
  const known = shallowRef<readonly CommentUser[]>([])
  const panelStatus = ref<CommentStatus>("open")
  const panelThread = ref<string | null>(null)
  const selected = shallowRef<Selected>()
  const pageChanges = ref(0)
  const hidden = ref(readVisibility() === "hidden")
  let room: RealtimeRoom | undefined
  let noticeRoom: RealtimeRoom | undefined
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

  const account = (): CommentUser | undefined => session?.user ?? undefined
  const showPresence = session?.presence !== false
  const me = computed<CommentUser | undefined>(() => account() ?? (guest.value ? { id: `guest:${guest.value.id}`, name: guest.value.name, guest: true } : undefined))
  const pageCan = shallowRef(session?.can)
  const pageAgent = shallowRef(session?.agent)
  const pageRepository = shallowRef(session?.repository)
  const canComment = computed(() => Boolean(pageCan.value?.comment))
  const canAttach = computed(() => canComment.value && session?.attachments !== false)
  const needsName = computed(() => canComment.value && !me.value)
  const visibility = computed<CommentVisibility>({
    get: () => hidden.value && canComment.value ? "hidden" : "all",
    set: (value) => {
      hidden.value = value === "hidden"
      saveVisibility(value)
    },
  })

  const can: CommentCan = (action, { thread, message }) => {
    const user = me.value
    if (!user || needsName.value) return false
    if (message?.delivery && (action === "edit" || action === "delete")) return true
    const allowed = (thread as RestCommentThread).can ?? { comment: canComment.value, resolve: Boolean(pageCan.value?.resolve), delete: Boolean(pageCan.value?.delete) }
    if (action === "reply") return thread.status === "open" && allowed.comment
    if (action === "resolve") return allowed.resolve
    const own = (entry: CommentMessage) => !user.guest && !entry.author.guest && entry.author.id === user.id
    if (!message || pageCan.value?.change === false) return false
    if (action === "edit") return own(message)
    const owns = thread.messages[0]?.id === message.id ? thread.messages.every(own) : own(message)
    return owns ? allowed.comment : allowed.delete === true && !user.guest
  }

  const transport = createOverlayTransport({
    onPeople(people) {
      const next = new Map(known.value.map(person => [person.id, person]))
      for (const person of people) next.set(person.id, person)
      known.value = [...next.values()]
    },
    onChange: () => room?.setLocal("commentsChange", crypto.randomUUID()),
  })
  function createClient(user: CommentUser | undefined) {
    const namespace = overlayOutboxNamespace()
    const next = createCommentsClient({
      transport: {
        ...transport,
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      },
      user,
      ...(user ? { outbox: { account: user.id, namespace } } : {}),
    })
    const create = next.create
    next.create = (input) => {
      const shown = input.revision ?? revision
      const picture = pictures.get(input.anchor)
      pictures.delete(input.anchor)
      if (picture) picture.sent = true
      const sent: CommentCreateInput & CommentsClientFiles & { context?: CommentContext } = {
        ...(picture ? withPicture(input, picture.files) : input),
        context: contexts.get(input.anchor) ?? captureContext(undefined),
        ...(shown === undefined ? {} : { revision: shown }),
      }
      return create(sent)
    }
    return next
  }
  const client = shallowRef(createClient(me.value))
  watch(() => me.value?.id, () => (client.value = createClient(me.value)))
  const refresh = () => {
    for (const listener of listeners) listener({ type: "reconnected" })
  }
  let roomRefresh: ReturnType<typeof setTimeout> | undefined
  const refreshFromRoom = () => {
    clearTimeout(roomRefresh)
    roomRefresh = setTimeout(refresh, 100)
  }
  const send = computed(() => {
    const path = page.value
    return session?.send ? createCommentSend(createOverlaySendTransport(() => path)) : undefined
  })
  const fileUrls = (key: string) => {
    const url = transport.attachmentUrl(key)
    return url ? [new URL(url, location.href).href] : []
  }
  const promptThread = (thread: CommentThread): CommentsAgentPromptThread => ({
    id: thread.id,
    anchor: thread.anchor,
    messages: thread.messages.map(message => ({ author: message.author.name ?? message.author.id, body: message.body })),
    ...(thread.revision === undefined ? {} : { revision: thread.revision }),
    files: thread.messages.flatMap(message => message.attachments.flatMap(fileUrls)),
  })
  const promptInput = (threads: readonly CommentThread[]): CommentsAgentPromptInput => ({
    url: new URL(page.value, location.origin).href,
    threads: threads.map(promptThread),
    ...(pageAgent.value ? { agent: pageAgent.value } : {}),
  })
  async function copyPrompt(threads: readonly CommentThread[]) {
    const copied = await navigator.clipboard?.writeText(commentsAgentPrompt(promptInput(threads))).then(() => true, () => false)
    showToast(copied ? { text: "Prompt copied. Paste it in your agent.", kind: "info" } : { text: "Could not copy the prompt. Allow clipboard access and try again.", kind: "error" })
  }
  const deliveredOpenThreads = computed(() => state.openThreads.value.filter(thread => !thread.delivery))
  const canCopyPagePrompt = computed(() => !resolving.value && !commentOn.value && deliveredOpenThreads.value.length > 0)
  const pageCopied = ref(false)
  const moreOpen = ref(false)
  let pageCopiedTimer: ReturnType<typeof setTimeout> | undefined
  async function copyPagePrompt() {
    if (!canCopyPagePrompt.value) return
    const navigation = navigations
    const copied = await navigator.clipboard?.writeText(commentsPagePrompt(promptInput(deliveredOpenThreads.value))).then(() => true, () => false)
    if (navigation !== navigations) return
    if (!copied) return showToast({ text: "Could not copy the prompt. Allow clipboard access and try again.", kind: "error" })
    pageCopied.value = true
    clearTimeout(pageCopiedTimer)
    pageCopiedTimer = setTimeout(() => (pageCopied.value = false), 1500)
  }
  const promptActions = (threads: readonly CommentThread[], copy: { label: string, action: string }): VNode[] => {
    const link = commentsT3CodeLink(promptInput(threads), pageRepository.value)
    return [
      link ? h(UButton, {
        color: "neutral",
        "data-action": "open-in-t3-code",
        label: "Open in T3 Code",
        rel: "noopener noreferrer",
        size: "xs",
        target: "_blank",
        to: link,
        variant: "ghost",
      }, () => h(UIcon, { name: "i-lucide-arrow-up-right" })) : h("small", "Too long for T3 Code. Copy the prompt instead."),
      h(UButton, { color: "neutral", "data-action": copy.action, icon: "i-lucide-copy", label: copy.label, onClick: () => void copyPrompt(threads), size: "xs", variant: "ghost" }),
    ]
  }
  const threadActions = ({ thread }: { thread: CommentThread }): VNode[] =>
    thread.status === "open" && !thread.delivery ? promptActions([thread], { label: "Copy", action: "copy-prompt" }) : []
  const listActions = (): VNode[] => {
    const threads = deliveredOpenThreads.value
    return panelStatus.value === "open" && threads.length ? promptActions(threads, { label: "Copy open", action: "copy-open-prompt" }) : []
  }
  const delivery = ({ delivery: { status, error }, retry }: CommentStatusSlotScope): VNode[] => {
    const failed = status === "failed"
    const held = error?.status === 401 || error?.status === 402
    const label = failed ? "Not sent." : error ? "Waiting to send." : "Sending…"
    return [
      h("span", { class: "delivery", "data-failed": failed ? "true" : undefined }, error ? `${label} ${error.why}` : label),
      ...(retry && (failed || held) ? [h(UButton, { color: "neutral", label: "Retry", onClick: () => void retry(), size: "xs", variant: "ghost" })] : []),
    ]
  }

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
    if (resolving.value) paused.value = next === "comment" && canComment.value
    if (resolving.value && next !== "edit" && next !== "view") return
    if (next === "mark") {
      if (!canAttach.value || marking.value) return
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
      moreOpen.value = true
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
  const commentOn = computed(() => mode.value === "comment" || (resolving.value && paused.value) || (naming.value && namedMode.value !== "mark"))

  function startMarking() {
    dropInk()
    marker = startMarker({
      tip: () => markTip.value,
      color: () => markerColors[markColor.value],
      onChange: () => (marks.value = marker?.strokes().length ?? 0),
      onSubmit: finishMarking,
    })
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
  function finishMarking() {
    const session = marker
    session?.commit()
    const strokes = session?.strokes() ?? []
    const box = markerBox(strokes)
    if (!session || !box) return
    session.freeze()
    const shot = captureMarked(strokes, node => node instanceof Element && ignored(node))
    marker = undefined
    marking.value = false
    marks.value = 0
    const before = state.draft.value
    const element = areaContainer(box, markerTips.marker.width / 2 + 1)
    try {
      if (element) {
        const area = clip(box, element)
        state.startDraft(element, { area, point: { x: area.left, y: area.top } })
      }
      else state.startDraft("page")
    }
    catch {}
    const draft = state.draft.value
    if (!draft || draft === before) {
      session.remove()
      return
    }
    ink = { session, draft }
    const picture = {
      files: shot.then(blob => blob ? [new File([blob], "highlight.webp", { type: blob.type })] : [], () => []),
      sent: false,
    }
    pictures.set(toRaw(draft.anchor), picture)
    void picture.files.then((files) => {
      if (!files.length && (picture.sent || state.draft.value === draft)) showToast({ text: "This page could not be drawn as a picture. The comment marks the area without one.", kind: "info" })
    })
  }

  async function joinRoom(reconnect = false) {
    if (!session?.realtime || !host.isConnected || context?.signal.aborted || (room && !reconnect)) return
    const join = ++joins
    const realtime = await import("@vite-hub/realtime/client").catch(() => undefined)
    if (!realtime || join !== joins || !host.isConnected || context?.signal.aborted) return
    room?.destroy()
    noticeRoom?.destroy()
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
      if (changed) refreshFromRoom()
    })
    noticeRoom = realtime.connectRealtimeRoom(commentsNoticeDefinition, commentNoticeRoom(subject.value), { baseURL, params: { page: page.value } })
    noticeRoom.onNotice(refreshFromRoom)
    room = joined
  }
  function leaveRoom() {
    joins++
    clearTimeout(roomRefresh)
    room?.destroy()
    room = undefined
    noticeRoom?.destroy()
    noticeRoom = undefined
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
      stopMotion.push(installMotion(panelShadow))
      const target = document.createElement("div")
      target.className = "panel-root dark"
      panelShadow.append(style(shadowCss(panelStyles)), target)
      pageWindow.body.append(panelHost)
      panelTarget.value = target
    }
    panelOpen.value = true
    pageWindow.show()
  }

  async function nameGuest(name: string) {
    guest.value = saveGuest(name)
    naming.value = false
    void joinRoom(true)
    const next = namedMode.value
    namedMode.value = "comment"
    const quote = namedQuote
    namedQuote = undefined
    await nextTick()
    if (quote?.startContainer.isConnected) {
      const selection = getSelection()
      selection?.removeAllRanges()
      selection?.addRange(quote)
      if (commentOnSelection()) return
    }
    setMode(next)
  }

  async function signOut(url: string) {
    await fetch(url, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => undefined)
    location.reload()
  }

  function denied(current: CommentsSession) {
    const back = new URL(location.href)
    back.searchParams.set(viteHubPageToolsQuery, "comments")
    const signIn = current.signIn
    const hosted = signIn?.provider === "console"
    const github = current.github
    if (github && current.signOut) {
      const url = current.signOut
      const text = github.repository
        ? `@${github.login} cannot push to ${github.repository}, so cannot comment here.`
        : `Signed in as @${github.login}, but this site does not say which GitHub repository it is built from.`
      showToast({ text, kind: "error", action: ["Use another account", () => void signOut(url)] }, true)
    }
    else if (signIn) showToast({
      text: "Sign in to comment on this page.",
      kind: "info",
      link: hosted
        ? { label: "Sign in to ViteHub", href: signIn.url, newTab: true }
        : { label: "Sign in with GitHub", href: `${signIn.url}?return=${encodeURIComponent(back.pathname + back.search + back.hash)}` },
      action: ["Close", options.exit],
    }, true)
    else showToast({ text: "Comments are only for the site's team. Sign in with an account that may comment.", kind: "error", action: ["Close", options.exit] }, true)
  }

  function pageSelection(): Range | undefined {
    const selection = getSelection()
    if (!canComment.value || editing.value || resolving.value || !selection || selection.isCollapsed || selection.rangeCount === 0 || !selection.toString().trim()) return
    const range = selection.getRangeAt(0)
    const container = range.commonAncestorContainer
    const element = container instanceof Element ? container : container.parentElement
    if (!element?.isConnected || ignored(element) || element.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) return
    return range.cloneRange()
  }
  let barRange: Range | undefined
  let pressingBar = false
  function trackSelection() {
    if (pressingBar) return
    barRange = state?.draft.value ? undefined : pageSelection()
    const rect = barRange?.getBoundingClientRect()
    selected.value = rect && (rect.width || rect.height) ? { left: rect.left + rect.width / 2, top: rect.top, bottom: rect.bottom } : undefined
  }
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

  const highlights = typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight === "function"
  function paintHighlights() {
    if (!highlights) return
    const groups = { open: [] as Range[], resolved: [] as Range[], active: [] as Range[], draft: [] as Range[] }
    const active = new Set([state.openId.value, state.hoverId.value].filter(Boolean))
    const threads = state.threads.value.filter(thread => state.isShown(thread.id))
    for (const thread of threads) {
      if (thread.anchor.kind !== "text" || !state.isShown(thread.id)) continue
      const range = anchorRange(thread.anchor)
      if (range) groups[active.has(thread.id) ? "active" : thread.status === "resolved" ? "resolved" : "open"].push(range)
    }
    const draft = state.draft.value?.anchor
    if (draft?.kind === "text") {
      const range = anchorRange(toRaw(draft))
      if (range) groups.draft.push(range)
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
        if (value) void nameGuest(value)
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
        client: client.value,
        subject: () => subject.value,
        location: () => ({ href: location.href, origin: location.origin, search: search.value }),
        user: () => me.value,
        people: known,
        hotkey: false,
        ignore: ignored,
        can,
        uiRoot: () => shadow,
        autoStart: Boolean(session?.can.read),
        visibility,
      })
      watch(mode, value => options.onMode(value), { immediate: true, flush: "sync" })
      watch(() => state.status.value, (status) => {
        if (status === "ready" && !room) void joinRoom()
      })
      watch(() => state.status.value === "ready" && !resolving.value ? search.value : undefined, (readySearch) => {
        const current = navigations
        if (readySearch) void nextTick(() => {
          if (current === navigations && !resolving.value && location.search === readySearch) dropThreadLink()
        })
      }, { immediate: true })
      watch(() => state.counts.value.open, () => tick.value++)
      let cursorList: { element: HTMLElement; motion: MotionList } | undefined
      const moveCursors = () => {
        const element = cursorLayer.value
        if (cursorList && cursorList.element !== element) {
          cursorList.motion.destroy()
          cursorList = undefined
        }
        if (!element) return
        if (cursorList) cursorList.motion.play()
        else cursorList = { element, motion: createMotionList(element) }
        cursorList.motion.measure()
      }
      onMounted(moveCursors)
      onUpdated(moveCursors)
      onBeforeUnmount(() => cursorList?.motion.destroy())
      if (session?.send) watch(() => state.threads.value, () => void send.value?.refresh().catch(() => undefined))
      watch(panelStatus, (status) => {
        state.filters.resolved = status === "resolved"
      })
      watch(() => state.filters.resolved, (resolved) => {
        if (resolved) panelStatus.value = "resolved"
      })
      watch(() => state.draft.value, (draft) => {
        if (!draft || draft.anchor.kind === "page") return
        const target = document.elementsFromPoint(draft.point.x, draft.point.y).find(element => !ignored(element) && element !== document.documentElement)
        if (!target) return
        if (draft.anchor.kind === "element") draft.anchor = createAnchor(target, draft.point.x, draft.point.y)
        contexts.set(toRaw(draft.anchor), captureContext(target))
      }, { flush: "sync" })
      watch([pageChanges, state.pageThreads, state.openId, state.hoverId, () => state.draft.value?.anchor, state.shown], paintHighlights, { flush: "post" })
      watch(() => state.draft.value, trackSelection)
      watch(() => state.draft.value, (draft) => {
        if (ink && draft !== ink.draft) dropInk()
      })
      const islandTop = usePillClearance(options.toolbar)

      return () => {
        const nodes: Array<VNode | null> = []
        if (pageCan.value?.read && !resolving.value) {
          nodes.push(h(CommentLayer, { comments: state, readOnly: !me.value, queueFiles: canAttach.value, attachmentUrl: transport.attachmentUrl, style: islandTop.value ? { "--vh-comment-island-top": islandTop.value } : undefined }, { default: () => [], status: delivery, actions: threadActions }))
          nodes.push(h("div", { class: "cursors", ref: cursorLayer }, cursors()))
          nodes.push(h("div", { class: "outlines" }, outlines()))
          nodes.push(options.areas ? h(Teleport, { to: options.areas }, areas()) : h("div", { class: "areas" }, areas()))
          const bar = selected.value
          if (bar && !state.draft.value) {
            const touch = matchMedia("(pointer: coarse)").matches
            const under = bar.bottom + (touch ? 20 : 8)
            const below = bar.top < (touch ? 102 : 56) || (touch && under <= innerHeight - 46)
            const top = below ? Math.min(under, innerHeight - 46) : bar.top - (touch ? 64 : 8)
            nodes.push(h("div", {
              class: "selection",
              "data-below": below ? "true" : undefined,
              style: { left: `${Math.min(Math.max(64, bar.left), innerWidth - 64)}px`, top: `${top}px` },
              onPointerdown: (event: PointerEvent) => {
                event.preventDefault()
                pressingBar = true
                addEventListener("pointerup", () => setTimeout(() => {
                  if (!pressingBar) return
                  pressingBar = false
                  trackSelection()
                }, 300), { capture: true, once: true })
              },
            }, h(CommentSelectionBar, { side: below ? "bottom" : "top", onComment: () => commentOnSelection(barRange) })))
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
              queueFiles: canAttach.value,
              onSelect: (thread: { id: string }) => {
                const position = state.positions.value.get(thread.id)
                if (position && !position.detached) position.element?.scrollIntoView({ block: "center", behavior: "smooth" })
              },
            }, { status: delivery, actions: threadActions, "list-actions": listActions })))
          }
        }
        if (pageCan.value?.read && options.toolbar) nodes.push(h(Teleport, { to: options.toolbar }, toolbar()))
        if (naming.value) nodes.push(h(NameCard))
        const current = toast.value
        nodes.push(h("section", { role: "region", "aria-label": "Comments notifications" }, h("ol", { class: "toasts" }, current
          ? [h("li", { class: "toast", role: "status", "data-kind": current.kind, key: toastKey(current) }, [
              h("span", current.text),
              current.link ? h("a", { href: current.link.href, ...(current.link.newTab ? { target: "_blank", rel: "noopener noreferrer" } : {}) }, current.link.label) : null,
              current.action ? h(UButton, { color: "neutral", label: current.action[0], onClick: current.action[1], size: "sm", variant: "ghost" }) : null,
            ])]
          : [])))
        return nodes
      }
    },
  })

  function pickTip(tip: MarkerTip) {
    markTip.value = tip
    marker?.restyle()
  }

  function markerToolbar(): VNode {
    const keepFocus = (event: MouseEvent) => event.preventDefault()
    return h("div", { class: "toolbar", role: "group", "aria-label": "Highlight" }, [
      h("div", { class: "swatches" }, (Object.keys(markerTips) as MarkerTip[]).map(tip => h("button", {
        key: tip,
        class: "swatch",
        type: "button",
        "aria-label": markerTips[tip].label,
        "aria-keyshortcuts": markerTips[tip].key,
        "aria-pressed": String(markTip.value === tip),
        title: `${markerTips[tip].label} (${markerTips[tip].key})`,
        onClick: () => pickTip(tip),
      }, tipIcons[tip]()))),
      h("span", { class: "sep" }),
      h("div", { class: "swatches" }, (Object.keys(markerColors) as MarkerColor[]).map(name => h("button", {
        key: name,
        class: "swatch",
        type: "button",
        "aria-label": `${name[0]!.toUpperCase()}${name.slice(1)} ink`,
        "aria-pressed": String(markColor.value === name),
        onMousedown: keepFocus,
        onClick: () => {
          markColor.value = name
          marker?.restyle()
        },
      }, h("span", { style: { background: markerColors[name] } })))),
      h("span", { class: "sep" }),
      h("button", { type: "button", class: "icon", "aria-label": "Undo", "aria-keyshortcuts": "Meta+Z Control+Z", title: "Undo", disabled: marks.value === 0, onClick: () => marker?.undo() }, undoIcon()),
      h("button", { type: "button", onClick: () => setMode("view"), title: "Cancel (Esc)" }, "Cancel"),
      h("button", { type: "button", class: "done", "aria-keyshortcuts": "Enter", disabled: marks.value === 0, onClick: finishMarking, title: "Comment on the highlighted area (Enter)" }, "Done"),
    ])
  }

  function toolbar(): VNode {
    void tick.value
    if (marking.value) return markerToolbar()
    const signOutUrl = session?.signOut
    const github = signOutUrl ? session?.github : undefined
    const people = showPresence ? others(room?.people() ?? [], me.value?.id) : []
    const avatars = people.slice(0, 5).map(({ person, tabs }) =>
      h("span", { class: "avatar", key: person.id, title: tabs > 1 ? `${person.name} · ${tabs} tabs` : person.name, style: { background: person.color } }, person.image ? h("img", { src: person.image, alt: "" }) : initials(person.name)))
    const peopleLabel = `${people.length} other ${people.length === 1 ? "person" : "people"} on this page`
    const open = state.counts.value.open
    const commenting = commentOn.value
    const commentsHidden = visibility.value === "hidden"
    const visibilityLabel = commentsHidden ? "Show comments" : "Hide comments"
    const badge = (shown: boolean) => shown && open > 0 ? h(OpenCount, { value: open }) : null
    const togglePanel = () => (panelOpen.value ? pageWindow?.hide() : showPanel())
    const more = [
      commenting ? h("button", { "aria-expanded": String(panelOpen.value), onClick: togglePanel, title: "All comments on this page", type: "button" }, [listIcon(), "All comments", badge(!panelOpen.value)]) : null,
      canAttach.value ? h("button", { "aria-keyshortcuts": "B", "aria-pressed": "false", onClick: () => setMode("mark"), title: "Highlight the page and comment (B)", type: "button" }, [highlightIcon(), "Highlight"]) : null,
      session?.content && canComment.value ? h("button", { "aria-keyshortcuts": "E", "aria-pressed": String(mode.value === "edit"), onClick: () => setMode(mode.value === "edit" ? "view" : "edit"), title: "Edit text (E)", type: "button" }, [editIcon(), "Edit"]) : null,
    ].filter(node => node !== null)
    return h("div", { class: "toolbar", role: "group", "aria-label": "Comments" }, [
      h("span", { class: "lead" }, [
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
        canComment.value
          ? h("button", {
              "aria-label": visibilityLabel,
              class: "eye",
              "data-comments-hidden": String(commentsHidden),
              onClick: () => (visibility.value = commentsHidden ? "all" : "hidden"),
              title: visibilityLabel,
              type: "button",
            }, commentsHidden ? eyeOffIcon() : eyeIcon())
          : null,
      ]),
      send.value && canComment.value ? h(CommentSend, { client: send.value, key: `send:${page.value}` }) : null,
      canCopyPagePrompt.value
        ? h("button", {
            "data-action": "copy-page-prompt",
            onClick: () => void copyPagePrompt(),
            title: pageAgent.value ? "Copy a prompt that sends your agent to these comments in the ViteHub Console" : "Copy a prompt with the open comments for your agent",
            type: "button",
          }, h("span", { class: "swap" }, [
            h("span", { "data-shown": String(!pageCopied.value) }, [copyIcon(), "Copy prompt"]),
            h("span", { "data-shown": String(pageCopied.value) }, [checkIcon(), "Copied"]),
          ]))
        : null,
      more.length > 0 ? h("div", { class: "more", hidden: !moreOpen.value, id: "vitehub-comments-more", role: "group", "aria-label": "More comment tools" }, more) : null,
      more.length > 0
        ? h("button", {
            "aria-controls": "vitehub-comments-more",
            "aria-expanded": String(moreOpen.value),
            "aria-label": moreOpen.value ? "Fewer tools" : "More tools",
            class: "toggle",
            "data-action": "more-tools",
            onClick: () => (moreOpen.value = !moreOpen.value),
            title: moreOpen.value ? "Fewer tools" : "More tools",
            type: "button",
          }, plusIcon())
        : null,
      avatars.length > 0 ? h("span", { "aria-label": peopleLabel, class: "people" }, avatars) : null,
      signOutUrl && github
        ? h("button", { "aria-label": `Sign out @${github.login}`, onClick: () => void signOut(signOutUrl), title: `Signed in as @${github.login}. Sign out`, type: "button" },
            session?.user?.image ? h("img", { alt: "", class: "me", src: session.user.image }) : initials(session?.user?.name ?? github.login))
        : null,
    ])
  }

  function areas(): VNode[] {
    const nodes: VNode[] = []
    const box = (key: string, kind: CommentAnchor["kind"], marks: { status?: string, active?: boolean, draft?: boolean }) => {
      const position = state.positions.value.get(key)
      if (!position || position.detached || position.clipped || (kind !== "area" && kind !== "image") || !position.width || !position.height) return
      const leaving = key !== "draft" && state.leaving.value.has(key)
      if (key !== "draft" && !leaving && !state.isShown(key)) return
      nodes.push(h("div", {
        key,
        "data-leaving": leaving ? "true" : undefined,
        "data-active": marks.active ? "true" : undefined,
        "data-draft": marks.draft ? "true" : undefined,
        "data-slot": "comment-mark-area",
        "data-status": marks.status,
        style: { left: `${position.x}px`, top: `${position.y}px`, width: `${position.width}px`, height: `${position.height}px` },
      }))
    }
    const active = new Set([state.openId.value, state.hoverId.value])
    for (const thread of state.threads.value) box(thread.id, thread.anchor.kind, { status: thread.status, active: active.has(thread.id) })
    const draft = state.draft.value
    if (draft) box("draft", draft.anchor.kind, { draft: true })
    return nodes
  }

  function cursors(): VNode[] {
    void tick.value
    const nodes: VNode[] = []
    if (!showPresence) return nodes
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

  const app = createApp({ render: () => h(Overlay, { key: me.value?.id ?? "" }) })
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
  function resolvePage(next: string) {
    const current = ++navigations
    void api.session(next).then(async ([error, answer]) => {
      if (current !== navigations || page.value !== next) return
      if (error) {
        retryToast = { text: `${error.why} Comments are paused on this page.`, kind: "error", action: ["Retry", () => {
          if (page.value === next) resolvePage(next)
        }] }
        showToast(retryToast, true)
        return
      }
      clearRetry()
      pageCan.value = answer.can
      pageAgent.value = answer.agent
      pageRepository.value = answer.repository
      revision = answer.revision
      const mapped = answer.subject ?? { kind: "page", id: next }
      if (mapped.kind !== subject.value.kind || mapped.id !== subject.value.id) subject.value = mapped
      else if (!room && state.status.value === "ready") void joinRoom()
      await nextTick()
      if (current !== navigations) return
      resolving.value = false
      const resume = paused.value
      paused.value = false
      if (resume) setMode("comment")
    })
  }

  function pressComments() {
    if (canComment.value) setMode("comment")
    else showPanel()
  }

  const composerRoots = () => [shadow, panelTarget.value?.getRootNode()].filter(node => node instanceof ShadowRoot)
  const hasUnsentComment = () => composerRoots().some(root => root.querySelector("[data-slot='comment-composer'][data-dirty='true']") !== null)
  const hasPendingComment = () => hasUnsentComment() || Boolean(client.value.outbox?.entries.length)
  let finishHandoff: (() => void) | undefined
  let pendingHandoff: Promise<void> | undefined
  const waitForPendingComment = () => {
    if (pendingHandoff || !hasPendingComment()) return pendingHandoff
    showToast({ text: "Send or discard your Hosted Comments draft to switch to the app's Comments.", kind: "info" })
    pendingHandoff = new Promise<void>((resolve) => {
      const check = () => {
        if (!hasPendingComment()) finishHandoff?.()
      }
      const observer = new MutationObserver(check)
      const unsubscribe = client.value.onChange(check)
      finishHandoff = () => {
        observer.disconnect()
        unsubscribe()
        finishHandoff = undefined
        pendingHandoff = undefined
        resolve()
      }
      for (const root of composerRoots()) observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-dirty"] })
    })
    return pendingHandoff
  }

  return {
    app,
    hasUnsentComment,
    waitForPendingComment,
    showPanel,
    pressComments,
    setMode,
    finishEdit: edit.finish,
    navigated(next) {
      if (next === page.value) {
        search.value = location.search
        return
      }
      if (hasUnsentComment()) {
        if (!window.confirm("Discard your unsent comment and show comments for the new page?")) return
        state.cancelDraft()
      }
      naming.value = false
      namedQuote = undefined
      page.value = next
      clearTimeout(pageCopiedTimer)
      pageCopied.value = false
      search.value = location.search
      panelThread.value = null
      if (marking.value) setMode("view")
      dropInk()
      clearRetry()
      paused.value = paused.value || state.active.value
      state.active.value = false
      resolving.value = true
      resolvePage(next)
      leaveRoom()
    },
    refresh,
    pointer(event, target) {
      if (editing.value) {
        const field = target ? fieldElementOf(target) : undefined
        if (field !== hover.value) hover.value = field
      }
      if (!room || !target || !showPresence) return
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
      if (marking.value && !(event.key === "b" && markTip.value === "marker")) {
        const tip = tipOfKey(event)
        if (tip) pickTip(tip)
        else if (event.key === "Escape") setMode("view")
        else if (event.key === "Enter") finishMarking()
        else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") marker?.undo()
        else if (![" ", "PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown"].includes(event.key)) return
        event.preventDefault()
        return
      }
      if (isTyping(event) || event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key === "c" && canComment.value) {
        event.preventDefault()
        if (!commentOnSelection()) setMode(commentOn.value ? "view" : "comment")
      }
      if (event.key === "b" && canAttach.value) {
        event.preventDefault()
        setMode(mode.value === "mark" ? "view" : "mark")
      }
      if (event.key === "e" && session?.content && canComment.value) {
        event.preventDefault()
        setMode(mode.value === "edit" ? "view" : "edit")
      }
    },
    destroy() {
      finishHandoff?.()
      stopMarking()
      dropInk()
      clearHighlights()
      clearTimeout(toastTimer)
      void edit.finish(false)
      leaveRoom()
      app.unmount()
      pageWindow?.destroy()
      for (const stop of stopMotion) stop()
    },
  }
}
