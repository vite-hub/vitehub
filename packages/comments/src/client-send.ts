/** The logo that a Send segment shows for an agent. `@vite-hub/ui` draws each one. */
export type CommentSendLogo = "t3" | "claude" | "codex"

/** The agent that gets a member's comments. */
export interface CommentSendAgent {
  /** Its name, such as `T3 Code`. */
  name: string
  logo: CommentSendLogo
  /** The host that deliveries go to, such as `relay.t3.codes`. An inbox has none: the agent picks the comments up itself. */
  host?: string
}

/** What the server knows about the member's Send now. */
export interface CommentSendStatus {
  /** The open threads that wait for an answer and that no send has carried yet. */
  count: number
  /** The member's agent. Without one, Send pairs an agent first. */
  agent?: CommentSendAgent
  /** The member's last send, after the agent read it and while it works on it. `thread` is the URL of the agent's thread. */
  working?: { id: string, thread?: string }
  /**
   * The member's last send, delivered and not read by the agent yet. An inbox send stays here until the agent reads it.
   * `inbox` tells that this send went to an inbox, whatever agent the member has now.
   */
  sent?: { id: string, thread?: string, inbox?: true }
  /** The last delivery is still being attempted. */
  pending?: boolean
  /** While the member may not send, the time in ms when the next send may go. */
  retryAt?: number
  /** Names the `count` waiting threads and their last messages. Allow sends only the threads that it names. */
  selection?: string
}

/** A new setup code. The member pastes `prompt` in the agent's thread, and the agent pairs with `code`. */
export interface CommentSendPairing {
  code: string
  /** The setup prompt, with the code in it. */
  prompt: string
  /** The time in ms when the code stops working. */
  expiresAt: number
  /** The agent that the prompt is for. `host` is the only host its URL may have. */
  agent: CommentSendAgent
  /** The threads that wait now, which Allow sends, and the selection that names them. */
  count: number
  selection: string
}

/** Where a setup code is: not used yet, used by an agent that waits for Allow, too old, or used with a URL on another host. */
export type CommentSendPairingCheck =
  | { status: "waiting" }
  | { status: "paired", agent: CommentSendAgent }
  | { status: "expired" }
  | { status: "refused" }

/**
 * The answer to a send: delivered, not delivered, or refused until `retryAt`. Allow answers `changed` when the waiting
 * threads are not the ones that the member confirmed, and keeps the code for the new `count`.
 */
export type CommentSendResult =
  | { status: "sent" | "pending", id: string, thread?: string, inbox?: true }
  | { status: "failed", reason: string }
  | { status: "limited", retryAt: number }
  | { status: "changed", count: number, selection: string }

/** What the server pushes: the agent started on a send, finished it, or the number of waiting threads changed. */
export type CommentSendEvent =
  | { type: "working", id: string, thread?: string }
  | { type: "done", id: string }
  | { type: "count", count: number }

/** How a Send segment talks to the server. Comments `send: true` gives one over HTTP. */
export interface CommentSendTransport {
  status: () => Promise<CommentSendStatus>
  startPairing: () => Promise<CommentSendPairing>
  pollPairing: (code: string) => Promise<CommentSendPairingCheck>
  /** Pairs the agent that used `code` and sends the waiting threads that `selection` names to it. */
  allow: (code: string, selection: string) => Promise<CommentSendResult>
  /** Drops `code`, so no agent can use it. */
  cancel: (code: string) => Promise<void>
  send: () => Promise<CommentSendResult>
  /** Pushes events, and returns a function that stops them. Without it, the client asks `status()` while the agent works. */
  subscribe?: (listener: (event: CommentSendEvent) => void) => () => void
}

/**
 * What the Send segment shows. Every state has the number of waiting threads, `count`. In `sent`, `inbox` tells where
 * the last send went, and `agent` is where the next Send goes.
 */
export type CommentSendState =
  | { status: "idle", count: number, inbox: boolean, canPairAnother?: true }
  | { status: "pairing", count: number, prompt: string, expiresAt: number, agent: CommentSendAgent, reason?: "expired" | "refused" }
  | { status: "confirm", count: number, agent: CommentSendAgent }
  | { status: "sending", count: number }
  | { status: "sent", count: number, inbox: boolean, agent?: CommentSendAgent }
  | { status: "working", count: number, agent?: CommentSendAgent, thread?: string }
  | { status: "failed", count: number, reason: string }
  | { status: "limited", count: number, retryAt: number }

/** Writes the setup prompt to the clipboard once it loads. Resolves to `false` when the browser refuses. */
export type CommentSendCopy = (prompt: Promise<string>) => Promise<boolean>

export interface CommentSendOptions {
  /** How often, in ms, the client asks whether an agent used the setup code. Default 1500. */
  pairingInterval?: number
  /** How often, in ms, the client asks `status()` while the agent works and the transport cannot push. Default 5000. */
  statusInterval?: number
  /** How long, in ms, Sent shows before Working. Default 2000. */
  sentFor?: number
}

export interface CommentSendClient {
  readonly state: CommentSendState
  /** Calls `listener` after every change of `state`. Returns a function that stops it. */
  onChange: (listener: () => void) => () => void
  /** Loads the status, then follows the agent: pushed events, or `status()` while it works. Returns a function that stops it. */
  start: () => () => void
  /** Loads the status again, such as after the member wrote a comment. */
  refresh: () => Promise<void>
  /**
   * Send N, and Retry after Not delivered. Without an agent, it gets a setup code, gives its prompt to `copy`, and waits
   * for an agent to use the code.
   */
  send: (copy?: CommentSendCopy) => Promise<void>
  /** Starts a new pairing without changing where the regular Send button sends. */
  pairAnother: (copy?: CommentSendCopy) => Promise<void>
  /** Allow and send N: pairs the agent that used the code and sends to it. */
  allow: () => Promise<void>
  /** Copy again, after the code expired or the agent used a URL on another host. */
  copyAgain: (copy?: CommentSendCopy) => Promise<void>
  /** × or Escape while pairing: drops the code and goes back to Send N. */
  cancel: () => void
}

const reasonOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

/**
 * The Send segment of a comment pill, without a framework: it hands the member's waiting threads to their agent, and
 * pairs one in place first when there is none. `CommentSend` of `@vite-hub/ui` renders it.
 */
export function createCommentSend(transport: CommentSendTransport, options: CommentSendOptions = {}): CommentSendClient {
  const pairingInterval = options.pairingInterval ?? 1500
  const statusInterval = options.statusInterval ?? 5000
  const sentFor = options.sentFor ?? 2000
  const listeners = new Set<() => void>()
  let state: CommentSendState = { status: "idle", count: 0, inbox: false }
  let agent: CommentSendAgent | undefined
  let count = 0
  let countRevision = 0
  let selection = ""
  let selections = 0
  let code: string | undefined
  let fetching = false
  let sendId: string | undefined
  let thread: string | undefined
  let sentInbox = false
  let pushed: Map<string, { thread?: string, done?: boolean }> | undefined
  let step = 0
  let sentUntil = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let run = 0
  let lastStep: "pair" | "allow" | "send" = "send"

  const notify = (): void => {
    for (const listener of listeners) listener()
  }
  const set = (next: CommentSendState): void => {
    step++
    clearTimeout(timer)
    timer = undefined
    state = next
    notify()
  }
  const later = (ms: number, then: () => void): void => {
    const at = step
    clearTimeout(timer)
    timer = setTimeout(() => at === step && then(), ms)
  }
  const inbox = (): boolean => Boolean(agent && !agent.host)
  const needsStatus = (): boolean => state.status === "failed" && lastStep === "allow"
  const idleState = (): CommentSendState => ({ status: "idle", count, inbox: inbox(), ...(agent && count > 0 ? { canPairAnother: true } : {}) })
  const idle = (): void => set(idleState())
  const sentState = (): CommentSendState => ({ status: "sent", count, inbox: sentInbox, ...(agent ? { agent } : {}) })
  const finish = (): void => {
    sendId = undefined
    thread = undefined
    idle()
  }
  const working = (): void => {
    set({ status: "working", count, ...(agent ? { agent } : {}), ...(thread ? { thread } : {}) })
    if (!transport.subscribe) later(statusInterval, () => void refresh(working))
  }
  const sent = (): void => {
    set(sentState())
    if (!transport.subscribe) later(statusInterval, () => void refresh(sent))
  }
  const holdingSent = (): boolean => state.status === "sent" && Date.now() < sentUntil
  const limited = (retryAt: number): void => {
    set({ status: "limited", count, retryAt })
    later(Math.max(0, retryAt - Date.now()), () => void refresh(idle))
  }
  const pending = (): void => {
    set({ status: "sending", count })
    later(statusInterval, () => void refresh(pending, true))
  }

  const apply = (status: CommentSendStatus): void => {
    agent = status.agent
    if (status.pending) return pending()
    const last = status.working ?? status.sent
    if (last) {
      if (status.sent) sentInbox = Boolean(status.sent.inbox)
      const hold = holdingSent() && sendId === last.id
      sendId = last.id
      thread = hold ? thread ?? last.thread : last.thread
      if (hold) {
        state = sentState()
        return notify()
      }
      return status.working ? working() : sent()
    }
    sendId = undefined
    thread = undefined
    if (status.retryAt !== undefined && status.retryAt > Date.now()) return limited(status.retryAt)
    idle()
  }
  const refresh = async (onError?: () => void, deliveryPending = false): Promise<void> => {
    const at = step
    const canApply = (): boolean => at === step && !fetching && state.status !== "pairing" && state.status !== "confirm" && (state.status !== "sending" || deliveryPending)
    if (!canApply()) return
    const revision = countRevision
    try {
      const status = await transport.status()
      if (!canApply()) return
      if (revision === countRevision) count = status.count
      selection = status.selection ?? ""
      apply(status)
    }
    catch (error) {
      if (!onError) throw error
      if (canApply()) onError()
    }
  }

  const settle = (result: CommentSendResult, revision: number, paired?: { code: string, agent: CommentSendAgent }): void => {
    const updates = pushed
    pushed = undefined
    if (result.status === "changed") {
      count = result.count
      selection = result.selection
      if (!paired) return set({ status: "failed", count, reason: "The waiting comments changed." })
      code = paired.code
      return set({ status: "confirm", count, agent: paired.agent })
    }
    if (result.status === "failed") return set({ status: "failed", count, reason: result.reason })
    if (paired) agent = paired.agent
    if (result.status === "limited") return limited(result.retryAt)
    if (result.status === "pending") return pending()
    sendId = result.id
    const update = updates?.get(result.id)
    thread = update?.thread ?? result.thread
    if (revision === countRevision) count = 0
    sentInbox = Boolean(result.inbox)
    set(sentState())
    sentUntil = Date.now() + sentFor
    later(sentFor, update?.done ? finish : update ? working : () => void refresh(sent))
  }
  const drop = (dropped: string): void => void transport.cancel(dropped).catch(() => undefined)
  const deliver = async (request: () => Promise<CommentSendResult>, paired?: { code: string, agent: CommentSendAgent }): Promise<void> => {
    const revision = countRevision
    pushed = transport.subscribe ? new Map<string, { thread?: string, done?: boolean }>() : undefined
    set({ status: "sending", count })
    const at = step
    let result: CommentSendResult
    try {
      result = await request()
    }
    catch (error) {
      result = { status: "failed", reason: reasonOf(error) }
    }
    const current = at === step
    if (current) settle(result, revision, paired)
    if (paired && (result.status === "failed" || result.status === "limited" || (!current && result.status === "changed"))) drop(paired.code)
  }

  const poll = (): void => {
    later(pairingInterval, async () => {
      if (state.status !== "pairing" || !code) return
      if (Date.now() >= state.expiresAt) return set({ ...state, reason: "expired" })
      const at = step
      const check = await transport.pollPairing(code).catch(() => ({ status: "waiting" }) as const)
      if (at !== step || state.status !== "pairing") return
      if (check.status === "waiting") return poll()
      if (check.status === "paired") return set({ status: "confirm", count, agent: check.agent })
      set({ ...state, reason: check.status })
    })
  }
  const pair = async (copy: CommentSendCopy | undefined): Promise<void> => {
    if (fetching) return
    fetching = true
    lastStep = "pair"
    const at = ++step
    try {
      const pairing = transport.startPairing()
      const prompt = pairing.then(next => next.prompt)
      void prompt.catch(() => undefined)
      const copied = (async () => copy ? copy(prompt) : true)().then(ok => ({ ok }), (error: unknown) => ({ ok: false, error }))
      const next = await pairing
      const outcome = await copied
      if (at !== step) return drop(next.code)
      fetching = false
      if (!outcome.ok) {
        drop(next.code)
        const reason = "error" in outcome ? reasonOf(outcome.error) : "The browser did not let the page copy the setup prompt."
        return set({ status: "failed", count, reason })
      }
      if (code) drop(code)
      code = next.code
      count = next.count
      selection = next.selection
      set({ status: "pairing", count, prompt: next.prompt, expiresAt: next.expiresAt, agent: next.agent })
      poll()
    }
    catch (error) {
      if (at === step) {
        fetching = false
        set({ status: "failed", count, reason: reasonOf(error) })
      }
    }
  }

  const reselect = async (): Promise<void> => {
    const at = ++selections
    const pairing = code
    const status = await transport.status().catch(() => undefined)
    if (!status || at !== selections || !pairing || pairing !== code || (state.status !== "pairing" && state.status !== "confirm")) return
    count = status.count
    selection = status.selection ?? ""
    state = { ...state, count }
    notify()
  }

  return {
    get state() {
      return state
    },
    onChange(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    start() {
      const current = ++run
      const stop = transport.subscribe?.((event) => {
        if (current !== run) return
        if (event.type === "count") {
          countRevision++
          if (state.status === "pairing" || state.status === "confirm") return void reselect()
          count = event.count
          if (state.status !== "sending") {
            state = state.status === "idle" ? idleState() : { ...state, count }
            notify()
          }
          return
        }
        if (state.status === "sending") {
          const update = pushed?.get(event.id)
          pushed?.set(event.id, event.type === "done" ? { ...update, done: true } : { ...update, thread: event.thread ?? update?.thread })
          return
        }
        if (fetching || state.status === "pairing" || state.status === "confirm" || needsStatus()) return
        if ((state.status === "working" || state.status === "sent") && sendId !== event.id) return
        if (event.type === "working") {
          thread = event.thread ?? (event.id === sendId ? thread : undefined)
          sendId = event.id
          if (holdingSent()) later(sentUntil - Date.now(), working)
          else working()
          return
        }
        if (event.id === sendId) finish()
      })
      void refresh(() => undefined)
      return () => {
        stop?.()
        if (current !== run) return
        run++
        if (code) drop(code)
        code = undefined
        fetching = false
        pushed = undefined
        agent = undefined
        count = 0
        finish()
      }
    },
    refresh: () => refresh(),
    async send(copy) {
      if (fetching || (state.status !== "idle" && state.status !== "failed" && state.status !== "sent" && state.status !== "working")) return
      if (state.status !== "failed" && count === 0) return
      if (state.status === "failed" && lastStep === "pair") return pair(copy)
      if (needsStatus()) return refresh(() => undefined)
      if (!agent) return pair(copy)
      lastStep = "send"
      return deliver(() => transport.send())
    },
    async pairAnother(copy) {
      if (state.status !== "idle" || !state.canPairAnother) return
      return pair(copy)
    },
    async allow() {
      if (state.status !== "confirm" || !code) return
      const used = code
      code = undefined
      lastStep = "allow"
      return deliver(() => transport.allow(used, selection), { code: used, agent: state.agent })
    },
    async copyAgain(copy) {
      if (state.status !== "pairing" || !state.reason) return
      return pair(copy)
    },
    cancel() {
      if (state.status !== "pairing" && state.status !== "confirm") return
      if (code) drop(code)
      code = undefined
      fetching = false
      idle()
    },
  }
}
