import { rm } from "node:fs/promises"

import { afterEach, describe, expect, it, vi } from "vitest"

import {
  createMemoryAgentInvocationStore,
  failInterruptedAgentInvocations,
  readAgentInvocationWorkload,
  summarizeAgentInvocationWorkload,
} from "../src/server.ts"
import { createGitHubHost } from "../src/server/github.ts"

const temporaryDirectories = new Set<string>()

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  await Promise.all([...temporaryDirectories].map(path => rm(path, { force: true, recursive: true })))
  temporaryDirectories.clear()
})

describe("GitHub host", () => {
  it("does not resolve credentials for a pre-aborted operation", async () => {
    const credentials = vi.fn(() => Promise.reject(new Error("resolver should not run")))
    const host = createGitHubHost({ credentials })
    const controller = new AbortController()
    controller.abort(new Error("already cancelled"))
    await expect(host.access({ signal: controller.signal })).rejects.toThrow("already cancelled")
    expect(credentials).not.toHaveBeenCalled()
  })

  it("creates a Forge provider and reports response rate limits", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json", "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "4998", "x-ratelimit-reset": "2000000000", "x-ratelimit-resource": "core" },
    }))
    const host = createGitHubHost({ credentials: () => ({ token: "private-token" }), fetch })
    const provider = await host.forge({ repository: "acme/app" })
    await expect(provider.request("GET", "/rate")).resolves.toMatchObject({ data: { ok: true } })
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/rate"), expect.anything())
    expect(host.rateLimit()).toMatchObject({ resource: "core", limit: 5000, remaining: 4998, resetAt: 2_000_000_000_000 })
  })

  it("keeps child-shell GitHub credentials in the environment", async () => {
    const host = createGitHubHost({ credentials: () => ({ token: "private-token" }) })
    await expect(host.environment()).resolves.toMatchObject({ GH_TOKEN: "private-token", GITHUB_TOKEN: "private-token", GH_HOST: "github.com" })
  })
})

describe("Agent Invocation host recovery", () => {
  it("fails only interrupted active invocations", async () => {
    const store = createMemoryAgentInvocationStore()
    const create = (id: string, status: "completed" | "pending" | "running", createdAt: string) => store.create({
      createdAt,
      id,
      observations: [],
      status,
      traceId: `trace-${id}`,
      updatedAt: createdAt,
    })
    create("old-pending", "pending", "2026-08-30T10:00:00.000Z")
    create("new-running", "running", "2026-08-30T12:00:00.000Z")
    create("completed", "completed", "2026-08-30T09:00:00.000Z")

    await expect(failInterruptedAgentInvocations(store, {
      before: Date.parse("2026-08-30T11:00:00.000Z"),
      recover: () => true,
    })).resolves.toBe(1)
    await expect(Promise.resolve(store.get("old-pending"))).resolves.toMatchObject({
      error: { message: "The host stopped before this Agent Invocation finished." },
      status: "failed",
    })
    await expect(Promise.resolve(store.get("new-running"))).resolves.toMatchObject({ status: "running" })
  })

  it("scopes shared-store recovery to the owning process host", async () => {
    const store = createMemoryAgentInvocationStore()
    const createdAt = "2026-08-30T10:00:00.000Z"
    store.create({ agentName: "babysitter-worker", createdAt, id: "worker", observations: [], status: "running", traceId: "worker", updatedAt: createdAt })
    store.create({ agentName: "console-worker", createdAt, id: "other", observations: [], status: "running", traceId: "other", updatedAt: createdAt })

    await expect(failInterruptedAgentInvocations(store, {
      agentName: "babysitter-worker",
      before: Date.parse("2026-08-30T11:00:00.000Z"),
      recover: () => true,
    })).resolves.toBe(1)
    await expect(Promise.resolve(store.get("worker"))).resolves.toMatchObject({ status: "failed" })
    await expect(Promise.resolve(store.get("other"))).resolves.toMatchObject({ status: "running" })
  })

  it("recovers every page without taking work claimed by another host", async () => {
    const store = createMemoryAgentInvocationStore()
    const createdAt = "2026-08-30T10:00:00.000Z"
    for (let index = 0; index < 101; index += 1) {
      store.create({
        createdAt,
        id: `old-${index}`,
        observations: [],
        status: "running",
        traceId: `trace-${index}`,
        updatedAt: createdAt,
      })
    }
    await store.claim("old-100", "live-host", 60_000)

    await expect(failInterruptedAgentInvocations(store, {
      before: Date.parse("2026-08-30T11:00:00.000Z"),
      claimLeaseMs: 1,
      limit: 25,
      recover: invocation => invocation.id !== "old-100",
    })).resolves.toBe(100)
    await expect(Promise.resolve(store.get("old-0"))).resolves.toMatchObject({ status: "failed" })
    await expect(Promise.resolve(store.get("old-100"))).resolves.toMatchObject({ status: "running" })
  })

  it("takes over a stopped host claim after the recovery timeout", async () => {
    vi.useFakeTimers()
    const store = createMemoryAgentInvocationStore()
    const createdAt = "2026-08-30T10:00:00.000Z"
    store.create({ createdAt, id: "interrupted", observations: [], status: "running", traceId: "trace", updatedAt: createdAt })
    await store.claim("interrupted", "stopped-host", 100)

    const recovery = failInterruptedAgentInvocations(store, {
      before: Date.parse("2026-08-30T11:00:00.000Z"),
      claimLeaseMs: 20,
      recoveryTimeoutMs: 20,
      recover: () => true,
    })
    await vi.advanceTimersByTimeAsync(20)

    await expect(recovery).resolves.toBe(1)
    await expect(Promise.resolve(store.get("interrupted"))).resolves.toMatchObject({ status: "failed" })
  })

  it("preserves work reclaimed by a live host during the recovery timeout", async () => {
    vi.useFakeTimers()
    const store = createMemoryAgentInvocationStore()
    const createdAt = "2026-08-30T10:00:00.000Z"
    store.create({ createdAt, id: "reclaimed", observations: [], status: "running", traceId: "trace", updatedAt: createdAt })
    await store.claim("reclaimed", "live-host", 100)
    let stopped = true
    const recover = vi.fn(() => stopped)

    const recovery = failInterruptedAgentInvocations(store, {
      before: Date.parse("2026-08-30T11:00:00.000Z"),
      claimLeaseMs: 20,
      recoveryTimeoutMs: 20,
      recover,
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(recover).toHaveBeenCalledOnce()
    stopped = false
    await vi.advanceTimersByTimeAsync(20)

    await expect(recovery).resolves.toBe(0)
    await expect(Promise.resolve(store.get("reclaimed"))).resolves.toMatchObject({ status: "running" })
  })

  it("preserves a claim renewed between the final recovery check and takeover", async () => {
    vi.useFakeTimers()
    const store = createMemoryAgentInvocationStore()
    const createdAt = "2026-08-30T10:00:00.000Z"
    store.create({ createdAt, id: "renewed", observations: [], status: "running", traceId: "trace", updatedAt: createdAt })
    await store.claim("renewed", "stopped-host", 100)
    let recoveries = 0

    const recovery = failInterruptedAgentInvocations(store, {
      before: Date.parse("2026-08-30T11:00:00.000Z"),
      claimLeaseMs: 20,
      recoveryTimeoutMs: 20,
      recover: async () => {
        recoveries += 1
        if (recoveries === 2) await store.claim("renewed", "live-host", 100, { replaceExisting: true })
        return true
      },
    })
    await vi.advanceTimersByTimeAsync(20)

    await expect(recovery).resolves.toBe(0)
    await expect(Promise.resolve(store.get("renewed"))).resolves.toMatchObject({ status: "running" })
  })

  it("preserves a claim replaced without advancing the clock", async () => {
    vi.useFakeTimers()
    const store = createMemoryAgentInvocationStore()
    const createdAt = "2026-08-30T10:00:00.000Z"
    store.create({ createdAt, id: "renewed", observations: [], status: "running", traceId: "trace", updatedAt: createdAt })
    await store.claim("renewed", "stopped-host", 100)
    let recoveries = 0

    const recovery = failInterruptedAgentInvocations(store, {
      before: Date.parse("2026-08-30T11:00:00.000Z"),
      claimLeaseMs: 20,
      recoveryTimeoutMs: 20,
      recover: async () => {
        recoveries += 1
        if (recoveries === 2) await store.claim("renewed", "live-host", 100, { replaceExisting: true })
        return true
      },
    })
    await vi.advanceTimersByTimeAsync(20)

    await expect(recovery).resolves.toBe(0)
    await expect(Promise.resolve(store.get("renewed"))).resolves.toMatchObject({ status: "running" })
  })

  it("excludes provider-owned durable work from process recovery", async () => {
    const store = createMemoryAgentInvocationStore()
    const createdAt = "2026-08-30T10:00:00.000Z"
    store.create({ createdAt, id: "host-owned", observations: [], status: "running", traceId: "host", updatedAt: createdAt })
    store.create({ createdAt, id: "provider-owned", observations: [], status: "running", traceId: "provider", updatedAt: createdAt })

    await expect(failInterruptedAgentInvocations(store, {
      before: Date.parse("2026-08-30T11:00:00.000Z"),
      recover: invocation => invocation.id === "host-owned",
    })).resolves.toBe(1)
    await expect(Promise.resolve(store.get("provider-owned"))).resolves.toMatchObject({ status: "running" })
  })

  it("rejects repeated recovery cursors before processing the repeated page", async () => {
    const store = createMemoryAgentInvocationStore()
    const createdAt = "2026-08-30T10:00:00.000Z"
    store.create({ createdAt, id: "interrupted", observations: [], status: "running", traceId: "trace", updatedAt: createdAt })
    const invocation = {
      cursor: "interrupted",
      createdAt,
      id: "interrupted",
      status: "running" as const,
      traceId: "trace",
      updatedAt: createdAt,
    }
    const list = vi.spyOn(store, "list").mockResolvedValue({ cursor: "same", invocations: [invocation] })
    const recover = vi.fn(() => true)

    await expect(failInterruptedAgentInvocations(store, {
      before: Date.parse("2026-08-30T11:00:00.000Z"),
      recover,
    })).rejects.toThrow("Agent Invocation listing returned a repeated pagination cursor")
    expect(list).toHaveBeenCalledTimes(2)
    expect(recover).toHaveBeenCalledOnce()
    await expect(Promise.resolve(store.get("interrupted"))).resolves.toMatchObject({ status: "failed" })
  })

  it("retries blocked claims before rejecting a repeated recovery cursor", async () => {
    vi.useFakeTimers()
    const store = createMemoryAgentInvocationStore()
    const createdAt = "2026-08-30T10:00:00.000Z"
    store.create({ createdAt, id: "interrupted", observations: [], status: "running", traceId: "trace", updatedAt: createdAt })
    await store.claim("interrupted", "stopped-host", 100)
    const page = await store.list({ status: ["running"] })
    const list = vi.spyOn(store, "list").mockResolvedValue({ ...page, cursor: "same" })
    const recover = vi.fn(() => true)
    const update = vi.spyOn(store, "update")
    const recovery = failInterruptedAgentInvocations(store, {
      before: Date.parse("2026-08-30T11:00:00.000Z"),
      claimLeaseMs: 20,
      recoveryTimeoutMs: 20,
      recover,
    })
    const rejection = expect(recovery).rejects.toThrow("Agent Invocation listing returned a repeated pagination cursor")

    await vi.advanceTimersByTimeAsync(19)
    expect(list).toHaveBeenCalledTimes(2)
    expect(recover).toHaveBeenCalledOnce()
    expect(update).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    await rejection
    expect(recover).toHaveBeenCalledTimes(2)
    expect(update).toHaveBeenCalledOnce()
    await expect(Promise.resolve(store.get("interrupted"))).resolves.toMatchObject({ status: "failed" })
  })

  it("summarizes current and stale work", () => {
    expect(summarizeAgentInvocationWorkload([
      { createdAt: "2026-08-30T09:00:00.000Z", status: "running" },
      { createdAt: "2026-08-30T11:00:00.000Z", status: "pending" },
      { createdAt: "2026-08-30T08:00:00.000Z", status: "completed" },
      { createdAt: "2026-08-30T08:00:00.000Z", status: "failed" },
      { createdAt: "2026-08-30T08:00:00.000Z", status: "cancelled" },
    ], Date.parse("2026-08-30T10:00:00.000Z"))).toEqual({
      active: 1,
      completed: 1,
      failed: 1,
      stale: 1,
      total: 5,
    })
  })

  it("rejects repeated invocation workload cursors", async () => {
    const list = vi.fn(async () => ({
      cursor: "same",
      invocations: [],
    }))

    await expect(readAgentInvocationWorkload({ list }, Date.parse("2026-08-30T10:00:00.000Z"))).rejects.toThrow(
      "Agent Invocation listing returned a repeated pagination cursor",
    )
    expect(list).toHaveBeenCalledTimes(3)
  })

  it("reads recent and all active Agent Invocations through the public list interface", async () => {
    const list = vi.fn(async (options = {}) => {
      if (!("status" in options)) {
        return {
          invocations: [
            invocationSummary("current", "pending", "2026-08-30T10:01:00.000Z"),
            invocationSummary("complete", "completed", "2026-08-30T09:50:00.000Z"),
            invocationSummary("failed", "failed", "2026-08-30T09:40:00.000Z"),
            invocationSummary("cancelled", "cancelled", "2026-08-30T09:30:00.000Z"),
          ],
        }
      }

      if (!options.cursor) {
        return {
          cursor: "opaque-next-page",
          invocations: [
            invocationSummary("current", "pending", "2026-08-30T10:01:00.000Z"),
            invocationSummary("stale", "running", "2026-08-30T09:00:00.000Z"),
          ],
        }
      }

      return { invocations: [invocationSummary("older-active", "running", "2026-08-30T10:02:00.000Z")] }
    })

    await expect(readAgentInvocationWorkload({ list }, Date.parse("2026-08-30T10:00:00.000Z"))).resolves.toEqual({
      active: 2,
      completed: 1,
      failed: 1,
      stale: 1,
      total: 6,
    })
    expect(list).toHaveBeenNthCalledWith(1, { limit: 100 })
    expect(list).toHaveBeenNthCalledWith(2, { cursor: undefined, limit: 100, status: ["pending", "running"] })
    expect(list).toHaveBeenNthCalledWith(3, { cursor: "opaque-next-page", limit: 100, status: ["pending", "running"] })
  })

  it("rejects a repeated cursor instead of looping during workload inspection", async () => {
    const invocation = invocationSummary("active", "running", "2026-08-30T10:00:00.000Z")
    const list = vi.fn(async (options = {}) => {
      if (!("status" in options)) return { invocations: [] }
      return { cursor: "same-cursor", invocations: [invocation] }
    })

    await expect(readAgentInvocationWorkload({ list }, Date.parse("2026-08-30T11:00:00.000Z")))
      .rejects.toThrow("repeated pagination cursor")
    expect(list).toHaveBeenCalledTimes(3)
  })

  it("rejects a repeated cursor before recovering the same page twice", async () => {
    const store = createMemoryAgentInvocationStore()
    const invocation = invocationSummary("interrupted", "running", "2026-08-30T10:00:00.000Z")
    const list = vi.spyOn(store, "list").mockResolvedValue({
      cursor: "same-cursor",
      invocations: [invocation],
    })
    const recover = vi.fn(() => true)

    await expect(failInterruptedAgentInvocations(store, {
      before: Date.parse("2026-08-30T11:00:00.000Z"),
      recover,
    })).rejects.toThrow("repeated pagination cursor")
    expect(list).toHaveBeenCalledTimes(2)
    expect(recover).toHaveBeenCalledOnce()
  })
})

function invocationSummary(id: string, status: "cancelled" | "completed" | "failed" | "pending" | "running", createdAt: string) {
  return { createdAt, cursor: id, id, status, traceId: id, updatedAt: createdAt }
}
