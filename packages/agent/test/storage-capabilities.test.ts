import { describe, expect, it, vi } from "vitest"

import type { ReadonlyWorkspaceFacade } from "@vite-hub/workspace"
import type { AgentInvoker, AgentRunMetadata } from "../src/types.ts"

const runtime = (capabilities: Record<string, unknown>) => ({
  capabilities,
  memo: vi.fn(),
  runtime: "unknown" as const,
  runtimeConfig: {},
  waitUntil: vi.fn(),
})

async function resolveTools(
  capabilities: unknown[],
  handles: Record<string, unknown>,
  workspace?: ReadonlyWorkspaceFacade,
  invocation: {
    agentName?: string
    channelIds?: string[]
    invoker?: AgentInvoker
    run?: AgentRunMetadata
  } = {},
) {
  const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
  const resolved = await resolveAgentCapabilities({ capabilities: capabilities as never }, {
    ...runtime(handles),
    ...(invocation.run ? { run: invocation.run } : {}),
  }, {
    context: {
      ...(invocation.agentName ? { "agent.name": invocation.agentName } : {}),
      ...(invocation.channelIds ? { "agent.channels": invocation.channelIds } : {}),
      ...(invocation.invoker ? { invoker: invocation.invoker } : {}),
    },
  }, workspace as never)
  return resolved.tools!
}

describe("storage capabilities", () => {
  it("allows inline and Runtime Schedule capabilities together", async () => {
    const { schedule } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const schedules = {
      get: vi.fn(),
      list: vi.fn(async () => []),
    }

    await expect(resolveAgentCapabilities({
      capabilities: [
        schedule({ schedules: ["0 9 * * *"] }),
        schedule({ mode: "read", targets: ["reports"] }),
      ],
    }, runtime({ schedule: { schedules } }), {}).then(resolved => Object.keys(resolved.tools!).sort())).resolves.toEqual(["cronjob"])
  })

  it("keeps Runtime Schedule primitives explicit outside hosted route contexts", async () => {
    const { schedule } = await import("../src/capabilities.ts")

    await expect(resolveTools([schedule({ mode: "read" })], {})).rejects.toThrow(
      'Capability "schedule" requires the schedule primitive to be configured.',
    )
  })

  it("exposes scoped Runtime Schedule read and edit tools", async () => {
    const { schedule } = await import("../src/capabilities.ts")
    const records = [
      { createdAt: new Date("2026-05-23T00:00:00.000Z"), cron: "0 9 * * *", enabled: true, id: "daily", target: "reports", timeZone: "Europe/Copenhagen", updatedAt: new Date("2026-05-23T00:00:00.000Z") },
      { createdAt: new Date("2026-05-23T00:00:00.000Z"), cron: "0 10 * * *", enabled: true, id: "private", target: "private", updatedAt: new Date("2026-05-23T00:00:00.000Z") },
    ]
    const schedules = {
      create: vi.fn(async input => ({ ...input, createdAt: new Date("2026-05-23T00:00:00.000Z"), enabled: input.enabled ?? true, id: input.id || "created", updatedAt: new Date("2026-05-23T00:00:00.000Z") })),
      delete: vi.fn(async () => true),
      disable: vi.fn(async id => ({ ...records.find(record => record.id === id)!, enabled: false })),
      enable: vi.fn(async id => ({ ...records.find(record => record.id === id)!, enabled: true })),
      get: vi.fn(async id => records.find(record => record.id === id)),
      list: vi.fn(async () => records),
      run: vi.fn(async id => ({ id: `run-${id}`, scheduleId: id })),
      update: vi.fn(async (id, input) => ({ ...records.find(record => record.id === id)!, ...input })),
    }

    await expect(resolveTools([schedule({ mode: "read", targets: ["reports"] })], { schedule: { schedules } }).then(tools => Object.keys(tools).sort())).resolves.toEqual(["cronjob"])

    const tools = await resolveTools([schedule({ mode: "write", targets: ["reports"] })], { schedule: { schedules } })
    expect(Object.keys(tools)).toEqual(["cronjob"])
    expect(tools.cronjob!.policy).toBeUndefined()

    const guardedTools = await resolveTools([schedule({ mode: "write", policy: "deny", targets: ["reports"] })], { schedule: { schedules } })
    const guardedPolicy = guardedTools.cronjob!.policy
    if (typeof guardedPolicy !== "function") throw new TypeError("Expected Schedule policy to dispatch by operation.")
    expect(await guardedPolicy({ input: { operation: "list" }, name: "cronjob" })).toBe("allow")
    expect(await guardedPolicy({ input: { operation: "create" }, name: "cronjob" })).toBe("deny")

    await expect(tools.cronjob!.execute?.({ operation: "targets" })).resolves.toEqual({ targets: ["reports"] })
    await expect(tools.cronjob!.execute?.({ operation: "list" })).resolves.toEqual([records[0]])
    await expect(tools.cronjob!.execute?.({ id: "daily", operation: "get" })).resolves.toEqual(records[0])
    await expect(tools.cronjob!.execute?.({ id: "private", operation: "get" })).rejects.toThrow("allowlist")

    await tools.cronjob!.execute?.({ cron: "15 9 * * *", id: "new-daily", operation: "create", target: "reports", timeZone: "Europe/Copenhagen" })
    expect(schedules.create).toHaveBeenCalledWith({ cron: "15 9 * * *", enabled: undefined, id: "new-daily", target: "reports", timeZone: "Europe/Copenhagen" })

    await expect(tools.cronjob!.execute?.({ cron: "0 8 * * *", operation: "create", target: "private" })).rejects.toThrow("allowlist")
    await expect(tools.cronjob!.execute?.({ cron: "0 8 * * *", operation: "create", target: "reports", timezone: "UTC" } as never)).rejects.toThrow()
    await expect(tools.cronjob!.execute?.({ cron: "0 8 * * *", operation: "create", target: "reports", timeZone: "Not/A_Zone" })).rejects.toThrow("valid IANA time zone")
    await expect(tools.cronjob!.execute?.({ cron: "0 8 * * *", operation: "create", target: "reports", timeZone: "+01:00" })).rejects.toThrow("valid IANA time zone")
    await expect(tools.cronjob!.execute?.({ cron: "0 8 * * *", operation: "create", target: "reports", timeZone: "PST" })).rejects.toThrow("valid IANA time zone")
    await expect(tools.cronjob!.execute?.({ cron: "0 8 * * *", operation: "create", target: "reports", timeZone: "Asia/Kolkata" })).resolves.toMatchObject({ timeZone: "Asia/Kolkata" })
    await expect(tools.cronjob!.execute?.({ cron: "0 8 * * *", operation: "create", target: "reports", timeZone: "CET" })).resolves.toMatchObject({ timeZone: "CET" })
    await expect(tools.cronjob!.execute?.({ cron: "0 8 * * *", enabled: "false", operation: "create", target: "reports" } as never)).rejects.toThrow("enabled must be a boolean")
    await expect(tools.cronjob!.execute?.({ cron: "0 8 * * *", id: 123, operation: "create", target: "reports" } as never)).rejects.toThrow("id must be a non-empty Runtime Schedule id")
    await expect(tools.cronjob!.execute?.({ cron: "0 8 * * *", id: "", operation: "create", target: "reports" })).rejects.toThrow("id must be a non-empty Runtime Schedule id")
    await tools.cronjob!.execute?.({ cron: "30 9 * * *", id: "daily", operation: "edit", timeZone: "Asia/Bangkok" })
    expect(schedules.update).toHaveBeenCalledWith("daily", { cron: "30 9 * * *", timeZone: "Asia/Bangkok" })
    await expect(tools.cronjob!.execute?.({ id: "daily", operation: "edit", timeZone: "US/Eastern" })).resolves.toMatchObject({ timeZone: "US/Eastern" })
    await tools.cronjob!.execute?.({ id: "daily", operation: "pause" })
    expect(schedules.disable).toHaveBeenCalledWith("daily")
    await tools.cronjob!.execute?.({ id: "daily", operation: "resume" })
    expect(schedules.enable).toHaveBeenCalledWith("daily")
    await expect(tools.cronjob!.execute?.({ id: "daily", operation: "run" })).resolves.toEqual({ id: "run-daily", scheduleId: "daily" })
    await expect(tools.cronjob!.execute?.({ enabled: "false", id: "daily", operation: "edit" } as never)).rejects.toThrow("enabled must be a boolean")
    await expect(tools.cronjob!.execute?.({ id: "private", operation: "delete" })).rejects.toThrow("allowlist")
  })

  it("blocks self-targeting Runtime Schedules unless explicitly allowed", async () => {
    const { schedule } = await import("../src/capabilities.ts")
    expect(() => schedule({ delivery: "origin", mode: "write" })).toThrow("allowSelfTarget")
    const schedules = {
      create: vi.fn(async input => input),
      delete: vi.fn(),
      disable: vi.fn(),
      enable: vi.fn(),
      get: vi.fn(),
      list: vi.fn(async () => []),
      run: vi.fn(),
      update: vi.fn(),
    }

    const blocked = await resolveTools([schedule({ mode: "write", targets: ["agent/daily"] })], { schedule: schedules }, undefined, { agentName: "daily" })
    await expect(blocked.cronjob!.execute?.({ cron: "0 9 * * *", operation: "create", target: "agent/daily" })).rejects.toThrow("Self Schedule Permission")

    const allowed = await resolveTools([schedule({ allowSelfTarget: true, mode: "write" })], { schedule: schedules }, undefined, { agentName: "daily" })
    await expect(allowed.cronjob!.execute?.({ operation: "targets" })).resolves.toEqual({ targets: undefined })
    await expect(allowed.cronjob!.execute?.({ cron: "0 9 * * *", operation: "create", prompt: "Prepare the daily report." })).resolves.toMatchObject({ target: "agent/daily" })
    schedules.get.mockResolvedValueOnce({ cron: "0 8 * * *", enabled: true, id: "generic", target: "reports" })
    await expect(allowed.cronjob!.execute?.({ id: "generic", operation: "edit", target: "agent/daily" })).rejects.toThrow("requires a prompt")
    expect(schedules.update).not.toHaveBeenCalled()
  })

  it("captures durable scheduled Agent turns without exposing or rebinding identity and delivery", async () => {
    const { schedule } = await import("../src/capabilities.ts")
    const createdAt = new Date("2026-05-23T00:00:00.000Z")
    let record: Record<string, unknown> | undefined
    const schedules = {
      create: vi.fn(async (input: Record<string, unknown>) => {
        record = { ...input, createdAt, enabled: input.enabled ?? true, updatedAt: createdAt }
        return record
      }),
      delete: vi.fn(async () => true),
      disable: vi.fn(async () => ({ ...record, enabled: false })),
      enable: vi.fn(async () => ({ ...record, enabled: true })),
      get: vi.fn(async () => record),
      list: vi.fn(async () => record ? [record] : []),
      run: vi.fn(async (id: string) => ({ id: `run-${id}`, scheduleId: id })),
      update: vi.fn(async (_id: string, input: Record<string, unknown>) => {
        record = { ...record, ...input }
        return record
      }),
    }
    const capability = schedule({
      allowSelfTarget: true,
      delivery: "origin",
      mode: "write",
      timeZone: "Asia/Bangkok",
    })
    const creator = {
      agentName: "digest",
      channelIds: ["discord"],
      invoker: {
        email: { address: "maxi@example.com", domain: "example.com" },
        id: "discord:user-1",
        kind: "chat",
        label: "Maxi",
        meta: { accessToken: "secret", providerUser: { id: "provider-1" } },
      },
      run: { channelId: "discord", origin: "discord", runId: "run-create", threadId: "discord:thread-1" },
    }
    const tools = await resolveTools([capability], { schedule: { schedules } }, undefined, creator)

    await expect(tools.cronjob!.execute?.({
      cron: "0 9 * * *",
      id: "daily",
      operation: "create",
      prompt: "Prepare my daily report.",
    })).resolves.toMatchObject({ id: "daily", target: "agent/digest" })
    expect(schedules.create).toHaveBeenCalledWith({
      cron: "0 9 * * *",
      enabled: undefined,
      id: "daily",
      input: {
        delivery: { channelId: "discord", origin: "discord", threadId: "discord:thread-1" },
        invoker: {
          email: { address: "maxi@example.com", domain: "example.com" },
          id: "discord:user-1",
          kind: "chat",
          label: "Maxi",
        },
        kind: "agent-turn",
        prompt: "Prepare my daily report.",
      },
      target: "agent/digest",
      timeZone: "Asia/Bangkok",
    })
    await expect(tools.cronjob!.execute?.({
      cron: "0 9 * * *",
      invoker: { id: "spoofed" },
      operation: "create",
      origin: "telegram",
      prompt: "Spoofed report.",
    } as never)).rejects.toThrow("does not support")
    const undeliverable = await resolveTools([capability], { schedule: { schedules } }, undefined, {
      agentName: "digest",
      invoker: { id: "cli:user-1" },
      run: { channelId: "cli", origin: "cli", runId: "run-without-thread" },
    })
    await expect(undeliverable.cronjob!.execute?.({
      cron: "0 10 * * *",
      operation: "create",
      prompt: "This cannot be delivered.",
    })).rejects.toThrow("channelId and threadId")
    const kindless = await resolveTools([capability], { schedule: { schedules } }, undefined, {
      agentName: "digest",
      channelIds: ["discord"],
      invoker: { id: "discord:user-1" },
      run: { channelId: "discord", origin: "discord", runId: "run-kindless", threadId: "discord:thread-1" },
    })
    await expect(kindless.cronjob!.execute?.({
      cron: "0 10 * * *",
      operation: "create",
      prompt: "This identity is incomplete.",
    })).rejects.toThrow("durable invoker kind")

    await expect(tools.cronjob!.execute?.({ id: "daily", operation: "get" })).resolves.toEqual({
      createdAt,
      cron: "0 9 * * *",
      enabled: true,
      id: "daily",
      prompt: "Prepare my daily report.",
      target: "agent/digest",
      timeZone: "Asia/Bangkok",
      updatedAt: createdAt,
    })
    await expect(tools.cronjob!.execute?.({ operation: "list" })).resolves.toEqual([{
      createdAt,
      cron: "0 9 * * *",
      enabled: true,
      id: "daily",
      prompt: "Prepare my daily report.",
      target: "agent/digest",
      timeZone: "Asia/Bangkok",
      updatedAt: createdAt,
    }])

    const intruder = await resolveTools([capability], { schedule: { schedules } }, undefined, {
      agentName: "digest",
      invoker: { id: "discord:user-2", kind: "chat", label: "Another user" },
      run: { channelId: "discord", origin: "discord", runId: "run-intruder", threadId: "discord:thread-2" },
    })
    await expect(intruder.cronjob!.execute?.({ operation: "list" })).resolves.toEqual([])
    await expect(intruder.cronjob!.execute?.({ id: "daily", operation: "get" })).rejects.toThrow("current invoker scope")
    await expect(intruder.cronjob!.execute?.({ id: "daily", operation: "edit", prompt: "Expose another user's report." })).rejects.toThrow("current invoker scope")
    await expect(intruder.cronjob!.execute?.({ id: "daily", operation: "run" })).rejects.toThrow("current invoker scope")
    await expect(intruder.cronjob!.execute?.({ id: "daily", operation: "pause" })).rejects.toThrow("current invoker scope")
    await expect(intruder.cronjob!.execute?.({ id: "daily", operation: "resume" })).rejects.toThrow("current invoker scope")
    await expect(intruder.cronjob!.execute?.({ id: "daily", operation: "delete" })).rejects.toThrow("current invoker scope")
    expect(schedules.update).not.toHaveBeenCalled()
    expect(schedules.run).not.toHaveBeenCalled()
    expect(schedules.disable).not.toHaveBeenCalled()
    expect(schedules.enable).not.toHaveBeenCalled()
    expect(schedules.delete).not.toHaveBeenCalled()

    const wrongInvokerKind = await resolveTools([capability], { schedule: { schedules } }, undefined, {
      agentName: "digest",
      invoker: { id: "discord:user-1", kind: "cli" },
      run: { origin: "cli", runId: "run-wrong-kind" },
    })
    await expect(wrongInvokerKind.cronjob!.execute?.({ operation: "list" })).resolves.toEqual([])
    await expect(wrongInvokerKind.cronjob!.execute?.({ id: "daily", operation: "get" })).rejects.toThrow("current invoker scope")

    const editor = await resolveTools([capability], { schedule: { schedules } }, undefined, {
      agentName: "digest",
      invoker: { id: "discord:user-1", kind: "chat", label: "Maxi, refreshed", meta: { accessToken: "different-secret" } },
      run: { channelId: "discord", origin: "discord", runId: "run-edit", threadId: "discord:thread-2" },
    })
    await editor.cronjob!.execute?.({ id: "daily", operation: "edit", prompt: "Prepare a shorter report.", timeZone: "Europe/Madrid" })
    expect(schedules.update).toHaveBeenLastCalledWith("daily", {
      input: {
        delivery: { channelId: "discord", origin: "discord", threadId: "discord:thread-1" },
        invoker: {
          email: { address: "maxi@example.com", domain: "example.com" },
          id: "discord:user-1",
          kind: "chat",
          label: "Maxi",
        },
        kind: "agent-turn",
        prompt: "Prepare a shorter report.",
      },
      timeZone: "Europe/Madrid",
    })
    await expect(editor.cronjob!.execute?.({ id: "daily", operation: "run" })).resolves.toEqual({ id: "run-daily", scheduleId: "daily" })
    await expect(editor.cronjob!.execute?.({ id: "daily", operation: "pause" })).resolves.toMatchObject({ enabled: false, prompt: "Prepare a shorter report." })
    await expect(editor.cronjob!.execute?.({ id: "daily", operation: "resume" })).resolves.toMatchObject({ enabled: true, prompt: "Prepare a shorter report." })
    await expect(editor.cronjob!.execute?.({ id: "daily", operation: "delete" })).resolves.toBe(true)
  })

  it("keeps Agent-turn ownership when its target is in a generic allowlist", async () => {
    const { schedule } = await import("../src/capabilities.ts")
    const generic = { cron: "0 8 * * *", enabled: true, id: "generic", target: "reports" }
    const privateTurn = {
      cron: "0 9 * * *",
      enabled: true,
      id: "private-turn",
      input: {
        invoker: { id: "discord:user-1", kind: "chat" },
        kind: "agent-turn",
        prompt: "Private report prompt.",
      },
      target: "reports",
    }
    const schedules = {
      get: vi.fn(async id => [generic, privateTurn].find(record => record.id === id)),
      list: vi.fn(async () => [generic, privateTurn]),
    }
    const capability = schedule({ mode: "read", targets: ["reports"] })
    const owner = await resolveTools([capability], { schedule: { schedules } }, undefined, {
      invoker: { id: "discord:user-1", kind: "chat" },
    })
    const intruder = await resolveTools([capability], { schedule: { schedules } }, undefined, {
      invoker: { id: "discord:user-2", kind: "chat" },
    })

    await expect(owner.cronjob!.execute?.({ operation: "list" })).resolves.toEqual([
      generic,
      { cron: "0 9 * * *", enabled: true, id: "private-turn", prompt: "Private report prompt.", target: "reports" },
    ])
    await expect(intruder.cronjob!.execute?.({ operation: "list" })).resolves.toEqual([generic])
    await expect(intruder.cronjob!.execute?.({ id: "private-turn", operation: "get" })).rejects.toThrow("current invoker scope")
  })

  it("applies self-target permissions to Runtime Schedule list results", async () => {
    const { schedule } = await import("../src/capabilities.ts")
    const records = [
      { cron: "0 9 * * *", enabled: true, id: "own", target: "agent/daily" },
      { cron: "0 10 * * *", enabled: true, id: "reports", target: "reports" },
    ]
    const tools = await resolveTools([schedule({ mode: "read", targets: ["agent/daily", "reports"] })], {
      schedule: {
        get: vi.fn(),
        list: vi.fn(async () => records),
      },
    }, undefined, { agentName: "daily" })

    await expect(tools.cronjob!.execute?.({ operation: "targets" })).resolves.toEqual({ targets: ["reports"] })
    await expect(tools.cronjob!.execute?.({ operation: "list" })).resolves.toEqual([records[1]])
  })

  it("accepts read-only Runtime Schedule clients in read mode", async () => {
    const { schedule } = await import("../src/capabilities.ts")
    const tools = await resolveTools([schedule({ mode: "read", targets: ["reports"] })], {
      schedule: {
        get: vi.fn(),
        list: vi.fn(async () => []),
      },
    })

    expect(Object.keys(tools)).toEqual(["cronjob"])
  })

  it("uses strict Runtime Schedule tool schemas", async () => {
    const { schedule } = await import("../src/capabilities.ts")
    const tools = await resolveTools([schedule({ allowSelfTarget: true, mode: "write", targets: ["reports"] })], {
      schedule: {
        create: vi.fn(),
        delete: vi.fn(),
        disable: vi.fn(),
        enable: vi.fn(),
        get: vi.fn(),
        list: vi.fn(),
        run: vi.fn(),
        update: vi.fn(),
      },
    })

    expect(tools.cronjob!.inputSchema).toMatchObject({
      oneOf: expect.arrayContaining([
        expect.objectContaining({
          additionalProperties: false,
          properties: expect.not.objectContaining({
            at: expect.anything(),
            every: expect.anything(),
            policy: expect.anything(),
            timezone: expect.anything(),
          }),
        }),
      ]),
    })
    expect(tools.cronjob!.inputSchema).toMatchObject({
      oneOf: expect.arrayContaining([
        expect.objectContaining({
          properties: expect.objectContaining({
            timeZone: expect.objectContaining({ type: "string" }),
          }),
        }),
      ]),
    })
    const variants = (tools.cronjob!.inputSchema as { oneOf: Array<{ properties?: Record<string, unknown> }> }).oneOf
    expect(variants.some(variant => variant.properties?.prompt)).toBe(true)
    expect(variants).toEqual(expect.arrayContaining([
      expect.objectContaining({
        properties: expect.objectContaining({
          operation: expect.objectContaining({ const: "create" }),
          timeZone: expect.objectContaining({ description: expect.stringContaining("schedule({ timeZone }), then UTC") }),
        }),
      }),
      expect.objectContaining({
        properties: expect.objectContaining({
          operation: expect.objectContaining({ const: "edit" }),
          timeZone: expect.objectContaining({ description: expect.stringContaining("preserve the existing value") }),
        }),
      }),
    ]))
    const editVariants = variants.filter(variant => (variant.properties?.operation as { const?: unknown } | undefined)?.const === "edit")
    expect(editVariants).toEqual(expect.arrayContaining([
      expect.objectContaining({ properties: expect.objectContaining({ prompt: expect.anything() }) }),
      expect.objectContaining({ properties: expect.objectContaining({ target: expect.anything() }) }),
    ]))
    expect(editVariants.every(variant => !(variant.properties?.prompt && variant.properties.target))).toBe(true)
    for (const variant of variants) {
      expect(variant.properties).not.toEqual(expect.objectContaining({
        channelId: expect.anything(),
        delivery: expect.anything(),
        invoker: expect.anything(),
        origin: expect.anything(),
        threadId: expect.anything(),
      }))
    }
  })

  it("exposes curated KV read and edit tools", async () => {
    const { kv } = await import("../src/capabilities.ts")
    const store = {
      del: vi.fn(async () => undefined),
      get: vi.fn(async () => "value"),
      keys: vi.fn(async () => ["app:1"]),
      set: vi.fn(async () => undefined),
    }

    await expect(resolveTools([kv()], { kv: { kind: "kv", value: store } }).then(tools => Object.keys(tools).sort())).resolves.toEqual(["kv_read"])

    const tools = await resolveTools([kv({ mode: "write" })], { kv: { kind: "kv", value: store } })
    expect(Object.keys(tools).sort()).toEqual(["kv_edit", "kv_read"])
    expect(tools.kv_edit?.policy).toBeUndefined()

    await expect(tools.kv_read!.execute?.({ key: "app:1" })).resolves.toBe("value")
    await expect(tools.kv_read!.execute?.({ prefix: "app:" })).resolves.toEqual(["app:1"])
    await expect(Promise.resolve().then(() => tools.kv_read!.execute?.({ key: "app:1", prefix: "app:" }))).rejects.toThrow("exactly one")
    await expect(Promise.resolve().then(() => tools.kv_read!.execute?.({}))).rejects.toThrow("exactly one")
    await expect(Promise.resolve().then(() => tools.kv_read!.execute?.({ key: null } as never))).rejects.toThrow("exactly one")
    expect(store.keys).toHaveBeenCalledTimes(1)

    await tools.kv_edit!.execute?.({ key: "app:2", operation: "put", value: { ok: true } })
    await tools.kv_edit!.execute?.({ key: "app:2", operation: "delete" })
    expect(store.set).toHaveBeenCalledWith("app:2", { ok: true })
    expect(store.del).toHaveBeenCalledWith("app:2")
  })

  it("selects configured KV and Blob stores from capability options", async () => {
    const { blob, kv } = await import("../src/capabilities.ts")
    const kvStore = { get: vi.fn(async () => "selected"), keys: vi.fn() }
    const blobStore = { get: vi.fn(), head: vi.fn(), list: vi.fn(async () => ({ blobs: [] })) }
    const kvRoot = { store: vi.fn(() => kvStore) }
    const blobRoot = { store: vi.fn(() => blobStore) }

    const kvTools = await resolveTools([kv({ store: "chat" })], { kv: kvRoot })
    await expect(kvTools.kv_read!.execute?.({ key: "thread:1" })).resolves.toBe("selected")
    expect(kvRoot.store).toHaveBeenCalledWith("chat")

    const blobTools = await resolveTools([blob({ store: "assets" })], { blob: blobRoot })
    await blobTools.blob_read!.execute?.({ operation: "list", prefix: "images/" })
    expect(blobRoot.store).toHaveBeenCalledWith("assets")
    expect(blobStore.list).toHaveBeenCalledWith({ cursor: undefined, folded: undefined, limit: 25, prefix: "images/" })
  })

  it("unwraps error-first KV and Blob primitive results for agent tools", async () => {
    const { blob, kv } = await import("../src/capabilities.ts")
    const failure = new Error("storage failed")
    const kvStore = {
      del: vi.fn(async () => [null, undefined] as const),
      get: vi.fn(async () => [null, ["tuple", "value"]] as const),
      keys: vi.fn(async () => [failure, undefined] as const),
      set: vi.fn(async () => [null, undefined] as const),
    }
    const blobStore = {
      get: vi.fn(async () => [null, new Blob(["body"])] as const),
      head: vi.fn(async () => [failure, undefined] as const),
      list: vi.fn(async () => [null, { blobs: [] }] as const),
    }

    const kvTools = await resolveTools([kv({ mode: "write" })], { kv: kvStore })
    await expect(kvTools.kv_read!.execute?.({ key: "tuple" })).resolves.toEqual(["tuple", "value"])
    await expect(kvTools.kv_read!.execute?.({ prefix: "app:" })).rejects.toBe(failure)
    await expect(kvTools.kv_edit!.execute?.({ key: "tuple", operation: "put", value: true })).resolves.toBeUndefined()

    const blobTools = await resolveTools([blob()], { blob: blobStore })
    await expect(blobTools.blob_read!.execute?.({ operation: "list", prefix: "images/" })).resolves.toEqual({ blobs: [] })
    await expect(blobTools.blob_read!.execute?.({ operation: "head", pathname: "images/a.png" })).rejects.toBe(failure)
  })

  it("exposes curated Blob read and edit tools", async () => {
    const { blob } = await import("../src/capabilities.ts")
    const workspaceBytes = new Uint8Array([1, 2, 3])
    const workspace = {
      fs: {
        readFile: vi.fn(async () => workspaceBytes),
      },
    } as unknown as ReadonlyWorkspaceFacade
    const store = {
      del: vi.fn(async () => undefined),
      get: vi.fn(async () => new Blob(["body"])),
      head: vi.fn(async () => ({ pathname: "images/a.png" })),
      list: vi.fn(async () => ({ blobs: [], hasMore: false })),
      put: vi.fn(async () => ({ pathname: "images/a.png" })),
    }

    await expect(resolveTools([blob()], { blob: store }).then(tools => Object.keys(tools).sort())).resolves.toEqual(["blob_read"])

    const tools = await resolveTools([blob({ mode: "write" })], { blob: store }, workspace)
    expect(Object.keys(tools).sort()).toEqual(["blob_edit", "blob_read"])
    expect(tools.blob_edit?.policy).toBeUndefined()

    await tools.blob_read!.execute?.({ operation: "get", pathname: "images/a.png" })
    await tools.blob_read!.execute?.({ operation: "head", pathname: "images/a.png" })
    await tools.blob_read!.execute?.({ limit: 500, operation: "list", prefix: "images/" })
    expect(store.list).toHaveBeenCalledWith({ cursor: undefined, folded: undefined, limit: 100, prefix: "images/" })
    await expect(Promise.resolve().then(() => tools.blob_read!.execute?.({ operation: "list" }))).rejects.toThrow("prefix")

    const body = new Blob(["data"], { type: "image/png" })
    await tools.blob_edit!.execute?.({ body, operation: "put", options: { contentType: "image/png" }, pathname: "images/a.png" })
    await tools.blob_edit!.execute?.({ operation: "put", pathname: "images/from-workspace.png", workspacePath: "screenshots/result.png" })
    await expect(Promise.resolve().then(() => tools.blob_edit!.execute?.({ body: "inline", operation: "put", pathname: "images/a.png", workspacePath: "screenshots/result.png" }))).rejects.toThrow("exactly one")
    await expect(Promise.resolve().then(() => tools.blob_edit!.execute?.({ operation: "put", pathname: "images/a.png" }))).rejects.toThrow("attachmentId, body, or workspacePath")
    await expect(tools.blob_edit!.execute?.({ operation: "delete", pathname: "images/a.png" })).resolves.toEqual({ pathname: "images/a.png", deleted: true })
    expect(store.put).toHaveBeenCalledWith("images/a.png", body, { contentType: "image/png" })
    expect(workspace.fs.readFile).toHaveBeenCalledWith("screenshots/result.png", { encoding: "binary" })
    expect(store.put).toHaveBeenCalledWith("images/from-workspace.png", workspaceBytes, undefined)
    expect(store.del).toHaveBeenCalledWith("images/a.png")
  })

  it("uploads a current input attachment by id", async () => {
    const { blob } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const bytes = new Uint8Array([1, 2, 3])
    const store = {
      del: vi.fn(),
      get: vi.fn(),
      head: vi.fn(),
      list: vi.fn(),
      put: vi.fn(async pathname => ({ pathname })),
    }
    const resolved = await resolveAgentCapabilities(
      { capabilities: [blob({ mode: "write" })] },
      {
        ...runtime({ blob: store }),
        run: { messageId: "message-2", runId: "run-1" },
      },
      {
        messages: [
          { id: "message-1", parts: [{ id: "attachment-1", mediaType: "image/png", type: "image", data: "old" }], role: "user" },
          { id: "message-2", parts: [{ id: "attachment-1", mediaType: "image/jpeg", type: "image", fetchData: vi.fn(async () => bytes) }], role: "user" },
        ],
      },
    )

    await expect(resolved.tools!.blob_edit!.execute?.({
      attachmentId: "attachment-1",
      operation: "put",
      pathname: "meals/current/original",
    })).resolves.toEqual({ pathname: "meals/current/original" })
    expect(store.put).toHaveBeenCalledWith("meals/current/original", bytes, { contentType: "image/jpeg" })
  })

  it("uploads workspacePath from the active Harness workspace when available", async () => {
    const { blob } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { createAgentInvocationContextStore } = await import("../src/invocation-context.ts")
    const { setActiveHarnessWorkspaceFiles } = await import("../src/harness-runtime.ts")
    const harnessBytes = new Uint8Array([4, 5, 6])
    const workspaceBytes = new Uint8Array([1, 2, 3])
    const context = createAgentInvocationContextStore()
    const readFile = vi.fn(async () => ({ active: true as const, body: harnessBytes }))
    setActiveHarnessWorkspaceFiles(context, { readFile })
    const workspace = {
      fs: {
        readFile: vi.fn(async () => workspaceBytes),
      },
    } as unknown as ReadonlyWorkspaceFacade
    const store = {
      del: vi.fn(),
      get: vi.fn(),
      head: vi.fn(),
      list: vi.fn(async () => ({ blobs: [], hasMore: false })),
      put: vi.fn(async () => ({ pathname: "images/from-harness.png" })),
    }

    const resolved = await resolveAgentCapabilities(
      { capabilities: [blob({ mode: "write" })] },
      runtime({ blob: store }),
      {},
      workspace as never,
      "write",
      { context },
    )

    await resolved.tools!.blob_edit!.execute?.({ operation: "put", pathname: "images/from-harness.png", workspacePath: "screenshots/result.png" })
    expect(readFile).toHaveBeenCalledWith("screenshots/result.png")
    expect(workspace.fs.readFile).not.toHaveBeenCalled()
    expect(store.put).toHaveBeenCalledWith("images/from-harness.png", harnessBytes, undefined)
  })

  it("does not fall back to persisted Workspace FS when the active Harness workspace misses a file", async () => {
    const { blob } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { createAgentInvocationContextStore } = await import("../src/invocation-context.ts")
    const { setActiveHarnessWorkspaceFiles } = await import("../src/harness-runtime.ts")
    const context = createAgentInvocationContextStore()
    const readFile = vi.fn(async () => ({ active: true as const, body: undefined }))
    setActiveHarnessWorkspaceFiles(context, { readFile })
    const workspace = {
      fs: {
        readFile: vi.fn(async () => new Uint8Array([1, 2, 3])),
      },
    } as unknown as ReadonlyWorkspaceFacade
    const store = {
      del: vi.fn(),
      get: vi.fn(),
      head: vi.fn(),
      list: vi.fn(async () => ({ blobs: [], hasMore: false })),
      put: vi.fn(),
    }

    const resolved = await resolveAgentCapabilities(
      { capabilities: [blob({ mode: "write" })] },
      runtime({ blob: store }),
      {},
      workspace as never,
      "write",
      { context },
    )

    await expect(resolved.tools!.blob_edit!.execute?.({ operation: "put", pathname: "images/missing.png", workspacePath: "screenshots/missing.png" })).rejects.toThrow("active Harness Workspace Session")
    expect(readFile).toHaveBeenCalledWith("screenshots/missing.png")
    expect(workspace.fs.readFile).not.toHaveBeenCalled()
    expect(store.put).not.toHaveBeenCalled()
  })

  it("falls back to the installed Blob primitive at tool execution time", async () => {
    const store = {
      list: vi.fn(async () => ({ blobs: [], hasMore: false })),
    }
    vi.doMock("@vite-hub/blob", () => ({ blob: store }))
    try {
      const { blob } = await import("../src/capabilities.ts")
      const tools = await resolveTools([blob()], {})

      await tools.blob_read!.execute?.({ operation: "list", prefix: "images/" })
      expect(store.list).toHaveBeenCalledWith({ cursor: undefined, folded: undefined, limit: 25, prefix: "images/" })
    }
    finally {
      vi.doUnmock("@vite-hub/blob")
    }
  })

  it("defaults DB to schema and query tools and selects named databases", async () => {
    const { db } = await import("../src/capabilities.ts")
    const analytics = {
      query: vi.fn(async () => [{ id: 1 }]),
      schema: { events: true },
    }
    const dbPrimitive = {
      database: vi.fn(() => analytics),
    }
    const tools = await resolveTools([db({ database: "analytics" })], {
      db: dbPrimitive,
    })

    expect(Object.keys(tools).sort()).toEqual(["db_query", "db_schema"])
    await expect(tools.db_schema!.execute?.({})).resolves.toEqual({ database: "analytics", schema: { events: true } })
    await expect(tools.db_query!.execute?.({ statement: "select * from events;" })).resolves.toEqual([{ id: 1 }])
    expect(dbPrimitive.database).toHaveBeenCalledWith("analytics")
    expect(analytics.query).toHaveBeenCalledWith("select * from events")
  })

  it("selects the default DB through primitive database selectors", async () => {
    const { db } = await import("../src/capabilities.ts")
    const defaultDatabase = {
      query: vi.fn(async () => [{ id: 1 }]),
      schema: { notes: true },
    }
    const dbPrimitive = {
      database: vi.fn(() => defaultDatabase),
    }
    const tools = await resolveTools([db()], {
      db: dbPrimitive,
    })

    await expect(tools.db_schema!.execute?.({})).resolves.toEqual({ database: "default", schema: { notes: true } })
    await expect(tools.db_query!.execute?.({ statement: "select * from notes;" })).resolves.toEqual([{ id: 1 }])
    expect(dbPrimitive.database).toHaveBeenCalledWith("default")
    expect(defaultDatabase.query).toHaveBeenCalledWith("select * from notes")
  })

  it("expects an agent-facing raw SQL DB handle instead of adapting Drizzle entries", async () => {
    const { db } = await import("../src/capabilities.ts")
    const database = {
      db: { run: vi.fn() },
      schema: { notes: true },
    }
    const tools = await resolveTools([db({ mode: "write" })], {
      db: database,
    })

    await expect(tools.db_schema!.execute?.({})).resolves.toEqual({ database: "default", schema: { notes: true } })
    await expect(tools.db_query!.execute?.({ statement: "select * from notes" })).rejects.toThrow("raw string query")
    await expect(tools.db_exec!.execute?.({ rationale: "cleanup", statement: "delete from notes where id = 1" })).rejects.toThrow("raw string exec")
    expect(database.db.run).not.toHaveBeenCalled()
  })

  it("resolves DB schema from method-style primitive handles", async () => {
    const { db } = await import("../src/capabilities.ts")
    const database = {
      query: vi.fn(async () => []),
      schema: vi.fn(async () => ({ notes: true })),
    }
    const tools = await resolveTools([db()], {
      db: database,
    })

    await expect(tools.db_schema!.execute?.({})).resolves.toEqual({ database: "default", schema: { notes: true } })
    expect(database.schema).toHaveBeenCalledTimes(1)
  })

  it("applies DB SQL guardrails and data/schema permissions", async () => {
    const { db } = await import("../src/capabilities.ts")
    const database = {
      exec: vi.fn(async () => ({ ok: true })),
      query: vi.fn(async () => ({ ok: true })),
      schema: {},
    }

    const readTools = await resolveTools([db()], { db: database })
    expect(readTools.db_exec).toBeUndefined()
    await expect(readTools.db_query!.execute?.({ statement: "select ';' as semi; -- trailing" })).resolves.toEqual({ ok: true })
    await expect(readTools.db_query!.execute?.({ statement: "pragma table_list" })).resolves.toEqual({ ok: true })
    await expect(readTools.db_query!.execute?.({ statement: "pragma index_xinfo(notes_title_idx)" })).resolves.toEqual({ ok: true })
    await expect(Promise.resolve().then(() => readTools.db_query!.execute?.({ statement: "select 1; select 2" }))).rejects.toThrow("only accepts one")
    await expect(Promise.resolve().then(() => readTools.db_query!.execute?.({ statement: "delete from notes" }))).rejects.toThrow("read-only")
    await expect(Promise.resolve().then(() => readTools.db_query!.execute?.({ statement: "begin transaction" }))).rejects.toThrow("read-only")
    await expect(readTools.db_query!.execute?.({ statement: "with x as (select 'delete') select * from x" })).resolves.toEqual({ ok: true })
    await expect(readTools.db_query!.execute?.({ statement: "with replace as (select 1) select * from replace" })).resolves.toEqual({ ok: true })
    await expect(readTools.db_query!.execute?.({ statement: "with [delete] as (select 1) select * from [delete]" })).resolves.toEqual({ ok: true })
    await expect(readTools.db_query!.execute?.({ statement: "with cleaned as (select replace(title, 'a', 'b') from notes) select * from cleaned" })).resolves.toEqual({ ok: true })

    const writeTools = await resolveTools([db({ mode: "write" })], { db: database })
    expect(writeTools.db_exec?.policy).toBeUndefined()
    await expect(Promise.resolve().then(() => writeTools.db_exec!.execute?.({ rationale: "", statement: "delete from notes where id = 1" }))).rejects.toThrow("rationale")
    await expect(Promise.resolve().then(() => writeTools.db_exec!.execute?.({ rationale: "remove duplicate", statement: "delete from notes where id = 1; delete from notes where id = 2" }))).rejects.toThrow("exactly one")
    await expect(Promise.resolve().then(() => writeTools.db_exec!.execute?.({ rationale: "create table", statement: "create table notes (id integer)" }))).rejects.toThrow("schemaMode")
    await expect(writeTools.db_exec!.execute?.({ rationale: "remove duplicate", statement: "delete from notes where id = 1" })).resolves.toEqual({ ok: true })
    await expect(writeTools.db_exec!.execute?.({ rationale: "remove duplicate", statement: "with stale as (select id from notes) delete from notes where id in (select id from stale)" })).resolves.toEqual({ ok: true })

    const schemaTools = await resolveTools([db({ schemaMode: "write" })], { db: database })
    await expect(schemaTools.db_exec!.execute?.({ rationale: "create table", statement: "create table notes (id integer)" })).resolves.toEqual({ ok: true })
    await expect(Promise.resolve().then(() => schemaTools.db_exec!.execute?.({ rationale: "read", statement: "select * from notes" }))).rejects.toThrow("use db_query")
  })
})
