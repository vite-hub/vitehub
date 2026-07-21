import { describe, expect, it, vi } from "vitest"

import {
  BrowserLiveHandoffUnsupportedError,
  BrowserSessionRefError,
  BrowserSessionStateError,
  createBrowser,
  type BrowserController,
  type BrowserProvider,
  type BrowserSessionRef,
} from "../src/index.ts"

interface TestConnection {
  secretEndpoint: string
  sentinel: { value: string }
}

function fixture(options: { controllerHandoff?: boolean, controllerPreserves?: boolean, providerHandoff?: boolean } = {}) {
  const close = vi.fn()
  const release = vi.fn()
  const connection: TestConnection = {
    secretEndpoint: "wss://secret.invalid/cdp?token=hidden",
    sentinel: { value: "prepared" },
  }
  const provider: BrowserProvider<TestConnection> = {
    features: {
      liveHandoff: options.providerHandoff ?? true,
    },
    isolation: "provider",
    name: "fixture",
    async open() {
      return {
        close,
        connection,
        id: "provider-secret-session-id",
      }
    },
  }
  const controller: BrowserController<TestConnection, TestConnection> = {
    async attach(value) {
      return { client: value, preservesSessionOnRelease: options.controllerPreserves ?? true, release }
    },
    features: { attachExistingSession: options.controllerHandoff ?? true },
    name: "fixture-controller",
  }
  return { close, connection, controller, provider, release }
}

describe("Browser Sessions", () => {
  it("keeps provider termination separate from controller release", async () => {
    const { close, controller, provider, release } = fixture()
    const browser = createBrowser({ provider })
    const session = await browser.open()

    await expect(session.use(controller, client => client.sentinel.value)).resolves.toBe("prepared")
    expect(release).toHaveBeenCalledOnce()
    expect(close).not.toHaveBeenCalled()

    await session.close()
    expect(close).toHaveBeenCalledOnce()
    expect(session.inspect().state).toBe("closed")
  })

  it("transfers one exact live session through an opaque one-time reference", async () => {
    const { close, controller, provider } = fixture()
    const browser = createBrowser({ policy: { handoffTtl: 5_000 }, provider })
    const prepared = await browser.open()

    await prepared.use(controller, (client) => {
      client.sentinel.value = "application-authenticated"
    })
    const ref = await prepared.handoff({ audience: "run-1", mode: "live" })

    expect(ref).toEqual({
      audience: "run-1",
      expiresAt: expect.any(String),
      id: expect.stringMatching(/^browser_ref_/),
    })
    expect(JSON.stringify(ref)).not.toContain("secret")
    expect(JSON.stringify(ref)).not.toContain("provider-secret-session-id")
    await expect(prepared.close()).rejects.toBeInstanceOf(BrowserSessionStateError)

    const claimed = await browser.claim(ref, { audience: "run-1" })
    await expect(claimed.use(controller, client => client.sentinel.value)).resolves.toBe("application-authenticated")
    await expect(browser.claim(ref, { audience: "run-1" })).rejects.toBeInstanceOf(BrowserSessionRefError)

    await claimed.close()
    expect(close).toHaveBeenCalledOnce()
  })

  it("consumes and closes an audience-mismatched handoff", async () => {
    const { close, provider } = fixture()
    const browser = createBrowser({ provider })
    const session = await browser.open()
    const ref = await session.handoff({ audience: "run-1", mode: "live" })

    await expect(browser.claim(ref, { audience: "run-2" })).rejects.toMatchObject({
      code: "BROWSER_SESSION_REF_INVALID",
      details: { reason: "audience" },
    })
    expect(close).toHaveBeenCalledOnce()
  })

  it("rejects unsupported provider and receiving-controller pairs", async () => {
    const providerFixture = fixture({ providerHandoff: false })
    const providerBrowser = createBrowser({ provider: providerFixture.provider })
    const providerSession = await providerBrowser.open()
    await expect(providerSession.handoff({ audience: "run-1", mode: "live" })).rejects.toBeInstanceOf(BrowserLiveHandoffUnsupportedError)
    await providerSession.close()

    const releaseFixture = fixture({ controllerPreserves: false })
    const releaseBrowser = createBrowser({ provider: releaseFixture.provider })
    const releaseSession = await releaseBrowser.open()
    await releaseSession.use(releaseFixture.controller, () => undefined)
    await expect(releaseSession.handoff({ audience: "run-1", mode: "live" })).rejects.toBeInstanceOf(BrowserLiveHandoffUnsupportedError)
    await releaseSession.close()

    const controllerFixture = fixture({ controllerHandoff: false })
    const controllerBrowser = createBrowser({ provider: controllerFixture.provider })
    const prepared = await controllerBrowser.open()
    const ref = await prepared.handoff({ audience: "run-1", mode: "live" })
    const claimed = await controllerBrowser.claim(ref, { audience: "run-1" })
    await expect(claimed.use(controllerFixture.controller, () => undefined)).rejects.toBeInstanceOf(BrowserLiveHandoffUnsupportedError)
    await claimed.close()
  })

  it("prevents overlapping controllers", async () => {
    const { controller, provider } = fixture()
    const browser = createBrowser({ provider })
    const session = await browser.open()
    let finish!: () => void
    const pending = session.use(controller, async () => {
      await new Promise<void>(resolve => { finish = resolve })
    })

    await vi.waitFor(() => expect(session.inspect().state).toBe("controlled"))
    await expect(session.use(controller, () => undefined)).rejects.toBeInstanceOf(BrowserSessionStateError)
    finish()
    await pending
    await session.close()
  })

  it("automatically closes ordinary callback sessions but preserves transferred ownership", async () => {
    const ordinary = fixture()
    const ordinaryBrowser = createBrowser({ provider: ordinary.provider })
    await ordinaryBrowser.withSession(() => "ok")
    expect(ordinary.close).toHaveBeenCalledOnce()

    const transferred = fixture()
    const transferredBrowser = createBrowser({ provider: transferred.provider })
    let ref: BrowserSessionRef | undefined
    await transferredBrowser.withSession(async (session) => {
      ref = await session.handoff({ audience: "run-1", mode: "live" })
    })
    expect(transferred.close).not.toHaveBeenCalled()
    const claimed = await transferredBrowser.claim(ref!, { audience: "run-1" })
    await claimed.close()
  })

  it("emits sanitized lifecycle traces", async () => {
    const { controller, provider } = fixture()
    const trace = vi.fn()
    const browser = createBrowser({ provider, trace })

    const session = await browser.open()
    await session.use(controller, () => undefined)
    const ref = await session.handoff({ audience: "sensitive-user-identifier", mode: "live" })
    const claimed = await browser.claim(ref, { audience: "sensitive-user-identifier" })
    await claimed.close()

    expect(trace.mock.calls.map(([event]) => event.name)).toEqual([
      "browser.session.acquire",
      "browser.controller.attach",
      "browser.controller.detach",
      "browser.session.handoff",
      "browser.session.claim",
      "browser.session.close",
    ])
    const serialized = JSON.stringify(trace.mock.calls)
    expect(serialized).not.toContain("secretEndpoint")
    expect(serialized).not.toContain("provider-secret-session-id")
    expect(serialized).not.toContain("sensitive-user-identifier")
  })
})
