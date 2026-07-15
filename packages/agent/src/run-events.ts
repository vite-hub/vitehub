import type { MaybePromise, ResolvedAgentRuntimeContext } from "./types.ts"

const bindAgentRunEventsSymbol = Symbol("vitehub.bindAgentRunEvents")

export interface AgentRunEvent<TData = unknown> {
  cursor: string
  data?: TData
  runId: string
  timestamp: string
  type: string
}

export interface AgentRunEventInput<TData = unknown> {
  data?: TData
  type: string
}

export interface AgentRunEventReadOptions {
  after?: string
}

export interface AgentRunEventSubscribeOptions extends AgentRunEventReadOptions {
  signal?: AbortSignal
}

export interface AgentRunEventStore {
  append(runId: string, event: AgentRunEventInput): MaybePromise<AgentRunEvent>
  read(runId: string, options?: AgentRunEventReadOptions): MaybePromise<readonly AgentRunEvent[]>
  /** Replays events after the cursor before yielding live events for the same run. */
  subscribe(runId: string, options?: AgentRunEventSubscribeOptions): AsyncIterable<AgentRunEvent>
}

export interface AgentRunEventStoreResolveContext {
  operation: "publish" | "read" | "subscribe"
  runId: string
  runtime?: ResolvedAgentRuntimeContext
}

export type AgentRunEventStoreResolver = (
  context: AgentRunEventStoreResolveContext,
) => MaybePromise<AgentRunEventStore>

export interface AgentRunEventsOptions {
  store: AgentRunEventStore | AgentRunEventStoreResolver
}

export interface AgentRunEventPublisher {
  publish<TData = unknown>(event: AgentRunEventInput<TData>): Promise<AgentRunEvent<TData>>
}

export interface AgentRunEvents {
  publish<TData = unknown>(runId: string, event: AgentRunEventInput<TData>): Promise<AgentRunEvent<TData>>
  read(runId: string, cursor?: string): Promise<readonly AgentRunEvent[]>
  subscribe(runId: string, cursor?: string, options?: { signal?: AbortSignal }): AsyncIterable<AgentRunEvent>
}

interface BoundAgentRunEvents extends AgentRunEvents {
  [bindAgentRunEventsSymbol](runtime: ResolvedAgentRuntimeContext): AgentRunEventPublisher | undefined
}

function assertRunId(runId: string): void {
  if (typeof runId !== "string" || !runId.trim()) {
    throw new TypeError("[vitehub] Agent Run Events require a non-empty run id.")
  }
}

function assertEvent(event: AgentRunEventInput): void {
  if (!event || typeof event !== "object" || typeof event.type !== "string" || !event.type.trim()) {
    throw new TypeError("[vitehub] Agent Run Events require an event with a non-empty type.")
  }
}

function isStore(value: AgentRunEventStore | AgentRunEventStoreResolver): value is AgentRunEventStore {
  return typeof value === "object" && value !== null
}

async function resolveStore(
  input: AgentRunEventStore | AgentRunEventStoreResolver,
  context: AgentRunEventStoreResolveContext,
): Promise<AgentRunEventStore> {
  const store = isStore(input) ? input : await input(context)
  if (!store || typeof store.append !== "function" || typeof store.read !== "function" || typeof store.subscribe !== "function") {
    throw new TypeError("[vitehub] Agent Run Events require a store with append(), read(), and subscribe().")
  }
  return store
}

export function defineAgentRunEvents(options: AgentRunEventsOptions): AgentRunEvents {
  if (!options || typeof options !== "object" || !("store" in options)) {
    throw new TypeError("[vitehub] defineAgentRunEvents() requires a store.")
  }

  const events: BoundAgentRunEvents = {
    [bindAgentRunEventsSymbol](runtime) {
      const runId = runtime.run?.runId
      if (!runId) return
      return {
        publish: async <TData = unknown>(event: AgentRunEventInput<TData>) => {
          assertEvent(event)
          const store = await resolveStore(options.store, { operation: "publish", runId, runtime })
          return await store.append(runId, event) as AgentRunEvent<TData>
        },
      }
    },
    async publish<TData = unknown>(runId: string, event: AgentRunEventInput<TData>): Promise<AgentRunEvent<TData>> {
      assertRunId(runId)
      assertEvent(event)
      const store = await resolveStore(options.store, { operation: "publish", runId })
      return await store.append(runId, event) as AgentRunEvent<TData>
    },
    async read(runId: string, cursor?: string): Promise<readonly AgentRunEvent[]> {
      assertRunId(runId)
      const store = await resolveStore(options.store, { operation: "read", runId })
      return await store.read(runId, cursor === undefined ? undefined : { after: cursor })
    },
    async *subscribe(runId: string, cursor?: string, subscribeOptions: { signal?: AbortSignal } = {}): AsyncIterable<AgentRunEvent> {
      assertRunId(runId)
      const store = await resolveStore(options.store, { operation: "subscribe", runId })
      yield* store.subscribe(runId, {
        ...(cursor === undefined ? {} : { after: cursor }),
        ...(subscribeOptions.signal ? { signal: subscribeOptions.signal } : {}),
      })
    },
  }
  return events
}

export function bindAgentRunEvents(events: AgentRunEvents | undefined, runtime: ResolvedAgentRuntimeContext): AgentRunEventPublisher | undefined {
  if (!events) return
  const bind = (events as Partial<BoundAgentRunEvents>)[bindAgentRunEventsSymbol]
  if (typeof bind !== "function") {
    throw new TypeError("[vitehub] defineAgent({ runEvents }) requires a definition created by defineAgentRunEvents().")
  }
  return bind.call(events, runtime)
}
