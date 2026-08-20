import { describe, expect, it, vi } from "vitest"

import { attachCDPPage } from "../src/internal/cdp-page.ts"

import type { CDPClient } from "../src/controllers/cdp.ts"

function fakeClient() {
  const listeners = new Map<string, Set<(params: unknown, sessionId?: string) => void>>()
  const send = vi.fn(async (method: string, params?: { expression?: string }) => {
    if (method === "Target.getTargets") return { targetInfos: [{ targetId: "page", type: "page" }] }
    if (method === "Target.attachToTarget") return { sessionId: "page-session" }
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main-frame" } } }
    if (method === "Page.navigate") return { loaderId: "document-loader" }
    if (method !== "Runtime.evaluate") return {}
    if (params?.expression?.includes('"count" === "count"')) return { result: { value: 1 } }
    if (params?.expression?.includes('"visible" === "visible"')) return { result: { value: true } }
    if (params?.expression?.includes('"inputValue" === "inputValue"')) return { result: { value: "typescript" } }
    return { result: { value: true } }
  })
  const client: CDPClient = {
    on(method, listener) {
      const methodListeners = listeners.get(method) ?? new Set()
      methodListeners.add(listener)
      listeners.set(method, methodListeners)
      return () => methodListeners.delete(listener)
    },
    send: send as CDPClient["send"],
  }
  return {
    client,
    emit(method: string, params: unknown, sessionId = "page-session") {
      for (const listener of listeners.get(method) ?? []) listener(params, sessionId)
    },
    send,
  }
}

describe("CDP page", () => {
  it("navigates and interacts with locators", async () => {
    const fake = fakeClient()
    const { page } = await attachCDPPage(fake.client)

    const navigation = page.goto("https://ray.so/")
    fake.emit("Page.lifecycleEvent", { loaderId: "document-loader", name: "load" })
    await navigation
    const editor = page.locator("textarea")
    await editor.waitFor()
    expect(await editor.count()).toBe(1)
    await editor.fill("const answer = 42")
    expect(await editor.inputValue()).toBe("typescript")
    const fill = fake.send.mock.calls.find((call) => {
      return call[0] === "Runtime.evaluate" && String(call[1]?.expression).includes('new Event("input"')
    })
    expect(fill).toBeDefined()
    expect(String(fill?.[1]?.expression)).toContain("element.focus()")

    await page.locator("button", { hasText: "Export Image" }).click()
    expect(fake.send).toHaveBeenCalledWith("Page.navigate", { url: "https://ray.so/" }, "page-session")
  })

  it("bounds page navigation", async () => {
    const fake = fakeClient()
    fake.send.mockImplementation(async (method: string) => {
      if (method === "Target.getTargets") return { targetInfos: [{ targetId: "page", type: "page" }] }
      if (method === "Target.attachToTarget") return { sessionId: "page-session" }
      if (method === "Page.navigate") return await new Promise(() => {})
      return {}
    })
    const { page } = await attachCDPPage(fake.client)

    await expect(page.goto("https://example.com", { timeoutMs: 1 })).rejects.toMatchObject({
      code: "BROWSER_PROVIDER_ERROR",
    })
  })

  it("correlates concurrent navigation lifecycle events", async () => {
    const fake = fakeClient()
    let navigation = 0
    fake.send.mockImplementation(async (method: string) => {
      if (method === "Target.getTargets") return { targetInfos: [{ targetId: "page", type: "page" }] }
      if (method === "Target.attachToTarget") return { sessionId: "page-session" }
      if (method === "Page.navigate") return { loaderId: `loader-${++navigation}` }
      return {}
    })
    const { page } = await attachCDPPage(fake.client)
    let firstDone = false

    const first = page.goto("https://example.com/first").then(() => {
      firstDone = true
    })
    const second = page.goto("https://example.com/second")
    await vi.waitFor(() => expect(navigation).toBe(2))
    fake.emit("Page.lifecycleEvent", { loaderId: "loader-2", name: "load" })
    await second
    expect(firstDone).toBe(false)
    fake.emit("Page.lifecycleEvent", { loaderId: "loader-1", name: "load" })
    await first
  })

  it("waits for navigation requested by a locator click to stop", async () => {
    const fake = fakeClient()
    fake.send.mockImplementation(async (method: string) => {
      if (method === "Target.getTargets") return { targetInfos: [{ targetId: "page", type: "page" }] }
      if (method === "Target.attachToTarget") return { sessionId: "page-session" }
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main-frame" } } }
      if (method === "Runtime.evaluate") {
        fake.emit("Page.frameRequestedNavigation", { frameId: "main-frame" })
        return { result: { value: true } }
      }
      return {}
    })
    const { page } = await attachCDPPage(fake.client)
    let clicked = false

    const click = page.locator("a").click().then(() => {
      clicked = true
    })
    await vi.waitFor(() => expect(fake.send).toHaveBeenCalledWith(
      "Runtime.evaluate",
      expect.objectContaining({ expression: expect.stringContaining('"click" === "click"') }),
      "page-session",
    ))
    expect(clicked).toBe(false)
    fake.emit("Page.frameStoppedLoading", { frameId: "main-frame" })
    await click
  })

  it("serializes locator click navigation waits", async () => {
    const fake = fakeClient()
    let evaluations = 0
    fake.send.mockImplementation(async (method: string) => {
      if (method === "Target.getTargets") return { targetInfos: [{ targetId: "page", type: "page" }] }
      if (method === "Target.attachToTarget") return { sessionId: "page-session" }
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main-frame" } } }
      if (method === "Runtime.evaluate") {
        evaluations++
        if (evaluations === 1) fake.emit("Page.frameRequestedNavigation", { frameId: "main-frame" })
        return { result: { value: true } }
      }
      return {}
    })
    const { page } = await attachCDPPage(fake.client)

    const first = page.locator("a:first-child").click()
    const second = page.locator("a:last-child").click()
    await vi.waitFor(() => expect(evaluations).toBe(1))
    fake.emit("Page.frameStoppedLoading", { frameId: "main-frame" })
    await Promise.all([first, second])
    expect(evaluations).toBe(2)
  })

  it("keeps a timed-out click behind the navigation barrier", async () => {
    vi.useFakeTimers()
    try {
      const fake = fakeClient()
      let evaluations = 0
      fake.send.mockImplementation(async (method: string) => {
        if (method === "Target.getTargets") return { targetInfos: [{ targetId: "page", type: "page" }] }
        if (method === "Target.attachToTarget") return { sessionId: "page-session" }
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main-frame" } } }
        if (method === "Runtime.evaluate") {
          evaluations++
          fake.emit("Page.frameRequestedNavigation", { frameId: "main-frame" })
          return { result: { value: true } }
        }
        return {}
      })
      const { page } = await attachCDPPage(fake.client)

      const first = page.locator("a:first-child").click()
      const firstResult = expect(first).rejects.toMatchObject({ code: "BROWSER_PROVIDER_ERROR" })
      await vi.advanceTimersByTimeAsync(0)
      expect(evaluations).toBe(1)
      await vi.advanceTimersByTimeAsync(30_000)
      await firstResult
      const second = page.locator("a:last-child").click()
      await vi.advanceTimersByTimeAsync(0)
      expect(evaluations).toBe(1)
      fake.emit("Page.frameStoppedLoading", { frameId: "main-frame" })
      await vi.advanceTimersByTimeAsync(0)
      expect(evaluations).toBe(2)
      fake.emit("Page.frameStoppedLoading", { frameId: "main-frame" })
      await expect(second).resolves.toBeUndefined()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("bounds a stalled locator click evaluation", async () => {
    vi.useFakeTimers()
    try {
      const fake = fakeClient()
      fake.send.mockImplementation(async (method: string) => {
        if (method === "Target.getTargets") return { targetInfos: [{ targetId: "page", type: "page" }] }
        if (method === "Target.attachToTarget") return { sessionId: "page-session" }
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main-frame" } } }
        if (method === "Runtime.evaluate") return await new Promise(() => {})
        return {}
      })
      const { page } = await attachCDPPage(fake.client)

      const click = page.locator("button").click()
      const clickResult = expect(click).rejects.toMatchObject({ code: "BROWSER_PROVIDER_ERROR" })
      await vi.advanceTimersByTimeAsync(30_000)
      await clickResult
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("bounds locator evaluation", async () => {
    const fake = fakeClient()
    fake.send.mockImplementation(async (method: string) => {
      if (method === "Target.getTargets") return { targetInfos: [{ targetId: "page", type: "page" }] }
      if (method === "Target.attachToTarget") return { sessionId: "page-session" }
      if (method === "Runtime.evaluate") return await new Promise(() => {})
      return {}
    })
    const { page } = await attachCDPPage(fake.client)

    await expect(page.locator("button").waitFor({ timeoutMs: 1 })).rejects.toMatchObject({
      code: "BROWSER_PROVIDER_ERROR",
    })
  })

  it("rejects failed page navigations", async () => {
    const fake = fakeClient()
    fake.send.mockImplementation(async (method: string) => {
      if (method === "Target.getTargets") return { targetInfos: [{ targetId: "page", type: "page" }] }
      if (method === "Target.attachToTarget") return { sessionId: "page-session" }
      if (method === "Page.navigate") return { errorText: "net::ERR_NAME_NOT_RESOLVED" }
      return {}
    })
    const { page } = await attachCDPPage(fake.client)

    await expect(page.goto("https://missing.invalid")).rejects.toMatchObject({
      code: "BROWSER_PROVIDER_ERROR",
    })
    expect(fake.send).not.toHaveBeenCalledWith("Runtime.evaluate", expect.anything(), "page-session")
  })
})
