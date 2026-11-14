import { agentDiagnostics } from "./agent-diagnostics.ts"
import { pageHeader, pageRealtimeDefinition, pageRulesVersion } from "./internal/page.ts"

import type { PageRefusalCode, PageStepRule, PageStepRules } from "./internal/page.ts"

export type { PageStepRule, PageStepRules } from "./internal/page.ts"

declare const __VITEHUB_APP_BASE_URL__: string

/** One step of `act` as ui-sdk resolved it, the value its `allow` gets: ui-sdk's `AgentAction`. */
export interface PageStep {
  ref: string
  component: string
  label?: string
  action: string
  args: unknown[]
  /** What `data-agent-confirm` says the step does, or what a `requireApproval` rule asks the person to approve. */
  confirm?: string
}

/** ui-sdk's `Allow`: whether a step may run. */
export type PageAllow = (step: PageStep, context: { signal: AbortSignal }) => boolean | Promise<boolean>

/** A change to a component, as ui-sdk's `subscribe` reports it: its `ObservedChange`. */
export interface PageObservedChange {
  ref: string
  component: string
  label?: string
  key: string
  value: unknown
  previous: unknown
  source: string
}

/**
 * The ui-sdk bridge that `createAgent()` returns, from `@ui-sdk/vue/agent`, `@ui-sdk/core/agent`, or the bridge of another
 * framework. The page answers the Agent's `page_snapshot`, `page_query`, and `page_act` with these methods.
 */
export interface PageBridge {
  snapshot: () => unknown
  query: (input: { text?: string, within?: string, kind?: string }) => Promise<unknown>
  act: (input: { steps: Array<{ ref: string, action: string, args?: unknown[] }> }) => Promise<unknown>
  subscribe: (listener: (change: PageObservedChange) => void) => () => void
}

/** `createAgent` of ui-sdk, or a function that calls it with more options. `connectPage` passes the `allow`. */
export type CreatePageAgent<Bridge extends PageBridge = PageBridge> = (options: { allow: PageAllow }) => Bridge

/** The part of a Realtime room that the page uses, as `connectRealtimeRoom()` from `@vite-hub/realtime/client` returns it. */
export interface PageRoom {
  onRequest: (handler: (body: unknown) => unknown) => () => void
  onUpdate: (listener: () => void) => () => void
  status: () => "connected" | "connecting" | "disconnected"
  destroy: () => void
}

/** Joins one Realtime room, like `connectRealtimeRoom()` from `@vite-hub/realtime/client`. */
export type JoinPageRoom = (definition: string, room: string, options: { baseURL?: string }) => PageRoom

/** A change the Agent made on this page. */
export interface PageChange {
  /** Names the change in `page.undo(id)`, the journal, and `vitehub invocations undo`. */
  id: string
  ref: string
  label?: string
  /** The state key that changed: `value`, `checked`, or `pressed`. */
  key: string
  before: unknown
  after: unknown
  /** The index of the `page_act` step that made it. */
  step: number
  /** ISO time of the change. */
  at: string
  /** The field is private, so its values read `"[redacted]"` and undo cannot put it back. */
  redacted?: true
  /** Undo put `before` back. */
  undone?: true
}

/** A step a `requireApproval` rule, or `data-agent-confirm`, made the page ask the person about. */
export interface PageApproval {
  id: string
  label?: string
  component: string
  action: string
  args: unknown[]
  /** What the person was asked. */
  confirm: string
  approved: boolean
  at: string
}

export interface ConnectedPage<Bridge extends PageBridge = PageBridge> {
  /** This tab's page id. Empty during server rendering, where nothing connects. */
  readonly id: string
  /** The header that names this page on the request that starts an Agent: `{ "x-vitehub-page": id }`. */
  readonly headers: Readonly<Record<string, string>>
  /** Resolves when the page joined its Realtime room, or after 5 seconds, so a request sent after it finds the page. */
  readonly ready: Promise<void>
  /** The ui-sdk bridge that `connectPage` made. Undefined during server rendering. */
  readonly agent: Bridge | undefined
  /** Every change the Agent made on this page, oldest first. */
  changes: () => readonly PageChange[]
  /**
   * Puts back one change, or every change not undone yet, newest first. Resolves the changes it could not put back: a
   * private field, a field a person changed after the Agent, or a component that left the page. Undo puts values back;
   * it does not undo what a press did, like a save.
   */
  undo: (id?: string) => Promise<PageChange[]>
  /** Calls `listener` when `changes()` changes. Returns a function that removes it. */
  onChange: (listener: () => void) => () => void
  /** Leaves the room. The Agent's next page call returns `REALTIME_ROOM_EMPTY`. */
  close: () => void
}

export interface ConnectPageOptions {
  /** The app base path for a prebuilt client, such as `/portal/`. Defaults to the app's build-time base. */
  baseURL?: string
  /**
   * Joins the page's Realtime room: `connectRealtimeRoom` from `vite-hub/realtime/client`. The Agent package does not
   * load Realtime itself, so the page passes it.
   */
  join: JoinPageRoom
  /**
   * The page's own decision, ui-sdk's `allow`. It asks the person for a step with `step.confirm`: a step inside
   * `data-agent-confirm`, or one that a `requireApproval` rule of the server's `page()` matched. It runs only for steps the
   * server's rules let through, so it can refuse more, never less. Without it, a step that needs the person fails.
   *
   * @example allow: step => step.confirm ? window.confirm(step.confirm) : true
   */
  allow?: PageAllow
}

/** What one Agent call runs under: the server's rules, or an undo, which is the person's own action. */
type CallMode = { kind: "act", rules: PageStepRules, approvals: PageApproval[], refusal?: PageRefusalCode } | { kind: "undo" }

const methods = new Set(["act", "query", "snapshot", "undo"])
const recordedKeys = new Set(["value", "checked", "pressed"])
const redacted = "[redacted]"

function appBaseURL(): string | undefined {
  return typeof __VITEHUB_APP_BASE_URL__ === "undefined" ? undefined : __VITEHUB_APP_BASE_URL__
}

const fold = (text: string) => text.normalize("NFKD").replace(/\p{M}/gu, "").trim().toLowerCase()

/** Whether a resolved step matches a rule: every field the rule sets must match. */
export function pageRuleMatches(rule: PageStepRule, step: PageStep): boolean {
  if (rule.label !== undefined && (step.label === undefined || fold(rule.label) !== fold(step.label))) return false
  if (rule.component !== undefined && rule.component !== step.component) return false
  if (rule.confirm !== undefined && rule.confirm !== (step.confirm !== undefined)) return false
  return true
}

function same(a: unknown, b: unknown): boolean {
  return Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b)
}

function describeStep(step: PageStep): string {
  const name = step.label ?? step.component
  if (step.action === "press") return step.args.length ? `Press "${String(step.args[0])}" on ${name}` : `Press ${name}`
  const value = step.args.length ? `: ${step.args.map(arg => typeof arg === "string" ? arg : JSON.stringify(arg)).join(", ")}` : ""
  return `${step.action} ${name}${value}`
}

function readRules(value: unknown): PageStepRules | undefined {
  if (!value || typeof value !== "object" || !("deny" in value) || !("requireApproval" in value)) return
  const list = (rules: unknown) => Array.isArray(rules) ? rules.filter((rule): rule is PageStepRule => !!rule && typeof rule === "object") : []
  return { deny: list(value.deny), requireApproval: list(value.requireApproval) }
}

/**
 * Lets a ViteHub Agent work this page through ui-sdk's agent bridge, under the server's rules. `connectPage` makes the
 * bridge with `createAgent({ allow })`, so it decides each step after ui-sdk resolves it: a step a `deny` rule of
 * `page()` matches is refused, and one a `requireApproval` rule matches asks the person through the page's own
 * `allow`. The page joins its own Realtime room with `join`, named by a random page id, and answers the Agent's
 * `page_snapshot`, `page_query`, and `page_act`. Pass the result to `useChat(agent, { page })`, or send `headers` with the
 * request that starts the Agent. Every change the Agent makes is in `changes()`, and `undo()` puts it back. During
 * server rendering it does nothing.
 *
 * @example
 * const page = connectPage(createAgent, { join: connectRealtimeRoom, allow: step => step.confirm ? confirm(step.confirm) : true })
 * const chat = useChat(useAgent("settings"), { page })
 */
export function connectPage<Bridge extends PageBridge>(createAgent: CreatePageAgent<Bridge>, options: ConnectPageOptions): ConnectedPage<Bridge> {
  if (typeof createAgent !== "function") throw agentDiagnostics.AGENT_R1051()
  if (!("window" in globalThis)) {
    return { id: "", headers: {}, ready: Promise.resolve(), agent: undefined, changes: () => [], undo: async () => [], onChange: () => () => {}, close: () => {} }
  }
  if (typeof options?.join !== "function") throw agentDiagnostics.AGENT_R1046()
  const lifetime = new AbortController()
  const pageAllow = options.allow
  let mode: CallMode | undefined
  const changes: PageChange[] = []
  const listeners = new Set<() => void>()
  const emit = () => {
    for (const listener of listeners) listener()
  }

  async function askPage(step: PageStep, context: { signal: AbortSignal }): Promise<boolean> {
    const signal = AbortSignal.any([context.signal, lifetime.signal])
    if (signal.aborted || !pageAllow) return false
    let cancel: () => void = () => {}
    const aborted = new Promise<boolean>((resolve) => {
      cancel = () => resolve(false)
      signal.addEventListener("abort", cancel, { once: true })
    })
    try {
      const approved = await Promise.race([pageAllow(step, { signal }), aborted])
      return !signal.aborted && approved
    }
    finally {
      signal.removeEventListener("abort", cancel)
    }
  }

  async function needsPerson(step: PageStep, context: { signal: AbortSignal }, current: Extract<CallMode, { kind: "act" }> | undefined): Promise<boolean> {
    const asked: PageStep = { ...step, confirm: step.confirm ?? `Allow the Agent to ${describeStep(step)}?` }
    if (!pageAllow) {
      if (current) current.refusal = "AGENT_R1048"
      return false
    }
    const approved = await askPage(asked, context)
    if (current) {
      current.approvals.push({ id: crypto.randomUUID(), ...(step.label === undefined ? {} : { label: step.label }), component: step.component, action: step.action, args: step.args, confirm: asked.confirm!, approved, at: new Date().toISOString() })
      if (!approved) current.refusal = "AGENT_R1049"
    }
    return approved
  }

  // ui-sdk calls this for every step after it resolves it. The server's rules apply only while an Agent call runs.
  const allow: PageAllow = async (step, context) => {
    if (lifetime.signal.aborted || context.signal.aborted) return false
    const current = mode
    if (current?.kind === "undo") return step.confirm === undefined || await needsPerson(step, context, undefined)
    if (!current) return pageAllow ? await askPage(step, context) : step.confirm === undefined
    // The pinned SDK identifies a container, not the descendant button it presses. Refuse that
    // ambiguous path under policy; callers can press the registered button directly instead.
    if (step.action === "press" && step.component !== "button" && (current.rules.deny.length || current.rules.requireApproval.length)) {
      current.refusal = "AGENT_R1047"
      return false
    }
    if (current.rules.deny.some(rule => pageRuleMatches(rule, step))) {
      current.refusal = "AGENT_R1047"
      return false
    }
    if (step.confirm !== undefined || current.rules.requireApproval.some(rule => pageRuleMatches(rule, step))) return await needsPerson(step, context, current)
    current.refusal = undefined
    if (!pageAllow) return true
    const allowed = await askPage(step, context)
    if (!allowed) current.refusal = undefined
    return allowed
  }

  const agent = createAgent({ allow })
  if (!agent || typeof agent.act !== "function" || typeof agent.subscribe !== "function") throw agentDiagnostics.AGENT_R1051()

  // The Agent's changes during one call, by ref and key, in the order they first changed.
  let recording: Map<string, PageChange> | undefined
  agent.subscribe((change) => {
    if (!recording || change.source !== "agent" || !recordedKeys.has(change.key)) return
    const key = `${change.ref}:${change.key}`
    const seen = recording.get(key)
    if (seen) {
      seen.after = change.value
      return
    }
    recording.set(key, {
      id: `chg_${crypto.randomUUID()}`,
      ref: change.ref,
      ...(change.label === undefined ? {} : { label: change.label }),
      key: change.key,
      before: change.previous,
      after: change.value,
      step: -1,
      at: new Date().toISOString(),
      ...(change.value === redacted || change.previous === redacted ? { redacted: true as const } : {}),
    })
  })

  // One Agent call at a time, in order, so the rules of one call never apply to another.
  let queue: Promise<unknown> = Promise.resolve()
  const inTurn = <T>(run: () => Promise<T>): Promise<T> => {
    const next = queue.then(() => {
      if (lifetime.signal.aborted) throw new Error("This page is closed.")
      return run()
    })
    queue = next.catch(() => {})
    return next
  }

  async function act(input: unknown, rules: PageStepRules) {
    const current: Extract<CallMode, { kind: "act" }> = { kind: "act", rules, approvals: [] }
    mode = current
    recording = new Map()
    let result: unknown
    try {
      // SAFETY: ui-sdk checks every step of `act`, and answers a bad one with `ok: false`.
      result = await agent.act(input as Parameters<PageBridge["act"]>[0])
    }
    finally {
      mode = undefined
    }
    const made = [...recording.values()]
    recording = undefined
    const log = result && typeof result === "object" && "steps" in result && Array.isArray(result.steps) ? result.steps : []
    for (const change of made) {
      const entry: unknown = log.find((item: unknown) => item && typeof item === "object" && "ref" in item && item.ref === change.ref)
      change.step = entry && typeof entry === "object" && "step" in entry && typeof entry.step === "number" ? entry.step : -1
    }
    if (made.length) {
      changes.push(...made)
      emit()
    }
    const error = result && typeof result === "object" && "error" in result && result.error && typeof result.error === "object" ? result.error : undefined
    const message = error && "message" in error && typeof error.message === "string" ? error.message : ""
    // Only a refusal ends `act` with these words. A refused step that ui-sdk skips, like a section it did not open, does not.
    const refused = current.refusal && /^(The app refused |The person said no to )/.test(message) && error && "step" in error && typeof error.step === "number"
      ? { step: error.step, code: current.refusal }
      : undefined
    return { rules: pageRulesVersion, result, changes: made, approvals: current.approvals, ...(refused ? { refused } : {}) }
  }

  function current(change: PageChange): unknown {
    const snapshot = agent.snapshot()
    const component: unknown = Array.isArray(snapshot) ? snapshot.find((item: unknown) => item && typeof item === "object" && "ref" in item && item.ref === change.ref) : undefined
    if (!component || typeof component !== "object" || ("offPage" in component && component.offPage === true)) return undefined
    // SAFETY: ui-sdk's snapshot entries are plain objects keyed by state name.
    return change.key in component ? (component as Record<string, unknown>)[change.key] : undefined
  }

  async function undo(id?: string): Promise<PageChange[]> {
    const targets = (id === undefined ? changes.filter(change => !change.undone) : changes.filter(change => change.id === id)).reverse()
    const notRestored: PageChange[] = []
    for (const change of targets) {
      // A person's later edit wins, and a private value reads "[redacted]", which must never land in the field.
      if (change.undone || change.redacted || !same(current(change), change.after)) {
        notRestored.push(change)
        continue
      }
      mode = { kind: "undo" }
      let result: unknown
      try {
        result = await agent.act({ steps: [{ ref: change.ref, action: `set${change.key[0]!.toUpperCase()}${change.key.slice(1)}`, args: [change.before] }] })
      }
      finally {
        mode = undefined
      }
      if (!result || typeof result !== "object" || !("ok" in result) || result.ok !== true || !same(current(change), change.before)) {
        notRestored.push(change)
        continue
      }
      change.undone = true
    }
    if (targets.length > notRestored.length) emit()
    return notRestored
  }

  // A new id for each page load: a duplicated tab copies sessionStorage, and two tabs must never share one room.
  const id = crypto.randomUUID()
  const baseURL = options.baseURL ?? appBaseURL()
  const room = options.join(pageRealtimeDefinition, id, baseURL ? { baseURL } : {})
  const warned = new Set<string>()
  room.onRequest(body => answer(body))

  /** Runs one Agent call. The input is the model's, so its shape is checked here. */
  async function answer(body: unknown): Promise<unknown> {
    if (!body || typeof body !== "object" || !("method" in body) || typeof body.method !== "string" || !methods.has(body.method)) {
      return { ok: false, error: "Unknown page call: use page_snapshot, page_query, or page_act." }
    }
    const input: unknown = "input" in body && body.input && typeof body.input === "object" ? body.input : {}
    const rules = readRules("rules" in body ? body.rules : undefined)
    if (body.method === "snapshot") {
      const snapshot = await inTurn(async () => agent.snapshot())
      if (rules) warnUnmatched(rules, snapshot)
      return snapshot
    }
    // SAFETY: ui-sdk checks each query field itself, and answers a bad one with `ok: false`.
    if (body.method === "query") return await inTurn(() => agent.query(input as Parameters<PageBridge["query"]>[0]))
    if (body.method === "undo") {
      const change = input && typeof input === "object" && "change" in input && typeof input.change === "string" ? input.change : undefined
      if (!change || !changes.some(item => item.id === change)) return { rules: pageRulesVersion, ok: false, error: "This page has no such change. It may have been reloaded." }
      const notRestored = await inTurn(() => undo(change))
      return { rules: pageRulesVersion, ok: notRestored.length === 0, notRestored }
    }
    // A page that gets no rules refuses to act, so an old server cannot run steps the developer meant to stop.
    if (!rules) return { ok: false, error: "This page needs the server's rules to act. Update vite-hub on the server." }
    return await inTurn(() => act(input, rules))
  }

  // In development, a `label` rule that matches nothing on the page is likely a copy change: say so once.
  function warnUnmatched(rules: PageStepRules, snapshot: unknown) {
    // SAFETY: Vite sets `import.meta.env`; elsewhere it is undefined, and the warning stays off.
    if (!Array.isArray(snapshot) || !(import.meta as { env?: { DEV?: boolean } }).env?.DEV) return
    const labels = new Set(snapshot.flatMap((item: unknown) => item && typeof item === "object" && "label" in item && typeof item.label === "string" ? [fold(item.label)] : []))
    for (const rule of [...rules.deny, ...rules.requireApproval]) {
      if (rule.label === undefined || labels.has(fold(rule.label)) || warned.has(rule.label)) continue
      warned.add(rule.label)
      console.warn(`[vitehub] page() has a rule for the label "${rule.label}", and no component on this page has it. Check the label, or mark the element with data-agent-confirm.`)
    }
  }

  const ready = room.status() === "connected"
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        // The server waits a few seconds for a page to join, so a slow connection does not hold the request.
        const timer = setTimeout(done, 5_000)
        const stop = room.onUpdate(() => {
          if (room.status() === "connected") done()
        })
        function done() {
          clearTimeout(timer)
          stop()
          resolve()
        }
      })
  return {
    id,
    headers: Object.freeze({ [pageHeader]: id }),
    ready,
    agent,
    changes: () => changes,
    undo: id => inTurn(() => undo(id)),
    onChange: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close: () => {
      lifetime.abort()
      room.destroy()
    },
  }
}
