import { afterEach, describe, expect, it, vi } from "vitest"

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
import { createConsoleSectionLoader, loadConsoleNavigation } from "../src/console/runtime/client/sections.ts"

afterEach(() => {
  mocks.call.mockReset()
  mocks.connectDevframe.mockClear()
})

mocks.connectDevframe.mockImplementation(async () => ({ call: mocks.call }));

describe("Console requests", () => {
  it("deduplicates keys repeated across provider pages", () => {
    expect(appendUniqueConsoleKeys(["first", "repeated"], ["repeated", "last"]))
      .toEqual(["first", "repeated", "last"])
  })

  it("supports requests without query or signal options", async () => {
    mocks.call.mockResolvedValue({ ok: true, value: { sections: ["kv"] } })

    await expect(requestConsole("/first/api/_vitehub/console/sections"))
      .resolves.toEqual({ sections: ["kv"] })
    expect(mocks.connectDevframe).toHaveBeenCalledWith({
      baseURL: "/first/_vitehub/rpc/",
      otpParam: false,
      simpleAuth: false,
      transport: "sse",
    })
    expect(mocks.call).toHaveBeenCalledWith("vitehub:console:request", {
      method: "GET",
      path: "/first/api/_vitehub/console/sections",
      query: {},
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
    expect(mocks.call).toHaveBeenCalledWith("vitehub:console:request", {
      body: { key: "x".repeat(24_576), store: "default" },
      method: "POST",
      path: "/third/api/_vitehub/console/kv",
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
      "vitehub:console:request",
      expect.objectContaining({ query: { store: "cache" } }),
    )
    expect(mocks.call).toHaveBeenNthCalledWith(
      2,
      "vitehub:console:request",
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
      "vitehub:console:request",
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
      loadConsoleNavigation("/navigation-test/api/_vitehub/console/navigation-test"),
    ).resolves.toEqual({
      projectName: "console-host",
      sections: ["kv"],
    })
    expect(mocks.call).toHaveBeenCalledTimes(1)
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
