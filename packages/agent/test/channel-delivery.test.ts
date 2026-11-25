import { describe, expect, it, vi } from "vitest"

import { activeAgentChannelDelivery, agentChannelDeliveryMessageIdentity, agentChannelDeliveryOwnershipVerifier, agentChannelDeliveryPayloadFingerprint, agentChannelDeliverySourceId, bindAgentChannelDeliveryMessage, bindAgentChannelDeliveryPayload, detachAgentChannelDelivery, openAgentChannelDelivery, readAgentChannelDeliveries, resumeAgentChannelDelivery, resumeAgentChannelDeliveryMessage, resumeAgentChannelDeliveryPayload, resumeWorkflowAgentChannelDelivery, setAgentChannelDeliveryWorkflowResolver, withAgentChannelDeliveryOwnershipVerifier } from "../src/internal/channel-delivery.ts"

import type { Lock, StateAdapter } from "chat"
import type { AgentRuntimeContext } from "../src/types.ts"

describe("Agent Channel delivery source identity", () => {
  it("scopes top-level activity IDs to providers that define them", () => {
    expect(agentChannelDeliverySourceId("teams", { id: "activity-1" })).toBe("activity-1")
    expect(agentChannelDeliverySourceId("discord", { id: "interaction-1" })).toBe("interaction-1")
    expect(agentChannelDeliverySourceId("custom", { id: "resource-1" })).toBeUndefined()
    expect(agentChannelDeliverySourceId("custom", { event: { id: "event-1" }, id: "resource-1" })).toBe("event-1")
  })

  it("gives each Teams edit its own identity", () => {
    const edit = { channelData: { eventType: "editMessage" }, id: "1766459963017", timestamp: "2025-12-23T03:21:02.000Z", type: "messageUpdate" }
    expect(agentChannelDeliverySourceId("teams", edit)).toBe("1766459963017:update:2025-12-23T03:21:02.000Z")
    expect(agentChannelDeliverySourceId("teams", { ...edit, timestamp: "2025-12-23T03:22:40.000Z" })).toBe("1766459963017:update:2025-12-23T03:22:40.000Z")
    expect(agentChannelDeliverySourceId("teams", { ...edit, timestamp: undefined })).toBeUndefined()
  })

  it("fingerprints equivalent provider payloads independently of key order", async () => {
    await expect(agentChannelDeliveryPayloadFingerprint({ event: { id: 7, type: "message" }, team: "one" }))
      .resolves.toBe(await agentChannelDeliveryPayloadFingerprint({ team: "one", event: { type: "message", id: 7 } }))
  })

  it("fingerprints a payload the same on every host locale and keeps English fingerprints", async () => {
    const slack = { event: { channel: "C1", text: "hi", ts: "1.2", type: "message", user: "U1" }, team_id: "T1", type: "event_callback" }
    const teams = { channelData: { tenant: { id: "t" } }, channelId: "msteams", id: "1", localTimestamp: "2026-11-23T11:00:00.000+01:00", locale: "en-US", serviceUrl: "https://smba.trafficmanager.net/emea/", text: "hi", textFormat: "plain", type: "message" }
    const fingerprintIn = async (locale: string, payload: unknown) => {
      const collator = new Intl.Collator(locale)
      const localeCompare = vi.spyOn(String.prototype, "localeCompare").mockImplementation(function (this: string, that: string) {
        return collator.compare(this, that)
      })
      try {
        return await agentChannelDeliveryPayloadFingerprint(payload)
      }
      finally {
        localeCompare.mockRestore()
      }
    }
    expect(await fingerprintIn("en", slack)).toBe("e7c0c61d03ca4194d549dd17dc989b45b5f183f2547ce69264f697c11d35259c")
    expect(await fingerprintIn("en", teams)).toBe("a1f14ea58e09a8b403f7738ff409c890c95d17723cf19182be1594d550c15da0")
    for (const locale of ["cs", "lt", "et"]) {
      expect(await fingerprintIn(locale, slack)).toBe(await fingerprintIn("en", slack))
      expect(await fingerprintIn(locale, teams)).toBe(await fingerprintIn("en", teams))
    }
  })

  it("extracts Telegram message identity separately from provider event identity", () => {
    const payload = { message: { chat: { id: 456 }, message_id: 7 }, update_id: 42 }
    expect(agentChannelDeliverySourceId("telegram", payload)).toBe("42")
    expect(agentChannelDeliveryMessageIdentity("telegram", payload)).toEqual({ messageId: "7", threadId: "telegram:456" })
  })

  it("keeps identical provider event IDs separate across Channels", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const state = stateAdapter()
    const first = await openAgentChannelDelivery(state, {
      agentName: "support",
      channelId: "telegram-primary",
      provider: "telegram",
      scope: "webhook:support:telegram",
      sourceId: "42",
    })
    const second = await openAgentChannelDelivery(state, {
      agentName: "support",
      channelId: "telegram-secondary",
      provider: "telegram",
      scope: "webhook:support:telegram",
      sourceId: "42",
    })

    expect(second.duplicate).toBe(false)
    expect(second.delivery.id).not.toBe(first.delivery.id)
    info.mockRestore()
  })
})

function stateAdapter(): StateAdapter {
  const values = new Map<string, unknown>()
  const lists = new Map<string, unknown[]>()
  const locks = new Set<string>()
  const adapter: unknown = {
    acquireLock: async (key: string) => {
      if (locks.has(key)) return null
      locks.add(key)
      return { expiresAt: Date.now() + 5_000, threadId: key, token: key }
    },
    appendToList: async (key: string, value: unknown, options?: { maxLength?: number }) => {
      const list = [...(lists.get(key) || []), value]
      lists.set(key, options?.maxLength ? list.slice(-options.maxLength) : list)
    },
    connect: async () => undefined,
    extendLock: async (lock: Lock) => locks.has(lock.threadId),
    get: async (key: string) => values.get(key) ?? null,
    getList: async (key: string) => [...(lists.get(key) || [])],
    delete: async (key: string) => {
      values.delete(key)
      lists.delete(key)
    },
    releaseLock: async (lock: Lock) => void locks.delete(lock.threadId),
    set: async (key: string, value: unknown) => void values.set(key, value),
    setIfNotExists: async (key: string, value: unknown) => {
      if (values.has(key)) return false
      values.set(key, value)
      return true
    },
  }
  // SAFETY: This in-memory test adapter implements the State methods exercised by the delivery journal fixtures.
  return adapter as StateAdapter
}

describe("Agent Channel delivery journal", () => {
  it("normalizes omitted Workflow capabilities before resuming delivery", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const state = stateAdapter()
    const delivery = await openAgentChannelDelivery(state, {
      agentName: "support",
      channelId: "telegram",
      provider: "telegram",
      scope: "chat:support:telegram",
      sourceId: "workflow-normalized-capabilities",
    })
    detachAgentChannelDelivery(delivery)
    const { runAgentWorkflowDefinition } = await import("../src/runtime/workflow.ts")
    setAgentChannelDeliveryWorkflowResolver(async (_agent, context) => {
      expect(context.capabilities).toEqual({})
      return await resumeAgentChannelDelivery(state, delivery.delivery.id)
    })

    try {
      // SAFETY: This fixture exercises only Workflow context normalization and does not read the Agent definition.
      await expect(runAgentWorkflowDefinition({} as never, {
        id: "workflow-normalized-capabilities",
        name: "support",
        payload: {
          input: {
            context: {
              "vitehub.channelDelivery": {
                channelId: "telegram",
                deliveryId: delivery.delivery.id,
                provider: "telegram",
                state: "chat",
              },
            },
          },
          requestUrl: "https://example.com",
        },
        provider: "cloudflare",
      }, async (_agent, context) => {
        expect(context.capabilities).toEqual({})
        return "completed"
      })).resolves.toBe("completed")
    }
    finally {
      setAgentChannelDeliveryWorkflowResolver(async () => undefined)
      info.mockRestore()
    }
  })

  it.each(["persisted", "missing", "error"] as const)("checks durable Workflow ownership before an active tracker: %s", async (result) => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const state = stateAdapter()
    const active = await openAgentChannelDelivery(state, {
      agentName: "support",
      channelId: "telegram",
      provider: "telegram",
      scope: "chat:support:telegram",
      sourceId: `workflow-active-${result}`,
    })
    const persisted = { ...active, claimed: true, event: vi.fn(active.event) }
    const failure = new Error("Durable ownership unavailable")
    const resolve = vi.fn(async () => {
      if (result === "error") throw failure
      return result === "persisted" ? persisted : undefined
    })
    setAgentChannelDeliveryWorkflowResolver(resolve)
    try {
      const resumed = resumeWorkflowAgentChannelDelivery({}, {
        memo: vi.fn(),
        runtime: "unknown",
        waitUntil: vi.fn(),
      }, {
        channelId: "telegram",
        deliveryId: active.delivery.id,
        provider: "telegram",
        state: "chat",
      })
      if (result === "error") await expect(resumed).rejects.toBe(failure)
      else await expect(resumed).resolves.toBe(result === "persisted" ? persisted : active)
      expect(resolve).toHaveBeenCalledOnce()
    }
    finally {
      detachAgentChannelDelivery(active)
      setAgentChannelDeliveryWorkflowResolver(async () => undefined)
      info.mockRestore()
    }
  })

  it("resumes Workflow custody through the installed host State owner", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const state = stateAdapter()
    const delivery = await openAgentChannelDelivery(state, {
      agentName: "support",
      channelId: "telegram",
      provider: "telegram",
      scope: "chat:support:telegram",
      sourceId: "workflow-host-state",
    })
    detachAgentChannelDelivery(delivery)
    // The routes module installs the Workflow delivery resolvers when it loads.
    await import("../src/server/routes.ts")
    const { setAgentChannelDeliveryWorkflowStateResolver } = await import("../src/server/route-handlers.ts")
    setAgentChannelDeliveryWorkflowStateResolver(() => ({ state: () => state }))

    try {
      // SAFETY: This fixture supplies the runtime fields read by the Workflow delivery resolver.
      const resumed = await resumeWorkflowAgentChannelDelivery({}, {
        request: new Request("https://example.com"),
        runtime: "unknown",
        runtimeConfig: {},
      } as never, {
        channelId: "telegram",
        deliveryId: delivery.delivery.id,
        provider: "telegram",
        state: "chat",
      })

      expect(resumed?.delivery.id).toBe(delivery.delivery.id)
    }
    finally {
      setAgentChannelDeliveryWorkflowStateResolver(() => ({}))
      info.mockRestore()
    }
  })

  it("keeps provider retries on one durable, inspectable timeline", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const state = stateAdapter()
    const input = {
      agentName: "support",
      channelId: "discord",
      provider: "discord",
      scope: "channel:42",
      sourceId: "message:7",
    }

    const first = await openAgentChannelDelivery(state, input)
    await first.event({ runId: "run:7", type: "invocation.started" })
    const retry = await openAgentChannelDelivery(state, input)
    await retry.event({ attempt: 2, error: "provider unavailable", type: "retrying" })
    const resumed = await resumeAgentChannelDelivery(state, first.delivery.id)
    await resumed?.event({ messageId: "reply:9", type: "outbound.completed" })
    await resumed?.event({ type: "completed" })

    expect(retry.duplicate).toBe(true)
    expect(retry.delivery.id).toBe(first.delivery.id)
    await expect(readAgentChannelDeliveries(state)).resolves.toEqual([
      expect.objectContaining({
        agentName: "support",
        id: first.delivery.id,
        provider: "discord",
        sourceId: "message:7",
        events: expect.arrayContaining([
          expect.objectContaining({ type: "received" }),
          expect.objectContaining({ type: "duplicate" }),
          expect.objectContaining({ attempt: 2, type: "retrying" }),
          expect.objectContaining({ messageId: "reply:9", type: "outbound.completed" }),
          expect.objectContaining({ type: "completed" }),
        ]),
      }),
    ])
    info.mockRestore()
  })

  it("surfaces a failed delivery without persisting message content", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const state = stateAdapter()
    const delivery = await openAgentChannelDelivery(state, {
      agentName: "support",
      provider: "github",
      scope: "webhook:support:github",
      sourceId: "delivery-9",
    })

    await delivery.event({ error: "signature mismatch", type: "rejected" })

    await expect(readAgentChannelDeliveries(state)).resolves.toEqual([
      expect.objectContaining({
        status: "rejected",
        events: expect.arrayContaining([expect.objectContaining({ error: "signature mismatch", type: "rejected" })]),
      }),
    ])
    info.mockRestore()
  })

  it("emits a structured fallback when the durable journal cannot write", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const state = stateAdapter()
    const appendToList = state.appendToList.bind(state)
    state.appendToList = async (key, value, options) => {
      if (key.endsWith(":events")) throw new Error("state unavailable")
      return await appendToList(key, value, options)
    }

    await expect(openAgentChannelDelivery(state, {
      agentName: "support",
      provider: "telegram",
      scope: "chat:support:telegram",
      sourceId: "update-10",
    })).rejects.toThrow("state unavailable")
    expect(error.mock.calls.map(([entry]) => String(entry)).join("\n")).toContain('"event":"journal.failed"')
    error.mockRestore()
  })

  it("preserves committed journal success when lock cleanup fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const state = stateAdapter()
    state.releaseLock = async () => {
      throw new Error("lock cleanup unavailable")
    }

    const delivery = await openAgentChannelDelivery(state, {
      agentName: "support",
      provider: "github",
      scope: "webhook:support",
      sourceId: "release-failure",
    })

    expect(delivery.delivery.sourceId).toBe("release-failure")
    expect(error.mock.calls.map(([entry]) => String(entry)).join("\n")).toContain('"event":"journal.lock-release.failed"')
    await expect(readAgentChannelDeliveries(state)).resolves.toEqual([
      expect.objectContaining({ sourceId: "release-failure", status: "received" }),
    ])
    error.mockRestore()
    info.mockRestore()
  })

  it("reconciles inspection after an event append outlives its record write", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const state = stateAdapter()
    const set = state.set.bind(state)
    let failRecordWrite = false
    state.set = async (key, value, ttlMs) => {
      if (failRecordWrite && key.startsWith("deliveries:source:")) {
        failRecordWrite = false
        throw new Error("record unavailable")
      }
      await set(key, value, ttlMs)
    }
    const delivery = await openAgentChannelDelivery(state, {
      agentName: "support",
      provider: "github",
      scope: "webhook:support",
      sourceId: "partial-terminal",
    })

    failRecordWrite = true
    await expect(delivery.event({ type: "completed" })).rejects.toThrow("record unavailable")

    await expect(readAgentChannelDeliveries(state)).resolves.toEqual([
      expect.objectContaining({ status: "completed" }),
    ])
    expect(error.mock.calls.map(([entry]) => String(entry)).join("\n")).toContain('"event":"journal.failed"')
    error.mockRestore()
    info.mockRestore()
  })

  it("repairs the inspection index after a partially failed open", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const state = stateAdapter()
    const appendToList = state.appendToList.bind(state)
    let failIndex = true
    state.appendToList = async (key, value, options) => {
      if (key === "deliveries:index" && failIndex) {
        failIndex = false
        throw new Error("index unavailable")
      }
      await appendToList(key, value, options)
    }
    const input = { agentName: "support", provider: "github", scope: "webhook:support", sourceId: "delivery-10" }

    await expect(openAgentChannelDelivery(state, input)).rejects.toThrow("index unavailable")
    const reopened = await openAgentChannelDelivery(state, input)

    expect(reopened.duplicate).toBe(true)
    await expect(readAgentChannelDeliveries(state)).resolves.toEqual([
      expect.objectContaining({ id: reopened.delivery.id, sourceId: "delivery-10" }),
    ])
    info.mockRestore()
  })

  it("bounds event-history reads before applying the inspection limit", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const state = stateAdapter()
    for (const sourceId of ["one", "two", "three"]) {
      await openAgentChannelDelivery(state, { agentName: "support", provider: "github", scope: "webhook:support", sourceId })
    }
    const getList = vi.spyOn(state, "getList")

    await expect(readAgentChannelDeliveries(state, 1)).resolves.toHaveLength(1)

    expect(getList.mock.calls.filter(([key]) => String(key).endsWith(":events"))).toHaveLength(1)
    info.mockRestore()
  })

  it("bounds the inspection index by admissions without rewriting lifecycle updates", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const state = stateAdapter()
    const first = await openAgentChannelDelivery(state, { agentName: "support", provider: "github", scope: "webhook:support", sourceId: "delivery-0" })
    let secondId: string | undefined
    for (let index = 1; index < 10_000; index++) {
      const delivery = await openAgentChannelDelivery(state, { agentName: "support", provider: "github", scope: "webhook:support", sourceId: `delivery-${index}` })
      if (index === 1) secondId = delivery.delivery.id
    }

    await first.event({ type: "accepted" })
    await state.delete("deliveries:index:trim")
    const newest = await openAgentChannelDelivery(state, { agentName: "support", provider: "github", scope: "webhook:support", sourceId: "delivery-10000" })
    const ids = await state.getList<string>("deliveries:index")

    expect(ids).toHaveLength(10_000)
    expect(new Set(ids)).toHaveLength(10_000)
    expect(ids).not.toContain(first.delivery.id)
    expect(ids?.at(0)).toBe(secondId)
    expect(ids?.at(-1)).toBe(newest.delivery.id)
    info.mockRestore()
  }, 10_000)

  it("deletes the records of a delivery that leaves the index", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const state = stateAdapter()
    const input = { agentName: "support", provider: "github", scope: "webhook:support" }
    const first = await openAgentChannelDelivery(state, { ...input, sourceId: "delivery-0" })
    await first.event({ type: "completed" })
    let second: Awaited<ReturnType<typeof openAgentChannelDelivery>> | undefined
    for (let index = 1; index < 10_000; index++) {
      const delivery = await openAgentChannelDelivery(state, { ...input, sourceId: `delivery-${index}` })
      if (index === 1) second = delivery
    }
    await state.delete("deliveries:index:trim")
    await openAgentChannelDelivery(state, { ...input, sourceId: "delivery-10000" })

    expect(await state.getList("deliveries:index")).not.toContain(first.delivery.id)
    expect(await state.get(`deliveries:${first.delivery.id}`)).toBeNull()
    expect(await state.getList(`deliveries:${first.delivery.id}:events`)).toEqual([])
    expect(await resumeAgentChannelDelivery(state, first.delivery.id)).toBeUndefined()
    expect(await state.get(`deliveries:${second!.delivery.id}`)).toMatchObject({ id: second!.delivery.id })
    // The source is free again, so a new admission of the same event is not a duplicate.
    expect((await openAgentChannelDelivery(state, { ...input, sourceId: "delivery-0" })).duplicate).toBe(false)
    info.mockRestore()
  }, 20_000)

  it("preserves a delivery re-admitted during overflow cleanup", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const state = stateAdapter()
    const input = { agentName: "support", provider: "github", scope: "webhook:support", sourceId: "concurrent-oldest" }
    const oldest = await openAgentChannelDelivery(state, input)
    for (let index = 1; index < 10_000; index++) {
      await state.appendToList("deliveries:index", `filler-${index}`)
    }
    const getList = state.getList.bind(state)
    let retry: Awaited<ReturnType<typeof openAgentChannelDelivery>> | undefined
    state.getList = async <T>(key: string) => {
      const snapshot = await getList<T>(key)
      if (key === "deliveries:index" && !snapshot.includes(oldest.delivery.id as T) && !retry) {
        // Return the overflow admission's stale snapshot after a concurrent retry has finished.
        state.getList = getList
        retry = await openAgentChannelDelivery(state, input)
      }
      return snapshot
    }

    await state.delete("deliveries:index:trim")

    await openAgentChannelDelivery(state, { ...input, sourceId: "overflow" })

    expect(retry?.duplicate).toBe(true)
    expect(await state.getList("deliveries:index")).toContain(oldest.delivery.id)
    expect(await resumeAgentChannelDelivery(state, oldest.delivery.id)).toBeDefined()
    expect(await state.getList(`deliveries:${oldest.delivery.id}:events`)).toEqual([
      expect.objectContaining({ type: "received" }),
      expect.objectContaining({ type: "duplicate" }),
    ])
    expect((await openAgentChannelDelivery(state, input)).delivery.id).toBe(oldest.delivery.id)
    info.mockRestore()
  })

  it("keeps a re-admitted delivery when the trim's lock on it expired", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const state = stateAdapter()
    const input = { agentName: "support", provider: "github", scope: "webhook:support", sourceId: "expired-oldest" }
    const oldest = await openAgentChannelDelivery(state, input)
    for (let index = 1; index < 10_000; index++) {
      await state.appendToList("deliveries:index", `filler-${index}`)
    }
    const lockKey = `deliveries:${oldest.delivery.id}:journal-lock`
    const acquireLock = state.acquireLock.bind(state)
    const getList = state.getList.bind(state)
    let trimHoldsOldest = false
    let retried = false
    let retry: Awaited<ReturnType<typeof openAgentChannelDelivery>> | undefined
    state.acquireLock = async (threadId, ttlMs) => {
      const lock = await acquireLock(threadId, ttlMs)
      if (threadId === lockKey && lock) trimHoldsOldest = true
      return lock
    }
    state.getList = async <T>(key: string) => {
      const snapshot = await getList<T>(key)
      if (key === "deliveries:index" && trimHoldsOldest && !retried) {
        retried = true
        // The trim's lock expires after its recheck, and a retry re-admits the delivery before the trim deletes it.
        await state.releaseLock({ expiresAt: 0, threadId: lockKey, token: lockKey })
        retry = await openAgentChannelDelivery(state, input)
      }
      return snapshot
    }
    await state.delete("deliveries:index:trim")

    await openAgentChannelDelivery(state, { ...input, sourceId: "overflow" })

    expect(retry?.duplicate).toBe(true)
    expect(await getList("deliveries:index")).toContain(oldest.delivery.id)
    expect(await resumeAgentChannelDelivery(state, oldest.delivery.id)).toBeDefined()
    expect(await getList(`deliveries:${oldest.delivery.id}:events`)).toEqual([
      expect.objectContaining({ type: "received" }),
      expect.objectContaining({ type: "duplicate" }),
    ])
    info.mockRestore()
  })

  it("reads the full inspection index once per trim, not on every admission", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const state = stateAdapter()
    for (let index = 0; index < 10_000; index++) {
      await state.appendToList("deliveries:index", `filler-${index}`)
    }
    const getList = vi.spyOn(state, "getList")
    for (let index = 0; index < 100; index++) {
      await openAgentChannelDelivery(state, { agentName: "support", provider: "github", scope: "webhook:support", sourceId: `delivery-${index}` })
    }

    // One trim, reading the index before and after its append and once more to recheck its candidates under their locks.
    expect(getList.mock.calls.filter(([key]) => key === "deliveries:index")).toHaveLength(3)
    info.mockRestore()
  })

  it("trims the index after overlapping admissions", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const state = stateAdapter()
    const input = { agentName: "support", provider: "github", scope: "webhook:support" }
    for (let index = 0; index < 10_000; index++) {
      await state.appendToList("deliveries:index", `filler-${index}`)
    }
    await Promise.all(Array.from({ length: 50 }, (_, index) => openAgentChannelDelivery(state, { ...input, sourceId: `overlap-${index}` })))
    await state.delete("deliveries:index:trim")
    await openAgentChannelDelivery(state, { ...input, sourceId: "after-overlap" })

    expect(await state.getList("deliveries:index")).toHaveLength(10_000)
    info.mockRestore()
  })

  it("de-duplicates concurrent admission references during inspection", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const state = stateAdapter()
    const appendToList = state.appendToList.bind(state)
    state.appendToList = async (key, value, options) => {
      await appendToList(key, value, options)
      if (key === "deliveries:index") await appendToList(key, value, options)
    }
    const delivery = await openAgentChannelDelivery(state, { agentName: "support", provider: "github", scope: "webhook:support", sourceId: "duplicate-index" })

    await expect(readAgentChannelDeliveries(state)).resolves.toEqual([
      expect.objectContaining({ id: delivery.delivery.id }),
    ])
    info.mockRestore()
  })

  it("keeps a retried oldest timeline discoverable through admission overflow", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const state = stateAdapter()
    const input = { agentName: "support", provider: "github", scope: "webhook:support", sourceId: "oldest-retry" }
    const oldest = await openAgentChannelDelivery(state, input)
    for (let index = 1; index < 10_000; index++) {
      await openAgentChannelDelivery(state, { ...input, sourceId: `overflow-${index}` })
    }

    await openAgentChannelDelivery(state, input)
    await state.delete("deliveries:index:trim")
    await openAgentChannelDelivery(state, { ...input, sourceId: "overflow-10000" })

    await expect(readAgentChannelDeliveries(state, 10_000)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: oldest.delivery.id })]),
    )
    info.mockRestore()
  }, 10_000)

  it("keeps terminal settlement when a delayed queued event arrives", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const state = stateAdapter()
    const delivery = await openAgentChannelDelivery(state, { agentName: "support", provider: "discord", scope: "chat:support", sourceId: "message-11" })

    await delivery.event({ type: "completed" })
    await delivery.event({ type: "queued" })

    await expect(readAgentChannelDeliveries(state)).resolves.toEqual([
      expect.objectContaining({ status: "completed" }),
    ])
    info.mockRestore()
  })

  it("preserves terminal status after duplicate admissions truncate event history", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const state = stateAdapter()
    const input = { agentName: "support", provider: "github", scope: "webhook:support", sourceId: "completed-duplicate" }
    const delivery = await openAgentChannelDelivery(state, input)
    await delivery.event({ type: "completed" })

    for (let index = 0; index < 256; index++) await openAgentChannelDelivery(state, input)

    const [inspection] = await readAgentChannelDeliveries(state)
    expect(inspection?.events).toHaveLength(256)
    expect(inspection?.events.some(event => event.type === "completed")).toBe(false)
    expect(inspection?.status).toBe("completed")
    info.mockRestore()
  })

  it("initializes persisted status from legacy history before appending", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const state = stateAdapter()
    const input = { agentName: "support", provider: "github", scope: "webhook:support", sourceId: "legacy-completed" }
    const delivery = await openAgentChannelDelivery(state, input)
    await delivery.event({ type: "completed" })
    const recordKey = `deliveries:${delivery.delivery.id}`
    const sourceKey = `deliveries:source:${encodeURIComponent(`${input.provider}:${input.scope}:${input.sourceId}`)}`
    const stored = await state.get<Record<string, unknown>>(recordKey)
    const { journalRetrySignaled: _journalRetrySignaled, journalStatus: _journalStatus, ...legacy } = stored || {}
    await state.set(recordKey, legacy)
    await state.set(sourceKey, legacy)

    await openAgentChannelDelivery(state, input)

    await expect(readAgentChannelDeliveries(state)).resolves.toEqual([
      expect.objectContaining({ status: "completed" }),
    ])
    info.mockRestore()
  })

  it("does not let a stale tracker overwrite newer terminal status", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const state = stateAdapter()
    const delivery = await openAgentChannelDelivery(state, { agentName: "support", provider: "github", scope: "webhook:support", sourceId: "concurrent-completed" })
    const stale = await resumeAgentChannelDelivery(state, delivery.delivery.id)

    await delivery.event({ type: "completed" })
    await stale?.event({ type: "outbound.completed" })

    await expect(readAgentChannelDeliveries(state)).resolves.toEqual([
      expect.objectContaining({ status: "completed" }),
    ])
    info.mockRestore()
  })

  it("lets a reopened attempt replace a recoverable terminal status", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const state = stateAdapter()
    const input = { agentName: "support", provider: "github", scope: "webhook:support", sourceId: "delivery-retry" }
    const first = await openAgentChannelDelivery(state, input)
    await first.event({ type: "rejected" })
    const retry = await openAgentChannelDelivery(state, input)
    await retry.event({ type: "accepted" })
    await retry.event({ type: "completed" })

    await expect(readAgentChannelDeliveries(state)).resolves.toEqual([
      expect.objectContaining({ status: "completed" }),
    ])
    info.mockRestore()
  })

  it("lets a new Workflow attempt replace a transient terminal failure", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const state = stateAdapter()
    const delivery = await openAgentChannelDelivery(state, { agentName: "support", provider: "telegram", scope: "chat:support", sourceId: "workflow-retry" })
    await delivery.event({ type: "invocation.started" })
    await delivery.event({ type: "failed" })
    await delivery.event({ type: "invocation.started" })
    await delivery.event({ type: "completed" })

    await expect(readAgentChannelDeliveries(state)).resolves.toEqual([
      expect.objectContaining({ status: "completed" }),
    ])
    info.mockRestore()
  })

  it.each(["completed", "rejected"] as const)("keeps %s terminal when an unmarked Workflow attempt arrives", async (terminal) => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const state = stateAdapter()
    const delivery = await openAgentChannelDelivery(state, { agentName: "support", provider: "telegram", scope: "chat:support", sourceId: `workflow-${terminal}` })
    await delivery.event({ type: terminal })
    await delivery.event({ type: "invocation.started" })

    await expect(readAgentChannelDeliveries(state)).resolves.toEqual([
      expect.objectContaining({ status: terminal }),
    ])
    info.mockRestore()
  })

  it("does not retain a duplicate tracker after terminal settlement", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const state = stateAdapter()
    const input = { agentName: "support", provider: "github", scope: "webhook:support", sourceId: "delivery-terminal" }
    const first = await openAgentChannelDelivery(state, input)
    await first.event({ type: "completed" })

    const duplicate = await openAgentChannelDelivery(state, input)

    expect(duplicate.duplicate).toBe(true)
    expect(activeAgentChannelDelivery(first.delivery.id)).toBeUndefined()
    info.mockRestore()
  })

  it("does not retain a tracker when terminal evidence cannot be written", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const state = stateAdapter()
    const delivery = await openAgentChannelDelivery(state, { agentName: "support", provider: "github", scope: "webhook:support", sourceId: "terminal-write-failure" })
    state.appendToList = async () => { throw new Error("state unavailable") }

    await expect(delivery.event({ type: "completed" })).rejects.toThrow("state unavailable")

    expect(activeAgentChannelDelivery(delivery.delivery.id)).toBeUndefined()
    error.mockRestore()
    info.mockRestore()
  })

  it("does not duplicate terminal evidence when a committed write reports failure", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const state = stateAdapter()
    const delivery = await openAgentChannelDelivery(state, {
      agentName: "support",
      provider: "github",
      scope: "webhook:support",
      sourceId: "ambiguous-terminal-write",
    })
    const appendToList = state.appendToList.bind(state)
    let reportFailure = true
    state.appendToList = async (key, value, options) => {
      await appendToList(key, value, options)
      if (reportFailure && key.endsWith(":events")) {
        reportFailure = false
        throw new Error("response unavailable")
      }
    }

    await expect(delivery.event({ runId: "run-1", type: "completed" })).rejects.toThrow("response unavailable")
    await expect(delivery.event({ runId: "run-1", type: "completed" })).resolves.toMatchObject({ runId: "run-1", type: "completed" })

    const deliveries = await readAgentChannelDeliveries(state)
    expect(deliveries).toEqual([expect.objectContaining({ status: "completed" })])
    expect(deliveries[0]?.events.filter((event) => event.runId === "run-1" && event.type === "completed")).toHaveLength(1)
    error.mockRestore()
    info.mockRestore()
  })

  it("detaches process-local custody after durable handoff", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const delivery = await openAgentChannelDelivery(stateAdapter(), {
      agentName: "support",
      provider: "telegram",
      scope: "channel:support:telegram",
      sourceId: "update-handoff",
    })

    detachAgentChannelDelivery(delivery)

    expect(activeAgentChannelDelivery(delivery.delivery.id)).toBeUndefined()
    info.mockRestore()
  })

  it("resumes provider-event custody through a durable message alias", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const state = stateAdapter()
    const delivery = await openAgentChannelDelivery(state, {
      agentName: "support",
      provider: "telegram",
      scope: "channel:support:telegram",
      sourceId: "update-42",
    })
    await bindAgentChannelDeliveryMessage(state, delivery, "telegram", "telegram:456", "7")

    const resumed = await resumeAgentChannelDeliveryMessage(state, "telegram", "telegram:456", "7")

    expect(resumed?.delivery.id).toBe(delivery.delivery.id)
    info.mockRestore()
  })

  it("resumes custom-provider custody through a durable payload alias", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const state = stateAdapter()
    const payload = { custom: { message: "opaque", thread: 9 } }
    const fingerprint = await agentChannelDeliveryPayloadFingerprint(payload)
    const delivery = await openAgentChannelDelivery(state, {
      agentName: "support",
      provider: "custom",
      scope: "channel:support:custom",
      sourceId: "provider-event-9",
    })
    await bindAgentChannelDeliveryPayload(state, delivery, "custom", [fingerprint!])

    const resumed = await resumeAgentChannelDeliveryPayload(state, "custom", [(await agentChannelDeliveryPayloadFingerprint({ custom: { thread: 9, message: "opaque" } }))!])

    expect(resumed?.delivery.id).toBe(delivery.delivery.id)
    info.mockRestore()
  })
})

describe("Agent Channel delivery ownership verifier", () => {
  it("ignores a verifier installed under a global symbol", () => {
    const runtime = { [Symbol.for("vitehub.agent.channel-delivery-ownership-verifier")]: vi.fn() }

    // SAFETY: This fixture forges only the verifier property of a runtime context.
    expect(agentChannelDeliveryOwnershipVerifier(runtime as never)).toBeUndefined()
  })

  it("keeps the installed verifier when the runtime context is copied", () => {
    const verify = vi.fn(async () => {})
    const runtimeContext: AgentRuntimeContext = { memo: (_key, create) => create(), runtime: "unknown", waitUntil: vi.fn() }
    const runtime = withAgentChannelDeliveryOwnershipVerifier(runtimeContext, verify)

    expect(agentChannelDeliveryOwnershipVerifier({ ...runtime })).toBe(verify)
  })
})
