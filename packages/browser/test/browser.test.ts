import { runInNewContext } from "node:vm"
import { describe, expect, it, vi } from "vitest"
import { type TraceEvent, ViteHubError } from "@vite-hub/runtime"

import {
  createBrowser,
  type BrowserController,
  type BrowserProvider,
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
  it("normalizes provider expiry dates from another realm", async () => {
    const expiresAt = runInNewContext("new Date('2030-01-02T03:04:05.000Z')") as Date
    const provider: BrowserProvider = {
      features: { liveHandoff: false },
      isolation: "provider",
      name: "fixture",
      open: async () => ({
        close: async () => {},
        connection: undefined,
        expiresAt,
        id: "session",
      }),
    }
    const session = await createBrowser({ provider }).open()

    expect(session.inspect().expiresAt).toBe("2030-01-02T03:04:05.000Z")
    await session.close()
  })

  it("keeps provider termination separate from controller release", async () => {
    const { close, controller, provider, release } = fixture()
    const browser = createBrowser({ provider })
    const session = await browser.open()

    const control = await session.attach(controller)
    expect(control.client.sentinel.value).toBe("prepared")
    await control.release()
    expect(release).toHaveBeenCalledOnce()
    expect(close).not.toHaveBeenCalled()

    await session.close()
    expect(close).toHaveBeenCalledOnce()
    expect(session.inspect().state).toBe("closed")
  })

  it("shares concurrent session closure", async () => {
    const { close, controller, provider } = fixture()
    let resolveClose!: () => void
    close.mockImplementation(async () => await new Promise<void>(resolve => {
      resolveClose = resolve
    }))
    const session = await createBrowser({ provider }).open()

    const first = session.close()
    const second = session.close()
    expect(close).toHaveBeenCalledOnce()
    await expect(session.attach(controller)).rejects.toMatchObject({ code: "BROWSER_SESSION_STATE" })
    resolveClose()
    await Promise.all([first, second])
    expect(session.inspect().state).toBe("closed")
  })

  it("waits for controller cleanup in every concurrent release call", async () => {
    const { controller, provider, release } = fixture()
    let resolveRelease!: () => void
    release.mockImplementation(async () => await new Promise<void>(resolve => {
      resolveRelease = resolve
    }))
    const session = await createBrowser({ provider }).open()
    const control = await session.attach(controller)
    const completed = vi.fn()

    const first = control.release()
    const second = control.release().then(completed)
    await Promise.resolve()
    expect(release).toHaveBeenCalledOnce()
    expect(completed).not.toHaveBeenCalled()
    expect(session.inspect().state).toBe("controlled")

    resolveRelease()
    await Promise.all([first, second])
    expect(completed).toHaveBeenCalledOnce()
    expect(session.inspect().state).toBe("released")
    await session.close()
  })

  it("retains controller ownership and allows retry after failed release", async () => {
    const { controller, provider, release } = fixture()
    const failure = new Error("temporary detach failure")
    release.mockRejectedValueOnce(failure)
    const session = await createBrowser({ provider }).open()
    const control = await session.attach(controller)

    await expect(control.release()).rejects.toBe(failure)
    expect(session.inspect().state).toBe("controlled")
    await expect(session.attach(controller)).rejects.toMatchObject({ code: "BROWSER_SESSION_STATE" })
    await expect(session.handoff({ audience: "run-1", mode: "live" })).rejects.toMatchObject({
      code: "BROWSER_SESSION_STATE",
    })

    await control.release()
    await control.release()
    expect(release).toHaveBeenCalledTimes(2)
    expect(session.inspect().state).toBe("released")
    await session.close()
  })

  it("allows provider cleanup after controller release fails", async () => {
    const { close, controller, provider, release } = fixture()
    release.mockRejectedValueOnce(new Error("detach failed"))
    const session = await createBrowser({ provider }).open()
    const control = await session.attach(controller)

    await expect(control.release()).rejects.toThrow("detach failed")
    await session.close()

    expect(close).toHaveBeenCalledOnce()
    expect(session.inspect().state).toBe("closed")
  })

  it("keeps failed session cleanup retryable", async () => {
    const { close, controller, provider } = fixture()
    close.mockRejectedValueOnce(new Error("temporary close failure"))
    const session = await createBrowser({ provider }).open()

    await expect(session.close()).rejects.toThrow("temporary close failure")
    expect(session.inspect().state).toBe("released")
    await expect(session.attach(controller)).rejects.toMatchObject({ code: "BROWSER_SESSION_STATE" })

    await session.close()
    expect(close).toHaveBeenCalledTimes(2)
    expect(session.inspect().state).toBe("closed")
  })

  it("releases a late attachment after failed provider cleanup", async () => {
    const { close, connection, controller, provider, release } = fixture()
    let resolveAttachment!: (value: { client: TestConnection, release: () => void }) => void
    close.mockRejectedValueOnce(new Error("temporary close failure"))
    controller.attach = vi.fn(async () => await new Promise<{ client: TestConnection, release: () => void }>(resolve => {
      resolveAttachment = resolve
    }))
    const session = await createBrowser({ provider }).open()

    const attachment = session.attach(controller)
    const result = expect(attachment).rejects.toMatchObject({ code: "BROWSER_SESSION_STATE" })
    await expect(session.close()).rejects.toThrow("temporary close failure")
    resolveAttachment({ client: connection, release })

    await result
    expect(release).toHaveBeenCalledOnce()
    await session.close()
    expect(close).toHaveBeenCalledTimes(2)
  })

  it("retries failed cleanup for an expired handoff", async () => {
    vi.useFakeTimers()
    try {
      const { close, provider } = fixture()
      close.mockRejectedValueOnce(new Error("temporary close failure"))
      const browser = createBrowser({ policy: { handoffTtl: 10 }, provider })
      const session = await browser.open()
      const ref = await session.handoff({ audience: "run-1", mode: "live" })

      await vi.advanceTimersByTimeAsync(10)
      expect(close).toHaveBeenCalledOnce()

      await vi.advanceTimersByTimeAsync(1_000)
      expect(close).toHaveBeenCalledTimes(2)
      await expect(browser.claim(ref, { audience: "run-1" })).rejects.toMatchObject({
        code: "BROWSER_SESSION_REF_INVALID",
        details: { reason: "unknown" },
      })
    }
    finally {
      vi.useRealTimers()
    }
  })

  it.each(["policy", "handoff"] as const)("rejects handoff timer overflow from %s without transferring ownership", async (source) => {
    const { close, provider } = fixture()
    const ttl = 2_147_483_648
    const browser = createBrowser({
      policy: source === "policy" ? { handoffTtl: ttl } : undefined,
      provider,
    })
    const session = await browser.open()

    await expect(session.handoff({
      audience: "run-1",
      mode: "live",
      ...(source === "handoff" ? { ttl } : {}),
    })).rejects.toThrow("no greater than 2147483647")

    expect(session.inspect().state).toBe("released")
    expect(close).not.toHaveBeenCalled()
    await session.close()
  })

  it("accepts the maximum supported handoff timer without expiring early", async () => {
    vi.useFakeTimers()
    try {
      const { close, provider } = fixture()
      const browser = createBrowser({ provider })
      const session = await browser.open()
      const ref = await session.handoff({ audience: "run-1", mode: "live", ttl: 2_147_483_647 })

      await vi.advanceTimersByTimeAsync(1)
      expect(close).not.toHaveBeenCalled()
      const claimed = await browser.claim(ref, { audience: "run-1" })
      await claimed.close()
      expect(close).toHaveBeenCalledOnce()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("transfers one exact live session through an opaque one-time reference", async () => {
    const { close, controller, provider } = fixture()
    const browser = createBrowser({ policy: { handoffTtl: 5_000 }, provider })
    const prepared = await browser.open()

    const preparedControl = await prepared.attach(controller)
    preparedControl.client.sentinel.value = "application-authenticated"
    await preparedControl.release()
    const ref = await prepared.handoff({ audience: "run-1", mode: "live" })

    expect(ref).toEqual({
      audience: "run-1",
      expiresAt: expect.any(String),
      id: expect.stringMatching(/^browser_ref_/),
    })
    expect(JSON.stringify(ref)).not.toContain("secret")
    expect(JSON.stringify(ref)).not.toContain("provider-secret-session-id")
    await expect(prepared.close()).rejects.toBeInstanceOf(ViteHubError)

    const claimed = await browser.claim(ref, { audience: "run-1" })
    const claimedControl = await claimed.attach(controller)
    expect(claimedControl.client.sentinel.value).toBe("application-authenticated")
    await claimedControl.release()
    await expect(browser.claim(ref, { audience: "run-1" })).rejects.toMatchObject({ code: "BROWSER_SESSION_REF_INVALID" })

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
    await expect(providerSession.handoff({ audience: "run-1", mode: "live" })).rejects.toMatchObject({ code: "BROWSER_LIVE_HANDOFF_UNSUPPORTED" })
    await providerSession.close()

    const releaseFixture = fixture({ controllerPreserves: false })
    const releaseBrowser = createBrowser({ provider: releaseFixture.provider })
    const releaseSession = await releaseBrowser.open()
    const releaseControl = await releaseSession.attach(releaseFixture.controller)
    await releaseControl.release()
    await expect(releaseSession.handoff({ audience: "run-1", mode: "live" })).rejects.toMatchObject({ code: "BROWSER_LIVE_HANDOFF_UNSUPPORTED" })
    await releaseSession.close()

    const controllerFixture = fixture({ controllerHandoff: false })
    const controllerBrowser = createBrowser({ provider: controllerFixture.provider })
    const prepared = await controllerBrowser.open()
    const ref = await prepared.handoff({ audience: "run-1", mode: "live" })
    const claimed = await controllerBrowser.claim(ref, { audience: "run-1" })
    await expect(claimed.attach(controllerFixture.controller)).rejects.toMatchObject({ code: "BROWSER_LIVE_HANDOFF_UNSUPPORTED" })
    await claimed.close()
  })

  it("prevents overlapping controllers", async () => {
    const { controller, provider } = fixture()
    const browser = createBrowser({ provider })
    const session = await browser.open()
    const control = await session.attach(controller)

    expect(session.inspect().state).toBe("controlled")
    await expect(session.attach(controller)).rejects.toMatchObject({ code: "BROWSER_SESSION_STATE" })
    await control.release()
    await session.close()
  })

  it("allows provider cleanup while controller release is stalled", async () => {
    const { close, controller, provider } = fixture()
    controller.attach = vi.fn(async (connection: TestConnection) => ({
      client: connection,
      release: async () => await new Promise<void>(() => {}),
    }))
    const session = await createBrowser({ provider }).open()
    const control = await session.attach(controller)

    void control.release()
    await session.close()

    expect(close).toHaveBeenCalledOnce()
    expect(session.inspect().state).toBe("closed")
  })

  it("closes while controller attachment is pending and releases a late attachment", async () => {
    const { close, connection, controller, provider, release } = fixture()
    let resolveAttachment!: (value: { client: TestConnection, release: () => void }) => void
    let resolveClose!: () => void
    close.mockImplementation(async () => await new Promise<void>(resolve => {
      resolveClose = resolve
    }))
    controller.attach = vi.fn(async () => await new Promise<{ client: TestConnection, release: () => void }>(resolve => {
      resolveAttachment = resolve
    }))
    const session = await createBrowser({ provider }).open()

    const attachment = session.attach(controller)
    const result = expect(attachment).rejects.toMatchObject({ code: "BROWSER_SESSION_STATE" })
    const closing = session.close()
    resolveAttachment({ client: connection, release })

    await result
    expect(release).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
    resolveClose()
    await closing
    expect(session.inspect().state).toBe("closed")
  })

  it("releases a canceled late attachment without detach tracing", async () => {
    const { connection, controller, provider, release } = fixture()
    let resolveAttachment!: (value: { client: TestConnection, release: () => void }) => void
    controller.attach = vi.fn(async () => await new Promise<{ client: TestConnection, release: () => void }>(resolve => {
      resolveAttachment = resolve
    }))
    const trace = vi.fn(async (event: TraceEvent) => {
      if (event.name === "browser.controller.detach") throw new Error("unexpected detach trace")
    })
    const session = await createBrowser({ provider, trace }).open()
    const attachment = session.attach(controller)
    const result = expect(attachment).rejects.toMatchObject({ code: "BROWSER_SESSION_STATE" })
    await session.close()
    resolveAttachment({ client: connection, release })

    await result
    expect(release).toHaveBeenCalledOnce()
    expect(trace.mock.calls.map(([event]) => event.name)).toEqual([
      "browser.session.acquire",
      "browser.session.close",
    ])
  })

  it("bounds stalled release of a late attachment", async () => {
    vi.useFakeTimers()
    try {
      const { connection, controller, provider } = fixture()
      let resolveAttachment!: (value: { client: TestConnection, release: () => Promise<void> }) => void
      controller.attach = vi.fn(async () => await new Promise<{ client: TestConnection, release: () => Promise<void> }>(resolve => {
        resolveAttachment = resolve
      }))
      const session = await createBrowser({ provider }).open()

      const attachment = session.attach(controller)
      const result = expect(attachment).rejects.toMatchObject({ code: "BROWSER_PROVIDER_ERROR" })
      await session.close()
      resolveAttachment({ client: connection, release: async () => await new Promise<void>(() => {}) })
      await vi.advanceTimersByTimeAsync(30_000)

      await result
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("rejects handoff while controller attachment is pending", async () => {
    const { connection, controller, provider, release } = fixture()
    let resolveAttachment!: (value: { client: TestConnection, release: () => void }) => void
    controller.attach = vi.fn(async () => await new Promise<{ client: TestConnection, release: () => void }>(resolve => {
      resolveAttachment = resolve
    }))
    const session = await createBrowser({ provider }).open()

    const attachment = session.attach(controller)
    await expect(session.handoff({ audience: "run-1", mode: "live" })).rejects.toMatchObject({
      code: "BROWSER_SESSION_STATE",
    })
    resolveAttachment({ client: connection, release })
    const control = await attachment
    await control.release()
    await session.close()
  })

  it("keeps session ownership explicit", async () => {
    const { close, provider } = fixture()
    const browser = createBrowser({ provider })
    const session = await browser.open()

    expect(close).not.toHaveBeenCalled()
    await session.close()
    expect(close).toHaveBeenCalledOnce()
  })

  it("emits sanitized lifecycle traces", async () => {
    const { controller, provider } = fixture()
    const trace = vi.fn()
    const browser = createBrowser({ provider, trace })

    const session = await browser.open()
    const control = await session.attach(controller)
    await control.release()
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

  it("closes an acquired session when tracing fails", async () => {
    const { close, provider } = fixture()
    const traceError = new Error("trace unavailable")
    const browser = createBrowser({ provider, trace: vi.fn().mockRejectedValue(traceError) })

    await expect(browser.open()).rejects.toBe(traceError)
    expect(close).toHaveBeenCalledOnce()
  })

  it.each([false, true])("cleans up a throwing client accessor with failed rollback: %s", async (failRelease) => {
    const { close, controller, provider, release } = fixture()
    const clientError = new Error("client unavailable")
    const releaseError = new Error("release failed")
    const trace = vi.fn()
    const brokenController: BrowserController<TestConnection, TestConnection> = {
      ...controller,
      async attach() {
        return {
          get client(): TestConnection { throw clientError },
          release,
        }
      },
    }
    if (failRelease) release.mockRejectedValueOnce(releaseError)
    const session = await createBrowser({ provider, trace }).open()

    if (failRelease) {
      await expect(session.attach(brokenController)).rejects.toMatchObject({ errors: [clientError, releaseError] })
      expect(session.inspect().state).toBe("controlled")
      await expect(session.attach(controller)).rejects.toMatchObject({ code: "BROWSER_SESSION_STATE" })
      await expect(session.handoff({ audience: "run-1", mode: "live" })).rejects.toMatchObject({
        code: "BROWSER_SESSION_STATE",
      })
    }
    else {
      await expect(session.attach(brokenController)).rejects.toBe(clientError)
      expect(session.inspect().state).toBe("released")
    }
    expect(release).toHaveBeenCalledOnce()
    expect(close).not.toHaveBeenCalled()
    expect(trace.mock.calls.map(([event]) => event.name)).toEqual(["browser.session.acquire"])

    await session.close()
    expect(release).toHaveBeenCalledTimes(failRelease ? 2 : 1)
    expect(close).toHaveBeenCalledOnce()
    expect(session.inspect().state).toBe("closed")
    expect(trace.mock.calls.map(([event]) => event.name)).toEqual([
      "browser.session.acquire",
      "browser.session.close",
    ])
  })

  it("retains controller ownership when attachment rollback fails", async () => {
    const { close, controller, provider, release } = fixture()
    const traceError = new Error("attach trace failed")
    const releaseError = new Error("detach failed")
    const trace = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(traceError)
    release.mockRejectedValueOnce(releaseError)
    const session = await createBrowser({ provider, trace }).open()

    await expect(session.attach(controller)).rejects.toMatchObject({ errors: [traceError, releaseError] })
    expect(session.inspect().state).toBe("controlled")
    await expect(session.attach(controller)).rejects.toMatchObject({ code: "BROWSER_SESSION_STATE" })
    await expect(session.handoff({ audience: "run-1", mode: "live" })).rejects.toMatchObject({
      code: "BROWSER_SESSION_STATE",
    })
    expect(trace.mock.calls.map(([event]) => event.name)).not.toContain("browser.controller.detach")

    await session.close()
    expect(close).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledTimes(2)
    expect(session.inspect().state).toBe("closed")
  })

  it("retains failed rollback cleanup until closure can release the controller", async () => {
    const { close, controller, provider, release } = fixture()
    const traceError = new Error("attach trace failed")
    const releaseError = new Error("detach failed")
    const trace = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(traceError)
    release.mockRejectedValue(releaseError)
    const session = await createBrowser({ provider, trace }).open()

    await expect(session.attach(controller)).rejects.toMatchObject({ errors: [traceError, releaseError] })
    await expect(session.close()).rejects.toBe(releaseError)
    expect(close).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledTimes(2)
    expect(session.inspect().state).toBe("controlled")
    expect(trace.mock.calls.map(([event]) => event.name)).not.toContain("browser.controller.detach")
    expect(trace.mock.calls.map(([event]) => event.name)).toEqual([
      "browser.session.acquire",
      "browser.controller.attach",
      "browser.session.close",
    ])

    release.mockResolvedValue(undefined)
    await session.close()
    expect(close).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledTimes(3)
    expect(session.inspect().state).toBe("closed")
    expect(trace.mock.calls.map(([event]) => event.name)).toEqual([
      "browser.session.acquire",
      "browser.controller.attach",
      "browser.session.close",
      "browser.controller.detach",
      "browser.session.close",
    ])
  })

  it("retries failed rollback before provider closure invalidates the controller connection", async () => {
    const { close, controller, provider, release } = fixture()
    const traceError = new Error("attach trace failed")
    const releaseError = new Error("detach failed")
    let providerClosed = false
    close.mockImplementation(async () => { providerClosed = true })
    release.mockRejectedValueOnce(releaseError).mockImplementation(async () => {
      if (providerClosed) throw new Error("controller connection closed")
    })
    const trace = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(traceError)
    const session = await createBrowser({ provider, trace }).open()

    await expect(session.attach(controller)).rejects.toMatchObject({ errors: [traceError, releaseError] })
    await session.close()

    expect(release).toHaveBeenCalledTimes(2)
    expect(close).toHaveBeenCalledOnce()
    expect(session.inspect().state).toBe("closed")
  })

  it("keeps rollback completion retryable when detach tracing fails during closure", async () => {
    const { close, controller, provider, release } = fixture()
    const attachError = new Error("attach trace failed")
    const detachError = new Error("detach trace failed")
    release.mockRejectedValueOnce(new Error("rollback failed"))
    const trace = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(attachError)
      .mockRejectedValueOnce(detachError)
      .mockResolvedValue(undefined)
    const session = await createBrowser({ provider, trace }).open()

    await expect(session.attach(controller)).rejects.toMatchObject({ errors: [attachError, { message: "rollback failed" }] })
    await expect(session.close()).rejects.toBe(detachError)
    expect(close).toHaveBeenCalledOnce()
    expect(session.inspect().state).toBe("closed")

    await expect(session.close()).resolves.toBeUndefined()
    expect(close).toHaveBeenCalledOnce()
    expect(session.inspect().state).toBe("closed")
  })

  it("allows another controller after attachment rollback succeeds even if detach tracing fails", async () => {
    const { controller, provider, release } = fixture()
    const traceError = new Error("attach trace failed")
    const detachError = new Error("detach trace failed")
    const trace = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(traceError)
      .mockRejectedValueOnce(detachError)
    const session = await createBrowser({ provider, trace }).open()

    await expect(session.attach(controller)).rejects.toMatchObject({ errors: [traceError, detachError] })
    expect(session.inspect().state).toBe("released")
    expect(release).toHaveBeenCalledOnce()

    const control = await session.attach(controller)
    await control.release()
    await session.close()
    expect(release).toHaveBeenCalledTimes(2)
  })

  it("waits for pending attachment rollback before provider closure invalidates the connection", async () => {
    const { close, controller, provider, release } = fixture()
    const traceError = new Error("attach trace failed")
    let providerClosed = false
    close.mockImplementation(async () => { providerClosed = true })
    const trace = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(traceError)
    let finishRelease!: () => void
    let releaseStarted!: () => void
    const started = new Promise<void>(resolve => { releaseStarted = resolve })
    release.mockImplementation(async () => await new Promise<void>(resolve => {
      finishRelease = resolve
      releaseStarted()
    }).then(() => {
      if (providerClosed) throw new Error("controller connection closed")
    }))
    const session = await createBrowser({ provider, trace }).open()
    const attaching = session.attach(controller)
    const result = expect(attaching).rejects.toBe(traceError)
    await started

    const closing = session.close()
    await Promise.resolve()
    expect(close).not.toHaveBeenCalled()
    let closed = false
    void closing.then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)
    finishRelease()
    await result
    await expect(closing).resolves.toBeUndefined()
    expect(close).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledOnce()
    expect(session.inspect().state).toBe("closed")
  })

  it("closes the provider after pending rollback releases while detach tracing stalls", async () => {
    const { close, controller, provider, release } = fixture()
    const traceError = new Error("attach trace failed")
    let finishRelease!: () => void
    let releaseStarted!: () => void
    const started = new Promise<void>(resolve => { releaseStarted = resolve })
    release.mockImplementation(async () => await new Promise<void>(resolve => {
      finishRelease = resolve
      releaseStarted()
    }))
    let finishTrace!: () => void
    const trace = vi.fn(async (event: TraceEvent) => {
      if (event.name === "browser.controller.attach") throw traceError
      if (event.name === "browser.controller.detach") {
        await new Promise<void>(resolve => { finishTrace = resolve })
      }
    })
    const session = await createBrowser({ provider, trace }).open()
    const attachment = expect(session.attach(controller)).rejects.toBe(traceError)
    await started
    const closing = session.close()
    expect(close).not.toHaveBeenCalled()
    finishRelease()

    try {
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
      expect(close).toHaveBeenCalledOnce()
      expect(release).toHaveBeenCalledOnce()
      expect(session.inspect().state).toBe("closed")
    }
    finally {
      finishTrace()
      await attachment
      await closing
    }
  })

  it("restores session ownership when handoff tracing fails", async () => {
    const { close, provider } = fixture()
    const traceError = new Error("trace unavailable")
    const trace = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(traceError)
    const browser = createBrowser({ provider, trace })
    const session = await browser.open()

    await expect(session.handoff({ audience: "run-1", mode: "live" })).rejects.toBe(traceError)
    expect(session.inspect().state).toBe("released")

    await session.close()
    expect(close).toHaveBeenCalledOnce()
  })

  it("closes a claimed session when tracing fails", async () => {
    const { close, provider } = fixture()
    const traceError = new Error("trace unavailable")
    const trace = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(traceError)
    const browser = createBrowser({ provider, trace })
    const session = await browser.open()
    const ref = await session.handoff({ audience: "run-1", mode: "live" })

    await expect(browser.claim(ref, { audience: "run-1" })).rejects.toBe(traceError)
    expect(close).toHaveBeenCalledOnce()
    await expect(browser.claim(ref, { audience: "run-1" })).rejects.toMatchObject({ code: "BROWSER_SESSION_REF_INVALID" })
  })
})
