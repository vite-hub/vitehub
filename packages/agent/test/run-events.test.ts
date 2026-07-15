import { describe, expect, it, vi } from "vitest"

import { defineAgent, defineCapability, runAgent } from "../src/index.ts"
import { defineAgentRunEvents } from "../src/server.ts"

import type {
  AgentRunEvent,
  AgentRunEventInput,
  AgentRunEventStore,
  AgentRunEventSubscribeOptions,
} from "../src/server.ts"

function memoryStore() {
  const events: AgentRunEvent[] = []
  const subscribe = vi.fn((runId: string, options?: AgentRunEventSubscribeOptions): AsyncIterable<AgentRunEvent> => (async function* () {
    const cursor = Number(options?.after || 0)
    for (const event of events) {
      if (event.runId === runId && Number(event.cursor) > cursor) yield event
    }
  })())
  const store: AgentRunEventStore = {
    append(runId, event) {
      const stored = {
        ...event,
        cursor: String(events.length + 1),
        runId,
        timestamp: new Date(0).toISOString(),
      }
      events.push(stored)
      return stored
    },
    read(runId, options) {
      const cursor = Number(options?.after || 0)
      return events.filter(event => event.runId === runId && Number(event.cursor) > cursor)
    },
    subscribe,
  }
  return { events, store, subscribe }
}

describe("Agent Run Events", () => {
  it("publishes application-owned events across capability, driver, and finish phases", async () => {
    const { events, store } = memoryStore()
    const resolveStore = vi.fn(({ runtime }) => {
      expect(runtime?.run?.runId).toBe("summary-run")
      return store
    })
    const runEvents = defineAgentRunEvents({ store: resolveStore })
    const agent = defineAgent({
      capabilities: [defineCapability({
        id: "transcribe",
        async input(context) {
          await context.runEvents?.publish({ data: { stage: "transcribe" }, type: "stage" })
        },
      })],
      driver: {
        async run(context) {
          await context.runEvents?.publish({ data: { stage: "summarize" }, type: "stage" })
          return "done"
        },
      },
      hooks: {
        async "agent:finish"(event) {
          await event.runtime.runEvents?.publish({ data: { stage: "finalize" }, type: "stage" })
        },
      },
      runEvents,
      runtime: false,
    })

    await expect(runAgent(agent, {
      memo: vi.fn(),
      run: { runId: "summary-run" },
      runtime: "vercel",
      runtimeConfig: { region: "iad" },
      waitUntil: vi.fn(),
    }, { prompt: "summarize" })).resolves.toBe("done")

    expect(events).toMatchObject([
      { cursor: "1", data: { stage: "transcribe" }, runId: "summary-run", type: "stage" },
      { cursor: "2", data: { stage: "summarize" }, runId: "summary-run", type: "stage" },
      { cursor: "3", data: { stage: "finalize" }, runId: "summary-run", type: "stage" },
    ])
    expect(resolveStore).toHaveBeenCalledTimes(3)
  })

  it("reads and subscribes after an opaque cursor", async () => {
    const { store, subscribe } = memoryStore()
    const runEvents = defineAgentRunEvents({ store })
    await runEvents.publish("run-1", { data: 1, type: "progress" })
    await runEvents.publish("run-1", { data: 2, type: "progress" })

    await expect(runEvents.read("run-1", "1")).resolves.toMatchObject([
      { cursor: "2", data: 2 },
    ])
    const signal = new AbortController().signal
    const replay: AgentRunEvent[] = []
    for await (const event of runEvents.subscribe("run-1", "1", { signal })) replay.push(event)

    expect(replay).toMatchObject([{ cursor: "2", data: 2 }])
    expect(subscribe).toHaveBeenCalledWith("run-1", { after: "1", signal })
  })

  it("does not invent a run id for inline invocations", async () => {
    const { store } = memoryStore()
    const run = vi.fn(context => context.runEvents)
    const agent = defineAgent({
      driver: { run },
      runEvents: defineAgentRunEvents({ store }),
      runtime: false,
    })

    await expect(runAgent(agent, {
      memo: vi.fn(),
      runtime: "unknown",
      waitUntil: vi.fn(),
    }, {})).resolves.toBeUndefined()
    expect(run).toHaveBeenCalledOnce()
  })

  it("rejects hand-written run event definitions", async () => {
    const agent = defineAgent({
      driver: { run: () => "done" },
      runEvents: {
        publish: vi.fn(),
        read: vi.fn(),
        subscribe: vi.fn(),
      } as never,
      runtime: false,
    })

    await expect(runAgent(agent, {
      memo: vi.fn(),
      run: { runId: "run-1" },
      runtime: "unknown",
      waitUntil: vi.fn(),
    }, {})).rejects.toThrow("created by defineAgentRunEvents")
  })

  it.each([
    ["empty run id", () => defineAgentRunEvents({ store: memoryStore().store }).publish("", { type: "stage" })],
    ["empty event type", () => defineAgentRunEvents({ store: memoryStore().store }).publish("run-1", { type: "" } as AgentRunEventInput)],
  ])("rejects %s", async (_case, invoke) => {
    await expect(invoke()).rejects.toThrow("non-empty")
  })
})
