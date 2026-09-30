import { afterEach, describe, expect, it, vi } from "vitest"
import { connectDevframe } from "devframe/client"

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  connectDevframe: vi.fn(),
}));

vi.mock("devframe/client", () => ({
  connectDevframe: mocks.connectDevframe,
}));

import {
  appendUniqueConsoleKeys,
  ConsoleRequestError,
  isRetryableConsoleRequestError,
  loadConsoleKVPages,
  requestConsole,
} from "../src/console/runtime/client/request.ts"
import { consoleScheduleRunDescription, runConsoleScheduleDefinition } from "../src/console/runtime/client/schedule-run.ts"
import { createConsoleSectionLoader, loadConsoleNavigation } from "../src/console/runtime/client/sections.ts"
import { consoleRpcHeader, consoleRpcMethods } from "../src/console/runtime/rpc.ts"

afterEach(() => {
  mocks.call.mockReset()
  mocks.connectDevframe.mockClear()
  vi.unstubAllGlobals()
})

mocks.connectDevframe.mockImplementation(async () => ({ call: mocks.call, ensureTrusted: async () => true }));

describe("Console requests", () => {
  it.each(["GET", "POST"])("marks SSE %s requests while preserving their headers, body, and cancellation", async (method) => {
    mocks.call.mockResolvedValue({ ok: true, value: {} })
    await requestConsole(`/sse-${method}/api/_vitehub/console/sections`)
    const transportFetch = vi.mocked(connectDevframe).mock.calls[0]![0]!.sseOptions!.fetch!
    const response = new Response("ok")
    const fetchMock = vi.fn(async (request: Request) => {
      expect(request.url).toBe("http://vitehub.local/_vitehub/rpc/__sse")
      expect(request.method).toBe(method)
      expect(request.headers.get(consoleRpcHeader)).toBe("1")
      expect(request.headers.get("accept")).toBe("text/event-stream")
      expect(request.headers.get("x-birpc-session")).toBe("session-id")
      expect(request.headers.get("content-type")).toBe("text/plain; charset=utf-8")
      expect(await request.text()).toBe(method === "POST" ? "rpc-message" : "")
      return response
    })
    vi.stubGlobal("fetch", fetchMock)
    const abort = new AbortController()
    await expect(transportFetch("http://vitehub.local/_vitehub/rpc/__sse", {
      body: method === "POST" ? "rpc-message" : undefined,
      headers: {
        accept: "text/event-stream",
        "content-type": "text/plain; charset=utf-8",
        "x-birpc-session": "session-id",
      },
      method,
      signal: abort.signal,
    })).resolves.toBe(response)
    expect(fetchMock).toHaveBeenCalledOnce()
    abort.abort()
    expect(fetchMock.mock.calls[0]![0].signal.aborted).toBe(true)
  })

  it("routes Workspace file requests through RPC with the invocation id", async () => {
    mocks.call.mockResolvedValue({ ok: true, value: { content: "hello" } })
    await expect(requestConsole("/workspace/api/_vitehub/console/invocations/run%20one/workspace?path=AGENTS.md"))
      .resolves.toEqual({ content: "hello" })
    expect(mocks.call).toHaveBeenCalledWith(consoleRpcMethods.invocationWorkspace, {
      id: "run one", method: "GET", query: { path: "AGENTS.md" },
    })
  })

  it("reconnects when the cached Devframe client has disconnected", async () => {
    const disconnectedClient = { call: vi.fn(), ensureTrusted: vi.fn(), status: "disconnected" }
    const connectedClient = {
      call: vi.fn().mockResolvedValue({ ok: true, value: { sections: ["agents"] } }),
      ensureTrusted: vi.fn(),
      status: "connected",
    }
    mocks.connectDevframe
      .mockResolvedValueOnce(disconnectedClient)
      .mockResolvedValueOnce(connectedClient)

    await expect(requestConsole("/reconnect-test/api/_vitehub/console/sections"))
      .resolves.toEqual({ sections: ["agents"] })
    expect(mocks.connectDevframe).toHaveBeenCalledTimes(2)
    expect(disconnectedClient.call).not.toHaveBeenCalled()
    expect(connectedClient.call).toHaveBeenCalledTimes(1)
  })

  it("does not replay a request that disconnects while the RPC call is in flight", async () => {
    const disconnected = new Error("[devframe] Disconnected from the devframe server")
    const firstClient = {
      call: vi.fn().mockImplementation(async () => {
        firstClient.status = "disconnected"
        throw disconnected
      }),
      ensureTrusted: vi.fn(),
      status: "connected",
    }
    const nextClient = {
      call: vi.fn().mockResolvedValue({ ok: true, value: { found: true } }),
      ensureTrusted: vi.fn(),
      status: "connected",
    }
    mocks.connectDevframe
      .mockResolvedValueOnce(firstClient)
      .mockResolvedValueOnce(nextClient)

    const path = "/in-flight-disconnect-test/api/_vitehub/console/kv"
    await expect(requestConsole(path, { body: { key: "entry" }, method: "POST" }))
      .rejects.toBe(disconnected)
    expect(firstClient.call).toHaveBeenCalledTimes(1)
    expect(nextClient.call).not.toHaveBeenCalled()

    await expect(requestConsole(path, { body: { key: "entry" }, method: "POST" }))
      .resolves.toEqual({ found: true })
    expect(mocks.connectDevframe).toHaveBeenCalledTimes(2)
    expect(nextClient.call).toHaveBeenCalledTimes(1)
  })

  it("deduplicates keys repeated across provider pages", () => {
    expect(appendUniqueConsoleKeys(["first", "repeated"], ["repeated", "last"]))
      .toEqual(["first", "repeated", "last"])
  })

  it("replaces a disconnected client and shares the replacement across concurrent retries", async () => {
    const old = { ensureTrusted: async () => true, call: vi.fn().mockResolvedValue({ ok: true, value: "first" }), close: vi.fn(), status: "connected" }
    const replacement = { ensureTrusted: async () => true, call: vi.fn().mockResolvedValue({ ok: true, value: "recovered" }), status: "connected" }
    mocks.connectDevframe.mockResolvedValueOnce(old).mockResolvedValueOnce(replacement)
    await expect(requestConsole("/reconnect/api/_vitehub/console/sections")).resolves.toBe("first")
    old.status = "disconnected"
    await expect(Promise.all([
      requestConsole("/reconnect/api/_vitehub/console/sections"),
      requestConsole("/reconnect/api/_vitehub/console/sections"),
    ])).resolves.toEqual(["recovered", "recovered"])
    expect(mocks.connectDevframe).toHaveBeenCalledTimes(2)
    expect(old.close).toHaveBeenCalledOnce()
    expect(old.call).toHaveBeenCalledOnce()
  })

  it("does not replay a submitted invocation when its connection drops", async () => {
    const client = { ensureTrusted: async () => true, call: vi.fn().mockRejectedValue(new Error("connection dropped")), status: "connected" }
    mocks.connectDevframe.mockResolvedValueOnce(client)
    await expect(requestConsole("/no-replay/api/_vitehub/console/agents/support/invocations", {
      method: "POST", body: { prompt: "Run once" },
    })).rejects.toThrow("connection dropped")
    expect(client.call).toHaveBeenCalledOnce()
    expect(mocks.connectDevframe).toHaveBeenCalledOnce()
  })

  it("discards a failed handshake before allowing another request", async () => {
    const failed = { call: vi.fn(), ensureTrusted: vi.fn().mockRejectedValue(new Error("handshake timed out")), close: vi.fn() }
    mocks.connectDevframe.mockResolvedValueOnce(failed)
    await expect(requestConsole("/handshake/api/_vitehub/console/sections")).rejects.toThrow("handshake timed out")
    expect(failed.ensureTrusted).toHaveBeenCalledWith(10_000)
    expect(failed.call).not.toHaveBeenCalled()
    expect(failed.close).toHaveBeenCalledOnce()
    mocks.call.mockResolvedValue({ ok: true, value: "ready" })
    await expect(requestConsole("/handshake/api/_vitehub/console/sections")).resolves.toBe("ready")
    expect(mocks.connectDevframe).toHaveBeenCalledTimes(2)
  })

  it("supports requests without query or signal options", async () => {
    mocks.call.mockResolvedValue({ ok: true, value: { sections: ["kv"] } })

    await expect(requestConsole("/first/api/_vitehub/console/sections"))
      .resolves.toEqual({ sections: ["kv"] })
    expect(mocks.connectDevframe).toHaveBeenCalledWith({
      baseURL: "/first/_vitehub/rpc/",
      otpParam: false,
      simpleAuth: false,
      sseOptions: { fetch: expect.any(Function) },
      transport: "sse",
    })
    expect(mocks.call).toHaveBeenCalledWith(consoleRpcMethods.sections, {
      method: "GET",
      query: {},
    })
  })

  it("preserves URL query values and lets explicit options replace them", async () => {
    mocks.call.mockResolvedValue({ ok: true, value: { invocations: [] } })

    await expect(requestConsole(
      "/api/_vitehub/console/invocations?id=old-1&id=old-2&agent=old&limit=10&status=old",
      { query: { agent: ["selected"], limit: 20, status: [] } },
    )).resolves.toEqual({ invocations: [] })
    expect(mocks.call).toHaveBeenCalledWith(consoleRpcMethods.invocations, {
      method: "GET",
      query: {
        agent: ["selected"],
        id: ["old-1", "old-2"],
        limit: "20",
        status: [],
      },
    })
  })

  it("preserves invocation delta cursors from the URL", async () => {
    mocks.call.mockResolvedValue({ ok: true, value: { observations: [] } })

    await expect(requestConsole(
      "/api/_vitehub/console/invocations/run-1?observationCount=100&observationCursor=cursor-100",
    )).resolves.toEqual({ observations: [] })
    expect(mocks.call).toHaveBeenCalledWith(consoleRpcMethods.invocation, {
      id: "run-1",
      method: "GET",
      query: {
        observationCount: "100",
        observationCursor: "cursor-100",
      },
    })
  })

  it("preserves remote status and retries only transient request failures", async () => {
    mocks.call.mockResolvedValue({ message: "Upstream unavailable.", ok: false, status: 502 })

    await expect(requestConsole("/second/api/_vitehub/console/invocations/selected"))
      .rejects.toMatchObject({
        message: "Upstream unavailable.",
        name: "ConsoleRequestError",
        status: 502,
      })
    expect(mocks.call).toHaveBeenCalledWith(consoleRpcMethods.invocation, {
      id: "selected",
      method: "GET",
      query: {},
    })
    expect(isRetryableConsoleRequestError(new ConsoleRequestError(408))).toBe(true)
    expect(isRetryableConsoleRequestError(new ConsoleRequestError(429))).toBe(true)
    expect(isRetryableConsoleRequestError(new ConsoleRequestError(502))).toBe(true)
    expect(isRetryableConsoleRequestError(new ConsoleRequestError(404))).toBe(false)
    expect(isRetryableConsoleRequestError(new TypeError("network unavailable"))).toBe(true)
  })

  it("sends read-only action bodies through RPC", async () => {
    mocks.call.mockResolvedValue({ ok: true, value: { found: true } })

    await expect(requestConsole("/third/api/_vitehub/console/kv", {
      body: { key: "x".repeat(24_576), store: "default" },
      method: "POST",
    })).resolves.toEqual({ found: true })
    expect(mocks.call).toHaveBeenCalledWith(consoleRpcMethods.kv, {
      body: { key: "x".repeat(24_576), store: "default" },
      method: "POST",
      query: {},
    })
  })

  it("routes Agent invocation writes with the encoded Agent identity", async () => {
    mocks.call.mockResolvedValue({ ok: true, value: { agent: "support/team", id: "invocation" } })

    await expect(requestConsole("/api/_vitehub/console/agents/support%2Fteam/invocations", {
      body: { invokerProfileId: "person", prompt: "Test this Agent" },
      method: "POST",
    })).resolves.toEqual({ agent: "support/team", id: "invocation" })
    expect(mocks.call).toHaveBeenCalledWith(consoleRpcMethods.agentInvocations, {
      agent: "support%2Fteam",
      body: { invokerProfileId: "person", prompt: "Test this Agent" },
      method: "POST",
      query: {},
    })
  })

  it("routes Schedule runs and kebab-case operations through RPC", async () => {
    mocks.call.mockResolvedValue({ ok: true, value: { run: { status: "succeeded" } } })

    await requestConsole("/base/api/_vitehub/console/schedule-run", { body: { name: "sync" }, method: "POST" })
    await requestConsole("/base/api/_vitehub/console/invocation-capabilities")

    expect(mocks.call).toHaveBeenNthCalledWith(1, consoleRpcMethods.scheduleRun, { body: { name: "sync" }, method: "POST", query: {} })
    expect(mocks.call).toHaveBeenNthCalledWith(2, consoleRpcMethods.invocationCapabilities, { method: "GET", query: {} })
  })

  it("reports a Schedule run result and a run that did not start", async () => {
    mocks.call.mockResolvedValueOnce({
      ok: true,
      value: {
        run: {
          completedAt: "2026-09-29T10:00:01.250Z",
          error: { message: "mailbox unavailable", name: "TypeError" },
          id: "srun_manual_sync_2026-09-29T10:00:00.000Z",
          scheduleId: "sync",
          startedAt: "2026-09-29T10:00:00.000Z",
          status: "failed",
        },
      },
    })
    mocks.call.mockResolvedValueOnce({ message: "Schedule run is not available.", ok: false, status: 404 })

    const failed = await runConsoleScheduleDefinition("/api/_vitehub/console/schedule-run", "sync")
    const unavailable = await runConsoleScheduleDefinition("/api/_vitehub/console/schedule-run", "nightly")

    expect(failed).toEqual({ durationMs: 1_250, error: "mailbox unavailable", id: "srun_manual_sync_2026-09-29T10:00:00.000Z", status: "failed" })
    expect(consoleScheduleRunDescription(failed)).toBe("mailbox unavailable · 1.3s · srun_manual_sync_2026-09-29T10:00:00.000Z")
    expect(unavailable).toEqual({ error: "Schedule run is not available.", status: "unavailable" })
    expect(consoleScheduleRunDescription({ durationMs: 42, status: "succeeded" })).toBe("42ms")
  })

  it("loads every KV page using the configured base and stops repeated cursors", async () => {
    mocks.call
      .mockResolvedValueOnce({ ok: true, value: { cursor: "next", keys: ["first"] } })
      .mockResolvedValueOnce({ ok: true, value: { cursor: "next", keys: ["second"] } })

    await expect(loadConsoleKVPages("/host/api/_vitehub/console/kv", "cache", new AbortController().signal))
      .resolves.toEqual({
        pages: [
          { cursor: "next", keys: ["first"] },
          { cursor: "next", keys: ["second"] },
        ],
        truncated: true,
      })
    expect(mocks.call).toHaveBeenNthCalledWith(
      1,
      consoleRpcMethods.kv,
      expect.objectContaining({ query: { store: "cache" } }),
    )
    expect(mocks.call).toHaveBeenNthCalledWith(
      2,
      consoleRpcMethods.kv,
      expect.objectContaining({ query: { cursor: "next", store: "cache" } }),
    )
  })

  it("continues through empty KV pages within a bounded search budget", async () => {
    mocks.call
      .mockResolvedValueOnce({ ok: true, value: { cursor: "next", keys: [] } })
      .mockResolvedValueOnce({ ok: true, value: { cursor: "last", keys: ["matching"] } })

    await expect(loadConsoleKVPages(
      "/api/_vitehub/console/kv",
      "cache",
      new AbortController().signal,
      undefined,
      { limit: 50, maxPages: 2, prefix: "match" },
    )).resolves.toEqual({
      pages: [
        { cursor: "next", keys: [] },
        { cursor: "last", keys: ["matching"] },
      ],
      truncated: true,
    })
    expect(mocks.call).toHaveBeenNthCalledWith(
      2,
      consoleRpcMethods.kv,
      expect.objectContaining({
        query: { cursor: "next", limit: "50", prefix: "match", store: "cache" },
      }),
    )
  })

  it("rejects a KV page that reports a provider error", async () => {
    mocks.call
      .mockResolvedValueOnce({ ok: true, value: { cursor: "next", keys: ["first"] } })
      .mockResolvedValueOnce({
        ok: true,
        value: { error: "KV unavailable", errorCode: "provider_failed", keys: [] },
      })

    await expect(loadConsoleKVPages("/api/_vitehub/console/kv", "cache", new AbortController().signal))
      .rejects.toMatchObject({ code: "provider_failed", message: "KV unavailable" })
  })

  it("retries section discovery after a failed request and caches a successful response", async () => {
    mocks.call
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValue({ ok: true, value: { sections: ["kv"] } })
    const loadSections = createConsoleSectionLoader("/sections-test/api/_vitehub/console/sections")

    await expect(loadSections()).resolves.toBeUndefined()
    await expect(loadSections()).resolves.toEqual(["kv"])
    await expect(loadSections()).resolves.toEqual(["kv"])
    expect(mocks.call).toHaveBeenCalledTimes(2)
  })

  it("loads the project name and enabled sections as one navigation response", async () => {
    mocks.call.mockResolvedValue({
      ok: true,
      value: { projectName: " console-host ", sections: ["kv", "unknown"] },
    })

    await expect(
      loadConsoleNavigation("/navigation-test/api/_vitehub/console/sections"),
    ).resolves.toEqual({
      auth: false,
      projectName: "console-host",
      sections: ["kv"],
    })
    expect(mocks.call).toHaveBeenCalledTimes(1)
  })

  it("loads independent auth availability in the navigation response", async () => {
    mocks.call.mockResolvedValue({ ok: true, value: { auth: true, sections: ["kv"] } })

    await expect(
      loadConsoleNavigation("/auth-navigation-test/api/_vitehub/console/sections"),
    ).resolves.toEqual({ auth: true, sections: ["kv"] })
  })

  it("stops waiting for an RPC result when navigation is aborted", async () => {
    mocks.call.mockReturnValue(new Promise(() => undefined))
    const controller = new AbortController()
    const request = requestConsole("/abort-test/api/_vitehub/console/sections", {
      signal: controller.signal,
    })
    controller.abort(new Error("navigation changed"))

    await expect(request).rejects.toThrow("navigation changed")
  })
})
