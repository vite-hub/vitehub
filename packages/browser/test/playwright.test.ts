import { setImmediate } from "node:timers/promises"

import { describe, expect, it, vi } from "vitest"

import { playwright } from "../src/controllers/playwright.ts"
import { createBrowser } from "../src/index.ts"

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
  it("shares in-flight Playwright cleanup between direct lease releases", async () => {
    const { browser } = fakeBrowser()
    let completeClose!: () => void
    browser.close.mockImplementation(() => new Promise<void>(resolve => { completeClose = resolve }))
    const attached = await playwright({ chromium: { connectOverCDP: vi.fn(async () => browser) } as never }).attach({
      endpoint: "ws://127.0.0.1:9222/devtools/browser/id",
      kind: "cdp",
    }, {
      provider: { features: { liveHandoff: true }, isolation: "trusted-host", name: "local" },
      sessionId: "safe-id",
    })
    const complete = vi.fn()
    const first = Promise.resolve(attached.release()).then(complete)
    const second = Promise.resolve(attached.release()).then(complete)
    await setImmediate()
    expect(browser.close).toHaveBeenCalledOnce()
    expect(complete).not.toHaveBeenCalled()

    completeClose()
    await Promise.all([first, second])
    await attached.release()
    expect(browser.close).toHaveBeenCalledOnce()
    expect(complete).toHaveBeenCalledTimes(2)
  })

  it("retains public session ownership until Playwright cleanup succeeds after a retry", async () => {
    const { browser } = fakeBrowser()
    const failure = new Error("Playwright disconnect failed")
    let completeClose!: () => void
    browser.close.mockRejectedValueOnce(failure).mockImplementationOnce(() => new Promise<void>(resolve => { completeClose = resolve }))
    const providerClose = vi.fn()
    const controller = playwright({ chromium: { connectOverCDP: vi.fn(async () => browser) } as never })
    const session = await createBrowser({
      provider: {
        features: { liveHandoff: true },
        isolation: "trusted-host",
        name: "local",
        open: () => ({
          close: providerClose,
          connection: { endpoint: "ws://127.0.0.1:9222/devtools/browser/id", kind: "cdp" as const },
          id: "provider-session",
        }),
      },
    }).open()
    const control = await session.attach(controller)

    await expect(control.release()).rejects.toBe(failure)
    expect(session.inspect().state).toBe("controlled")
    await expect(session.attach(controller)).rejects.toMatchObject({ code: "BROWSER_SESSION_STATE" })
    const first = control.release()
    const second = control.release()
    await vi.waitFor(() => expect(browser.close).toHaveBeenCalledTimes(2))
    expect(session.inspect().state).toBe("controlled")

    completeClose()
    await Promise.all([first, second])
    await control.release()
    expect(browser.close).toHaveBeenCalledTimes(2)
    expect(session.inspect().state).toBe("released")
    expect(providerClose).not.toHaveBeenCalled()
    await session.close()
  })

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
