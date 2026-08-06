import { describe, expect, it, vi } from "vitest"

import { cloudflareBrowserTerminated } from "../src/internal/connections.ts"
import { cloudflareBrowser } from "../src/providers/cloudflare.ts"

describe("cloudflareBrowser", () => {
  it("opens Kitesurf without acquiring a persistent Browser Run session", async () => {
    const binding = { fetch: vi.fn() }
    const driver = {
      acquire: vi.fn(),
      connect: vi.fn(),
    }
    const provider = cloudflareBrowser({ binding, driver })

    expect(provider.features.liveHandoff).toBe(false)
    const session = await provider.open()

    expect(session.connection).toMatchObject({ binding, engine: "kitesurf", kind: "cloudflare-binding" })
    expect(session.connection.sessionId).toBeUndefined()
    expect(session.features?.liveHandoff).toBe(false)
    expect(driver.acquire).not.toHaveBeenCalled()
    await session.close()
  })

  it("acquires without attaching and terminates independently", async () => {
    const send = vi.fn()
    const detach = vi.fn()
    const browserClose = vi.fn()
    const binding = { fetch: vi.fn() }
    const driver = {
      acquire: vi.fn(async () => ({ sessionId: "cf-session" })),
      connect: vi.fn(async () => ({
        close: browserClose,
        newBrowserCDPSession: async () => ({ detach, send }),
      })),
    }
    const provider = cloudflareBrowser({ binding, driver, engine: "chromium" })

    const session = await provider.open()
    expect(session.connection).toEqual({ binding, kind: "cloudflare-binding", sessionId: "cf-session" })
    expect(driver.acquire).toHaveBeenCalledWith(binding)
    expect(driver.connect).not.toHaveBeenCalled()

    await session.close()
    expect(driver.connect).toHaveBeenCalledWith(binding, "cf-session")
    expect(send).toHaveBeenCalledWith("Browser.close")
    expect(detach).not.toHaveBeenCalled()
    expect(browserClose).not.toHaveBeenCalled()
  })

  it("resolves a named request-scoped binding", async () => {
    const binding = { fetch: vi.fn() }
    const driver = {
      acquire: vi.fn(async () => ({ sessionId: "cf-session" })),
      connect: vi.fn(async () => ({
        close: vi.fn(),
        newBrowserCDPSession: async () => ({ detach: vi.fn(), send: vi.fn() }),
      })),
    }
    const provider = cloudflareBrowser({
      binding: "CUSTOM_BROWSER",
      driver,
      engine: "chromium",
      resolveBinding: async name => name === "CUSTOM_BROWSER" ? binding : undefined,
    })

    const session = await provider.open()
    expect(driver.acquire).toHaveBeenCalledWith(binding)
    await session.close()
  })

  it("does not reconnect after the attached controller terminates the session", async () => {
    const binding = { fetch: vi.fn() }
    const driver = {
      acquire: vi.fn(async () => ({ sessionId: "cf-session" })),
      connect: vi.fn(),
    }
    const session = await cloudflareBrowser({ binding, driver, engine: "chromium" }).open()
    session.connection[cloudflareBrowserTerminated] = true

    await session.close()

    expect(driver.connect).not.toHaveBeenCalled()
  })

  it("passes the requested idle timeout to Browser Run", async () => {
    const binding = { fetch: vi.fn() }
    const driver = {
      acquire: vi.fn(async () => ({ sessionId: "cf-session" })),
      connect: vi.fn(),
    }
    const provider = cloudflareBrowser({ binding, driver, engine: "chromium" })

    await provider.open({ idleTimeoutMs: 120_000 })

    expect(driver.acquire).toHaveBeenCalledWith(binding, { keep_alive: 120_000 })
  })

  it("retries provider termination after a transient connection failure", async () => {
    const send = vi.fn()
    const driver = {
      acquire: vi.fn(async () => ({ sessionId: "cf-session" })),
      connect: vi.fn()
        .mockRejectedValueOnce(new Error("temporary connection failure"))
        .mockResolvedValue({
          close: vi.fn(),
          newBrowserCDPSession: async () => ({ detach: vi.fn(), send }),
        }),
    }
    const session = await cloudflareBrowser({ binding: { fetch: vi.fn() }, driver, engine: "chromium" }).open()

    await expect(session.close()).rejects.toThrow("terminate a Browser Run session")
    await session.close()

    expect(driver.connect).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenCalledWith("Browser.close")
  })

  it("retries provider termination after Browser.close is rejected", async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new Error("command not delivered"))
      .mockResolvedValue(undefined)
    const driver = {
      acquire: vi.fn(async () => ({ sessionId: "cf-session" })),
      connect: vi.fn(async () => ({
        close: vi.fn(),
        newBrowserCDPSession: async () => ({ detach: vi.fn(), send }),
      })),
    }
    const session = await cloudflareBrowser({ binding: { fetch: vi.fn() }, driver, engine: "chromium" }).open()

    await expect(session.close()).rejects.toThrow("terminate a Browser Run session")
    await session.close()

    expect(driver.connect).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenCalledTimes(2)
  })
})
