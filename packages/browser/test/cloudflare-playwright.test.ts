import { describe, expect, it, vi } from "vitest"

import { cloudflareBrowserTerminated } from "../src/internal/connections.ts"
import { cloudflarePlaywright } from "../src/internal/cloudflare-playwright.ts"

import type { CloudflareBrowserBindingConnection } from "../src/internal/connections.ts"

describe("cloudflare Playwright controller", () => {
  it("launches a sessionless Kitesurf browser", async () => {
    const detach = vi.fn(async () => {})
    const send = vi.fn(async () => {})
    const context = {
      newCDPSession: vi.fn(async () => ({
        detach: vi.fn(async () => {}),
        send: vi.fn(async () => ({ targetInfo: { targetId: "target" } })),
      })),
      pages: vi.fn(() => [{}]),
    }
    const browser = {
      close: vi.fn(async () => {}),
      contexts: vi.fn(() => [context]),
      newBrowserCDPSession: vi.fn(async () => ({ detach, send })),
      newContext: vi.fn(),
    }
    const binding = { fetch: vi.fn() }
    const driver = {
      connect: vi.fn(),
      launch: vi.fn(async () => browser),
    }

    const attached = await cloudflarePlaywright(driver as never).attach({
      binding,
      engine: "kitesurf",
      kind: "cloudflare-binding",
    }, {
      provider: { features: { liveHandoff: false }, isolation: "provider", name: "cloudflare" },
      sessionId: "public-session",
    })
    await attached.release()

    expect(driver.launch).toHaveBeenCalledWith(binding, { browser: "kitesurf" })
    expect(driver.connect).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith("Browser.close")
  })

  it("terminates Browser Run over the attached connection", async () => {
    const detach = vi.fn(async () => {})
    const send = vi.fn(async () => {})
    const page = {}
    const context = {
      newCDPSession: vi.fn(async () => ({
        detach: vi.fn(async () => {}),
        send: vi.fn(async () => ({ targetInfo: { targetId: "target" } })),
      })),
      pages: vi.fn(() => [page]),
    }
    const browser = {
      close: vi.fn(async () => {}),
      contexts: vi.fn(() => [context]),
      newBrowserCDPSession: vi.fn(async () => ({ detach, send })),
      newContext: vi.fn(),
    }
    const driver = { connect: vi.fn(async () => browser), launch: vi.fn() }
    const connection: CloudflareBrowserBindingConnection = {
      binding: { fetch: vi.fn() },
      kind: "cloudflare-binding" as const,
      sessionId: "cf-session",
    }

    const attached = await cloudflarePlaywright(driver as never).attach(connection, {
      provider: {
        features: { liveHandoff: true },
        isolation: "provider",
        name: "cloudflare",
      },
      sessionId: "public-session",
    })
    await attached.release()

    expect(send).toHaveBeenCalledWith("Browser.close")
    expect(detach).not.toHaveBeenCalled()
    expect(browser.close).not.toHaveBeenCalled()
    expect(connection[cloudflareBrowserTerminated]).toBe(true)
  })
})
