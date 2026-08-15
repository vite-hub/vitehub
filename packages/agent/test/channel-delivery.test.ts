import { describe, expect, it, vi } from "vitest"

import { activeAgentChannelDelivery, agentChannelDeliveryMessageIdentity, agentChannelDeliveryPayloadFingerprint, agentChannelDeliverySourceId, bindAgentChannelDeliveryMessage, bindAgentChannelDeliveryPayload, detachAgentChannelDelivery, openAgentChannelDelivery, readAgentChannelDeliveries, resumeAgentChannelDelivery, resumeAgentChannelDeliveryMessage, resumeAgentChannelDeliveryPayload } from "../src/internal/channel-delivery.ts"

import type { Lock, StateAdapter } from "chat"

describe("Agent Channel delivery source identity", () => {
  it("scopes top-level activity IDs to providers that define them", () => {
    expect(agentChannelDeliverySourceId("teams", { id: "activity-1" })).toBe("activity-1")
    expect(agentChannelDeliverySourceId("discord", { id: "interaction-1" })).toBe("interaction-1")
    expect(agentChannelDeliverySourceId("custom", { id: "resource-1" })).toBeUndefined()
    expect(agentChannelDeliverySourceId("custom", { event: { id: "event-1" }, id: "resource-1" })).toBe("event-1")
  })

  it("fingerprints equivalent provider payloads independently of key order", async () => {
    await expect(agentChannelDeliveryPayloadFingerprint({ event: { id: 7, type: "message" }, team: "one" }))
      .resolves.toBe(await agentChannelDeliveryPayloadFingerprint({ team: "one", event: { type: "message", id: 7 } }))
  })

  it("extracts Telegram message identity separately from provider event identity", () => {
    const payload = { message: { chat: { id: 456 }, message_id: 7 }, update_id: 42 }
    expect(agentChannelDeliverySourceId("telegram", payload)).toBe("42")
    expect(agentChannelDeliveryMessageIdentity("telegram", payload)).toEqual({ messageId: "7", threadId: "telegram:456" })
  })
})

function stateAdapter(): StateAdapter {
  const values = new Map<string, unknown>()
  const lists = new Map<string, unknown[]>()
  const locks = new Set<string>()
  return {
    acquireLock: async (key: string) => {
      if (locks.has(key)) return null
      locks.add(key)
      return { expiresAt: Date.now() + 5_000, threadId: key, token: key }
    },
    appendToList: async (key: string, value: unknown, options?: { maxLength?: number }) => {
      const list = [...(lists.get(key) || []), value]
      lists.set(key, options?.maxLength ? list.slice(-options.maxLength) : list)
    },
    extendLock: async (lock: Lock) => locks.has(lock.threadId),
    get: async (key: string) => (values.get(key) as never) ?? null,
    getList: async (key: string) => [...(lists.get(key) || [])] as never,
    delete: async (key: string) => void values.delete(key),
    releaseLock: async (lock: Lock) => void locks.delete(lock.threadId),
    set: async (key: string, value: unknown) => void values.set(key, value),
    setIfNotExists: async (key: string, value: unknown) => {
      if (values.has(key)) return false
      values.set(key, value)
      return true
    },
  } as unknown as StateAdapter
}

describe("Agent Channel delivery journal", () => {
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
    const acquireLock = vi.spyOn(state, "acquireLock")
    const first = await openAgentChannelDelivery(state, { agentName: "support", provider: "github", scope: "webhook:support", sourceId: "delivery-0" })
    let secondId: string | undefined
    for (let index = 1; index < 10_000; index++) {
      const delivery = await openAgentChannelDelivery(state, { agentName: "support", provider: "github", scope: "webhook:support", sourceId: `delivery-${index}` })
      if (index === 1) secondId = delivery.delivery.id
    }

    await first.event({ type: "accepted" })
    const newest = await openAgentChannelDelivery(state, { agentName: "support", provider: "github", scope: "webhook:support", sourceId: "delivery-10000" })
    const ids = await state.getList<string>("deliveries:index")

    expect(ids).toHaveLength(10_000)
    expect(new Set(ids)).toHaveLength(10_000)
    expect(ids).not.toContain(first.delivery.id)
    expect(ids?.at(0)).toBe(secondId)
    expect(ids?.at(-1)).toBe(newest.delivery.id)
    expect(acquireLock).not.toHaveBeenCalled()
    info.mockRestore()
  }, 10_000)

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
    await bindAgentChannelDeliveryPayload(state, delivery, "custom", fingerprint!)

    const resumed = await resumeAgentChannelDeliveryPayload(state, "custom", (await agentChannelDeliveryPayloadFingerprint({ custom: { thread: 9, message: "opaque" } }))!)

    expect(resumed?.delivery.id).toBe(delivery.delivery.id)
    info.mockRestore()
  })
})
