import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
}));

import {
  appendUniqueConsoleKeys,
  ConsoleRequestError,
  isRetryableConsoleRequestError,
  loadConsoleKVPages,
  requestConsole,
} from "../src/console/runtime/client/request.ts"
import { createConsoleSectionLoader, loadConsoleNavigation } from "../src/console/runtime/client/sections.ts"
import { consoleRpcHeader, consoleRpcMethods } from "../src/console/runtime/rpc.ts"

import type { ConsoleRpcResult } from "../src/console/runtime/rpc.ts"

// Decode each stateless call and answer with the result that mocks.call returns.
const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
  const payload: { input: unknown; method: string } = JSON.parse(String(init?.body))
  const signal = init?.signal ?? undefined
  const result = await new Promise<ConsoleRpcResult>((resolve, reject) => {
    signal?.throwIfAborted()
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
    Promise.resolve(mocks.call(payload.method, payload.input)).then(resolve, reject)
  })
  return Response.json(result, { status: result.ok ? 200 : result.status })
})

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  mocks.call.mockReset()
  fetchMock.mockClear()
  vi.unstubAllGlobals()
})

describe("Console requests", () => {
  it("routes Workspace file requests through RPC with the invocation id", async () => {
    mocks.call.mockResolvedValue({ ok: true, value: { content: "hello" } })
    await expect(requestConsole("/workspace/api/_vitehub/console/invocations/run%20one/workspace?path=AGENTS.md"))
      .resolves.toEqual({ content: "hello" })
    expect(mocks.call).toHaveBeenCalledWith(consoleRpcMethods.invocationWorkspace, {
      id: "run one", method: "GET", query: { path: "AGENTS.md" },
    })
  })

  it("sends one stateless POST to the app-relative call endpoint", async () => {
    mocks.call.mockResolvedValue({ ok: true, value: { sections: ["kv"] } })
    const signal = new AbortController().signal

    await expect(requestConsole("/first/api/_vitehub/console/sections", { signal }))
      .resolves.toEqual({ sections: ["kv"] })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledWith("/first/_vitehub/rpc/__call", {
      body: JSON.stringify({ input: { method: "GET", query: {} }, method: consoleRpcMethods.sections }),
      cache: "no-store",
      credentials: "same-origin",
      headers: { "content-type": "application/json", [consoleRpcHeader]: "1" },
      method: "POST",
      signal,
    })
  })

  it("does not replay a submitted invocation when its connection drops", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("connection dropped"))
    await expect(requestConsole("/no-replay/api/_vitehub/console/agents/support/invocations", {
      method: "POST", body: { prompt: "Run once" },
    })).rejects.toThrow("connection dropped")
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it("keeps the HTTP status of a response that is not a Console result", async () => {
    fetchMock.mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }))
    const unauthorized = requestConsole("/auth/api/_vitehub/console/sections")
    await expect(unauthorized).rejects.toMatchObject({ name: "ConsoleRequestError", status: 401 })
    expect(isRetryableConsoleRequestError(await unauthorized.catch(error => error))).toBe(false)

    fetchMock.mockResolvedValueOnce(new Response("<!doctype html>", { headers: { "content-type": "text/html" } }))
    await expect(requestConsole("/fallback/api/_vitehub/console/sections"))
      .rejects.toMatchObject({ name: "ConsoleRequestError", status: 502 })
  })

  it("deduplicates keys repeated across provider pages", () => {
    expect(appendUniqueConsoleKeys(["first", "repeated"], ["repeated", "last"]))
      .toEqual(["first", "repeated", "last"])
  })

  it("supports requests without query or signal options", async () => {
    mocks.call.mockResolvedValue({ ok: true, value: { sections: ["kv"] } })

    await expect(requestConsole("/first/api/_vitehub/console/sections"))
      .resolves.toEqual({ sections: ["kv"] })
    expect(fetchMock).toHaveBeenCalledWith("/first/_vitehub/rpc/__call", expect.objectContaining({ method: "POST", signal: undefined }))
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
