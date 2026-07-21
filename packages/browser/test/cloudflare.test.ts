import { describe, expect, it, vi } from "vitest"

import { cloudflareBrowser } from "../src/providers/cloudflare.ts"

describe("cloudflareBrowser", () => {
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
    const provider = cloudflareBrowser({ binding, driver })

    const session = await provider.open()
    expect(session.connection).toEqual({ binding, kind: "cloudflare-binding", sessionId: "cf-session" })
    expect(driver.acquire).toHaveBeenCalledWith(binding)
    expect(driver.connect).not.toHaveBeenCalled()

    await session.close()
    expect(driver.connect).toHaveBeenCalledWith(binding, "cf-session")
    expect(send).toHaveBeenCalledWith("Browser.close")
    expect(detach).toHaveBeenCalledOnce()
    expect(browserClose).toHaveBeenCalledOnce()
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
      resolveBinding: async name => name === "CUSTOM_BROWSER" ? binding : undefined,
    })

    const session = await provider.open()
    expect(driver.acquire).toHaveBeenCalledWith(binding)
    await session.close()
  })
})
