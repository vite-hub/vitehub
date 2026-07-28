import { describe, expect, it, vi } from "vitest"

import { cloudflareBrowserTerminated } from "../src/internal/connections.ts"
import { cloudflarePlaywright } from "../src/internal/cloudflare-playwright.ts"

import type { CloudflareBrowserBindingConnection } from "../src/internal/connections.ts"

describe("cloudflare Playwright controller", () => {
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
    const driver = { connect: vi.fn(async () => browser) }
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
