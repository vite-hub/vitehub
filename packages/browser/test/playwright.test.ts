import { describe, expect, it, vi } from "vitest"

import { playwright } from "../src/controllers/playwright.ts"

function fakeContext(target: string, page = { goto: vi.fn() }) {
  const detach = vi.fn(async () => {})
  const context = {
    newCDPSession: vi.fn(async () => ({
      detach,
      send: vi.fn(async () => ({ targetInfo: { targetId: target } })),
    })),
    newPage: vi.fn(async () => page),
    pages: vi.fn(() => [page]),
  }
  return { context, detach, page }
}

function fakeBrowser(target = "target-1") {
  const { context, detach, page } = fakeContext(target)
  const browser = {
    close: vi.fn(async () => {}),
    contexts: vi.fn(() => [context]),
    newContext: vi.fn(async () => context),
  }
  return { browser, context, detach, page }
}

describe("playwright controller", () => {
  it("launches Kitesurf through Cloudflare Playwright", async () => {
    const { browser } = fakeBrowser()
    const binding = { fetch: vi.fn() }
    const connect = vi.fn()
    const launch = vi.fn(async () => browser)
    const attached = await playwright({ cloudflare: { connect, launch } as never }).attach({
      binding,
      engine: "kitesurf",
      kind: "cloudflare-binding",
    }, {
      provider: { features: { liveHandoff: false }, isolation: "provider", name: "cloudflare" },
      sessionId: "safe-id",
    })

    expect(launch).toHaveBeenCalledWith(binding, { browser: "kitesurf" })
    expect(connect).not.toHaveBeenCalled()
    await attached.release()
  })

  it("marks standard CDP release as destructive to the provider session", async () => {
    const { browser, context, page } = fakeBrowser()
    const connectOverCDP = vi.fn(async () => browser)
    const controller = playwright({ chromium: { connectOverCDP } as never })
    const connection = {
      endpoint: "ws://127.0.0.1:9222/devtools/browser/id",
      headers: { Authorization: "Bearer hidden" },
      kind: "cdp" as const,
    }

    const attached = await controller.attach(connection, {
      provider: {
        features: { liveHandoff: true },
        isolation: "trusted-host",
        name: "local",
      },
      sessionId: "safe-id",
    })

    expect(connectOverCDP).toHaveBeenCalledWith(
      "ws://127.0.0.1:9222/devtools/browser/id",
      { headers: { Authorization: "Bearer hidden" } },
    )
    expect(attached.client).toEqual({ browser, context, page })
    expect(attached.preservesSessionOnRelease).toBe(false)
    expect(connection).toHaveProperty("preferredTargetId", "target-1")
    await attached.release()
    expect(browser.close).toHaveBeenCalledOnce()
  })

  it("locates the exact prepared Cloudflare target when contexts reorder", async () => {
    const original = fakeContext("prepared-target")
    const replacement = fakeContext("new-blank-target")
    const browser = {
      close: vi.fn(async () => {}),
      contexts: vi.fn(() => [replacement.context, original.context]),
      newContext: vi.fn(),
    }
    const connect = vi.fn(async () => browser)
    const controller = playwright({ cloudflare: { connect } as never })
    const binding = { fetch: vi.fn() }
    const connection = {
      binding,
      kind: "cloudflare-binding" as const,
      preferredTargetId: "prepared-target",
      sessionId: "session",
    }

    const attached = await controller.attach(connection, {
      provider: {
        features: { liveHandoff: true },
        isolation: "provider",
        name: "cloudflare",
      },
      sessionId: "safe-id",
    })

    expect(connect).toHaveBeenCalledWith(binding, "session")
    expect(attached.client.context).toBe(original.context)
    expect(attached.client.page).toBe(original.page)
    expect(attached.preservesSessionOnRelease).toBe(false)
    await attached.release()
    expect(browser.close).toHaveBeenCalledOnce()
  })

  it("closes the connection when controller setup fails", async () => {
    const { browser, context } = fakeBrowser()
    context.newCDPSession.mockRejectedValueOnce(new Error("target lookup failed"))
    const controller = playwright({ chromium: { connectOverCDP: vi.fn(async () => browser) } as never })

    await expect(controller.attach({
      endpoint: "ws://127.0.0.1:9222/devtools/browser/id",
      kind: "cdp",
    }, {
      provider: { features: { liveHandoff: true }, isolation: "trusted-host", name: "local" },
      sessionId: "safe-id",
    })).rejects.toThrow("target lookup failed")

    expect(browser.close).toHaveBeenCalledOnce()
  })
})
