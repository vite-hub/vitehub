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
  /** The member's last send, while the agent works on it. `thread` is the URL of the agent's thread. */
  working?: { id: string, thread?: string }
  /** While the member may not send, the time in ms when the next send may go. */
  retryAt?: number
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
}

/** Where a setup code is: not used yet, used by an agent that waits for Allow, too old, or used with a URL on another host. */
export type CommentSendPairingCheck =
  | { status: "waiting" }
  | { status: "paired", agent: CommentSendAgent }
  | { status: "expired" }
  | { status: "refused" }

/** The answer to a send: delivered, not delivered, or refused until `retryAt`. */
export type CommentSendResult =
  | { status: "sent", id: string, thread?: string }
  | { status: "failed", reason: string }
  | { status: "limited", retryAt: number }

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
  /** Pairs the agent that used `code` and sends the waiting threads to it. */
  allow: (code: string) => Promise<CommentSendResult>
  /** Drops `code`, so no agent can use it. */
  cancel: (code: string) => Promise<void>
  send: () => Promise<CommentSendResult>
  /** Pushes events, and returns a function that stops them. Without it, the client asks `status()` while the agent works. */
  subscribe?: (listener: (event: CommentSendEvent) => void) => () => void
}

/** What the Send segment shows. Every state has the number of waiting threads, `count`. */
export type CommentSendState =
  | { status: "idle", count: number, inbox: boolean, canPairAnother?: true }
  | { status: "pairing", count: number, prompt: string, expiresAt: number, agent: CommentSendAgent, reason?: "expired" | "refused" }
  | { status: "confirm", count: number, agent: CommentSendAgent }
  | { status: "sending", count: number }
  | { status: "sent", count: number, inbox: boolean }
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
  // The setup code while the member pairs, and whether a new one is on its way.
  let code: string | undefined
  let fetching = false
  // The send that the agent works on, so a late event of an older send changes nothing.
  let sendId: string | undefined
  let thread: string | undefined
  // Each new state starts a step. A timer or an answer of an older step changes nothing.
  let step = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let run = 0

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
  const idle = (): void => set({ status: "idle", count, inbox: inbox(), ...(agent && count > 0 ? { canPairAnother: true } : {}) })
  const working = (): void => {
    set({ status: "working", count, ...(agent ? { agent } : {}), ...(thread ? { thread } : {}) })
    // Without pushed events, ask until the agent is done. A failed ask tries again later.
    if (!transport.subscribe) later(statusInterval, () => void refresh().catch(working))
  }
  const limited = (retryAt: number): void => {
    set({ status: "limited", count, retryAt })
    later(Math.max(0, retryAt - Date.now()), () => void refresh().catch(idle))
  }

  const apply = (status: CommentSendStatus): void => {
    count = status.count
    agent = status.agent
    if (status.working) {
      sendId = status.working.id
      thread = status.working.thread
      // Sent keeps its 2 seconds. Working follows on its own.
      if (state.status === "sent") return
      return working()
    }
    sendId = undefined
    thread = undefined
    if (status.retryAt !== undefined && status.retryAt > Date.now()) return limited(status.retryAt)
    idle()
  }
  const refresh = async (): Promise<void> => {
    const at = step
    const status = await transport.status()
    // A press while the status loaded wins over it, and so does a state that waits for the member.
    if (at !== step || state.status === "pairing" || state.status === "confirm" || state.status === "sending") return
    apply(status)
  }

  const settle = (result: CommentSendResult, paired?: CommentSendAgent): void => {
    if (result.status === "failed") return set({ status: "failed", count, reason: result.reason })
    if (paired) agent = paired
    if (result.status === "limited") return limited(result.retryAt)
    sendId = result.id
    thread = result.thread
    count = 0
    set({ status: "sent", count, inbox: inbox() })
    later(sentFor, working)
  }
  const deliver = async (request: () => Promise<CommentSendResult>, paired?: CommentSendAgent): Promise<void> => {
    set({ status: "sending", count })
    const at = step
    let result: CommentSendResult
    try {
      result = await request()
    }
    catch (error) {
      result = { status: "failed", reason: reasonOf(error) }
    }
    if (at === step) settle(result, paired)
  }

  // A code that the member dropped expires on its own, so a failed cancel changes nothing that they can see.
  const drop = (dropped: string): void => void transport.cancel(dropped).catch(() => undefined)
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
    const at = step
    const pairing = transport.startPairing()
    // The copy starts now, inside the press, as Safari asks. It writes the prompt once it loads.
    const copied = copy?.(pairing.then(next => next.prompt)) ?? Promise.resolve(true)
    try {
      const next = await pairing
      const ok = await copied
      if (at !== step) return drop(next.code)
      if (!ok) {
        drop(next.code)
        return set({ status: "failed", count, reason: "The browser did not let the page copy the setup prompt." })
      }
      if (code) drop(code)
      code = next.code
      set({ status: "pairing", count, prompt: next.prompt, expiresAt: next.expiresAt, agent: next.agent })
      poll()
    }
    catch (error) {
      if (at === step) set({ status: "failed", count, reason: reasonOf(error) })
    }
    finally {
      fetching = false
    }
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
          count = event.count
          // A new count keeps the step: its timers and its answers on the way still count.
          if (state.status !== "sending") {
            state = { ...state, count }
            notify()
          }
          return
        }
        if (event.type === "working") {
          sendId = event.id
          thread = event.thread
          if (state.status === "idle" || state.status === "failed" || state.status === "limited" || state.status === "working") working()
          return
        }
        if (event.id === sendId && (state.status === "working" || state.status === "sent")) void refresh().catch(working)
      })
      // Until a status loads, the segment shows nothing: Send of zero threads is hidden.
      void refresh().catch(() => undefined)
      return () => {
        if (current === run) run++
        stop?.()
        clearTimeout(timer)
        if (code) drop(code)
        code = undefined
        step++
      }
    },
    refresh,
    async send(copy) {
      if (fetching) return
      if (state.status !== "idle" && state.status !== "failed" && state.status !== "working") return
      if (state.status !== "failed" && count === 0) return
      if (!agent) return pair(copy)
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
      return deliver(() => transport.allow(used), state.agent)
    },
    async copyAgain(copy) {
      if (state.status !== "pairing" || !state.reason) return
      return pair(copy)
    },
    cancel() {
      if (state.status !== "pairing" && state.status !== "confirm") return
      if (code) drop(code)
      code = undefined
      idle()
    },
  }
}
