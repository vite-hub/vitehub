import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from "vue"

import type { ComputedRef, Ref, ShallowRef } from "vue"

import type { ConsoleDocumentPresence, ConsoleDocumentSession, ConsoleDocumentSessionAction, ConsoleDocumentSessionUser, ConsoleDocumentsClient } from "./documents"

type PageListener = (event: { persisted?: boolean }) => void

interface PageEvents {
  addEventListener(type: string, listener: PageListener): void
  removeEventListener(type: string, listener: PageListener): void
}

// The Console helpers compile without DOM types, so the page is read through the few members presence uses.
// SAFETY: The Console runs in a browser, where `window` and `document` have these members.
const page = globalThis as unknown as PageEvents & { document: PageEvents & { visibilityState: string } }

function hidden(): boolean {
  return page.document.visibilityState === "hidden"
}

/** One token per page load: two tabs of one person are two sessions, and a reload starts a new one. */
function tabToken(): string {
  const random = globalThis.crypto?.randomUUID?.()
  return random ?? `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

/** This tab's session token. List rows and the editor share it, so both mark this tab as `self`. */
export const consoleTabSession: string = tabToken()

/** Reports every 15 seconds while visible and every 60 seconds while hidden. 15 minutes without input drops to viewing. */
export const consolePresenceTimings: Readonly<{ hidden: number, idle: number, visible: number }> = Object.freeze({ visible: 15_000, hidden: 60_000, idle: 15 * 60_000 })

/**
 * - `free`: nobody else edits, or this tab has not edited yet. The first edit claims the lease.
 * - `editing`: this tab holds the lease.
 * - `blocked`: another tab holds it and this tab chose read-only.
 * - `taken`: this tab held it and another tab took over.
 * - `left`: the tab that blocked this one stopped editing.
 */
export type ConsoleLeaseMode = "blocked" | "editing" | "free" | "left" | "taken"

export interface ConsoleDocumentPresenceState {
  /** Who has the document open. Undefined before the first answer. */
  presence: ShallowRef<ConsoleDocumentPresence | undefined>
  /** The last session request failed: the editor stays editable and `ifDigest` still guards saves. */
  unreachable: Ref<boolean>
  mode: Ref<ConsoleLeaseMode>
  /** Another tab that holds the lease now, or held it last for `taken` and `left`. */
  holder: ShallowRef<ConsoleDocumentSession | undefined>
  /** The "is editing this page" dialog. */
  dialogOpen: Ref<boolean>
  /** Other tabs with the document open, editors first. */
  others: ComputedRef<ConsoleDocumentSession[]>
  /** Whether saves may run now: the lease is held, or sessions do not apply. */
  mayWrite: ComputedRef<boolean>
  /** Whether sessions can be checked at all. */
  tracked: ComputedRef<boolean>
  /** Whether the holder is this person in another tab. */
  ownOtherTab: ComputedRef<boolean>
  /** Takes the lease on the first edit. Resolves false when another tab holds it; the dialog then opens. */
  claim: () => Promise<boolean>
  takeover: () => Promise<boolean>
  /** Records input, so the lease does not go idle. */
  input: () => void
  readOnly: () => void
  /** Leaves `left` for `free`, after the caller reloads the document. */
  resume: () => void
  /** Reports now, such as after a save. */
  refresh: () => Promise<void>
}

/**
 * Presence and the edit lease of one open document. It reports on a visibility-aware loop, claims the lease on the
 * first edit, drops to viewing after 15 minutes without input, and releases on `pagehide` with a keepalive request.
 */
export function useConsoleDocumentPresence(options: {
  client: ConsoleDocumentsClient
  collection: string
  /** Undefined while creating a document: nothing to report yet. */
  documentId: () => string | undefined
  canWrite: () => boolean
  /**
   * True while this tab edits in the live room of the document. The room holds the lease for everyone in it, so this
   * tab reports presence only: it never claims, and a live holder opens no dialog.
   */
  live?: () => boolean
  /** Called with the draft digest of each answer. */
  onDigest?: (digest: string | null) => void
}): ConsoleDocumentPresenceState {
  const presence = shallowRef<ConsoleDocumentPresence>()
  const unreachable = ref(false)
  const mode = ref<ConsoleLeaseMode>("free")
  const holder = shallowRef<ConsoleDocumentSession>()
  const dialogOpen = ref(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastInput = Date.now()
  let inputSinceReport = false
  let claiming: Promise<boolean> | undefined
  let opened = false
  let stopped = false

  const tracked = computed(() => !unreachable.value && presence.value?.available !== false)
  const live = () => options.live?.() === true
  const leased = computed(() => tracked.value && presence.value?.lease !== false && !live())
  const mayWrite = computed(() => !leased.value || mode.value === "editing")
  const others = computed(() => presence.value?.sessions.filter(session => !session.self) ?? [])
  const ownOtherTab = computed(() => Boolean(holder.value && presence.value?.user && holder.value.user.id === presence.value.user.id))

  function apply(result: ConsoleDocumentPresence): void {
    presence.value = result
    unreachable.value = false
    if (result.digest !== undefined) options.onDigest?.(result.digest)
    if (!result.available || !result.lease) {
      if (result.editing) mode.value = "editing"
      return
    }
    // The live room of this document holds the lease for this tab too.
    const other = result.holder && !result.holder.self && !(live() && result.holder.kind === "live") ? result.holder : undefined
    if (result.editing) {
      mode.value = "editing"
      holder.value = undefined
    }
    else if (other) {
      holder.value = other
      if (mode.value === "editing") mode.value = "taken"
      else if (mode.value === "left") mode.value = "blocked"
    }
    else if (mode.value === "blocked" || mode.value === "taken") mode.value = "left"
    // An idle or expired lease lapsed: the next edit claims it again.
    else if (mode.value === "editing") mode.value = "free"
    // A held document opens with the dialog, so a writer decides before typing.
    if (!opened) {
      opened = true
      if (other && options.canWrite()) {
        mode.value = "blocked"
        dialogOpen.value = true
      }
    }
  }

  async function send(action: ConsoleDocumentSessionAction, extra: { input?: boolean, kind?: "edit" | "view" } = {}): Promise<void> {
    const id = options.documentId()
    if (id === undefined || stopped) return
    try {
      apply(await options.client.session(options.collection, id, { action, session: consoleTabSession, ...extra }))
    }
    catch {
      unreachable.value = true
    }
  }

  async function report(): Promise<void> {
    const idle = mode.value === "editing" && Date.now() - lastInput > consolePresenceTimings.idle
    // After 15 minutes without input, this tab views again and frees the lease.
    const kind = mode.value === "editing" && !idle ? "edit" : "view"
    const input = inputSinceReport
    inputSinceReport = false
    await send("report", input ? { kind, input } : { kind })
    if (idle && mode.value === "editing") mode.value = "free"
  }

  function schedule(): void {
    clearTimeout(timer)
    if (stopped) return
    const delay = hidden() ? consolePresenceTimings.hidden : consolePresenceTimings.visible
    timer = setTimeout(() => void report().finally(schedule), delay)
  }

  async function refresh(): Promise<void> {
    await report()
    schedule()
  }

  function claim(): Promise<boolean> {
    if (!leased.value || mode.value === "editing") return Promise.resolve(true)
    if (mode.value !== "free") return Promise.resolve(false)
    lastInput = Date.now()
    claiming ??= send("acquire").then(() => {
      if (mode.value === "editing" || !leased.value) return true
      // Another tab took the lease first.
      if (presence.value?.holder && !presence.value.holder.self) {
        holder.value = presence.value.holder
        mode.value = "blocked"
        dialogOpen.value = true
      }
      return false
    }).finally(() => {
      claiming = undefined
    })
    return claiming
  }

  async function takeover(): Promise<boolean> {
    if (!options.canWrite()) return false
    lastInput = Date.now()
    await send("takeover")
    dialogOpen.value = false
    return mode.value === "editing" || !leased.value
  }

  function release(keepalive: boolean): void {
    const id = options.documentId()
    if (id === undefined) return
    void options.client.session(options.collection, id, { action: "release", session: consoleTabSession }, { keepalive }).catch(() => undefined)
  }

  function onVisibility(): void {
    // A tab that comes back reports at once, which renews a lease it holds.
    if (!hidden()) void refresh()
  }

  function onPageHide(): void {
    release(true)
  }

  function onPageShow(event: { persisted?: boolean }): void {
    // A page restored from the back-forward cache released its session on pagehide.
    if (event.persisted) {
      mode.value = "free"
      void refresh()
    }
  }

  onMounted(() => {
    page.document.addEventListener("visibilitychange", onVisibility)
    page.addEventListener("pagehide", onPageHide)
    page.addEventListener("pageshow", onPageShow)
    void refresh()
  })
  onBeforeUnmount(() => {
    stopped = true
    clearTimeout(timer)
    page.document.removeEventListener("visibilitychange", onVisibility)
    page.removeEventListener("pagehide", onPageHide)
    page.removeEventListener("pageshow", onPageShow)
    release(false)
  })

  return {
    presence,
    unreachable,
    mode,
    holder,
    dialogOpen,
    others,
    mayWrite,
    tracked,
    ownOtherTab,
    claim,
    takeover,
    input: () => {
      lastInput = Date.now()
      inputSinceReport = true
    },
    readOnly: () => {
      dialogOpen.value = false
      if (mode.value === "free") mode.value = "blocked"
    },
    resume: () => {
      mode.value = "free"
      holder.value = undefined
    },
    refresh,
  }
}

/** Polls every open tab of readable collections for list rows and the dashboard, visible-aware like the editor. */
export function useConsoleDocumentSessions(options: { client: ConsoleDocumentsClient, collection?: string }): {
  sessions: ShallowRef<ConsoleDocumentSession[]>
  /** The signed-in user, so their other tabs read as "You". */
  user: ShallowRef<ConsoleDocumentSessionUser | null>
  /** The sessions of one document, editors first. */
  of: (collection: string, id: string) => ConsoleDocumentSession[]
} {
  const sessions = shallowRef<ConsoleDocumentSession[]>([])
  const user = shallowRef<ConsoleDocumentSessionUser | null>(null)
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  async function load(): Promise<void> {
    try {
      const result = await options.client.sessions({ session: consoleTabSession, ...(options.collection ? { collection: options.collection } : {}) })
      sessions.value = result.available ? result.sessions : []
      user.value = result.user
    }
    catch {
      // Presence is extra information: a failed poll keeps the last answer.
    }
  }

  function schedule(): void {
    clearTimeout(timer)
    if (stopped) return
    timer = setTimeout(() => void load().finally(schedule), hidden() ? consolePresenceTimings.hidden : consolePresenceTimings.visible)
  }

  function onVisibility(): void {
    if (!hidden()) void load().finally(schedule)
  }

  onMounted(() => {
    page.document.addEventListener("visibilitychange", onVisibility)
    void load().finally(schedule)
  })
  onBeforeUnmount(() => {
    stopped = true
    clearTimeout(timer)
    page.document.removeEventListener("visibilitychange", onVisibility)
  })

  return {
    sessions,
    user,
    of: (collection, id) => {
      const open = sessions.value.filter(session => session.collection === collection && session.id === id && !session.self)
      // A live room stands for the people in it: their own tabs only add the people who view without editing live.
      const live = open.find(session => session.kind === "live")
      const names = new Set(live ? consoleLiveNames(live) : [])
      const rank = (session: ConsoleDocumentSession) => (session.kind === "view" ? 1 : 0)
      return open.filter(session => session === live || !(session.kind === "view" && names.has(session.user.name))).sort((left, right) => rank(left) - rank(right))
    },
  }
}

/** Initials for an avatar without an image, such as `AL` for Ada Lovelace. */
export function consoleInitials(name: string): string {
  const parts = name.replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean)
  return (parts.length > 1 ? `${parts[0]![0]}${parts.at(-1)![0]}` : (parts[0] ?? "?").slice(0, 2)).toUpperCase()
}

/** A clock time such as `10:42`, for "Editing since 10:42" and "Your changes up to 10:42 are saved". */
export function consoleClockTime(value: string | null | undefined): string {
  if (!value) return ""
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
}

/** The people of a live room as session rows, so the presence avatars show them as editing. */
export function consoleLiveSessions(collection: string, id: string, people: ReadonlyArray<{ id: string, image?: string, name: string }>): ConsoleDocumentSession[] {
  return people.map(person => ({
    collection,
    id,
    kind: "edit",
    self: false,
    since: null,
    user: person.image ? { id: person.id, image: person.image, name: person.name } : { id: person.id, name: person.name },
  }))
}

/** The names in a live session row, such as `Ana, Ben`. */
export function consoleLiveNames(session: Pick<ConsoleDocumentSession, "user">): string[] {
  return session.user.name.split(",").map(name => name.trim()).filter(Boolean)
}

/** Copy for a live room: who is in it, such as `Live session: Ana, Ben`. */
export function consoleLiveLabel(session: Pick<ConsoleDocumentSession, "user">): string {
  return `Live session: ${consoleLiveNames(session).join(", ")}`
}

/** Shown where a document would allow live editing but the host cannot run it. */
export const consoleLiveUnavailable = "Live editing unavailable · one editor at a time"

/** Whether a document can be edited live: Markdown, already saved, and live editing installed. */
export function consoleLiveDefinition(setup: { live?: { definition: string } | { unavailable: string } } | undefined): string | undefined {
  const live = setup?.live
  return live && "definition" in live ? live.definition : undefined
}
