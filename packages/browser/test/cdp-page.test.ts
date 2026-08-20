import { describe, expect, it, vi } from "vitest"

import { attachCDPPage } from "../src/internal/cdp-page.ts"

import type { CDPClient } from "../src/controllers/cdp.ts"

function fakeClient() {
  const listeners = new Map<string, Set<(params: unknown, sessionId?: string) => void>>()
  const send = vi.fn(async (method: string, params?: { expression?: string, type?: string }) => {
    if (method === "Target.getTargets") return { targetInfos: [{ targetId: "page", type: "page" }] }
    if (method === "Target.attachToTarget") return { sessionId: "page-session" }
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main-frame" } } }
    if (method === "Page.navigate") return { loaderId: "document-loader" }
    if (method !== "Runtime.evaluate") return {}
    if (params?.expression?.includes('"count" === "count"')) return { result: { value: 1 } }
    if (params?.expression?.includes('"visible" === "visible"')) return { result: { value: true } }
    if (params?.expression?.includes('"inputValue" === "inputValue"')) return { result: { value: "typescript" } }
    if (params?.expression?.includes('"click" === "click"')) return { result: { value: { x: 10, y: 20 } } }
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
  it("creates a page target when the browser opens empty", async () => {
    const fake = fakeClient()
    fake.send.mockImplementation(async (method: string) => {
      if (method === "Target.getTargets") return { targetInfos: [] }
      if (method === "Target.createTarget") return { targetId: "created-page" }
      if (method === "Target.attachToTarget") return { sessionId: "page-session" }
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main-frame" } } }
      return {}
    })

    await attachCDPPage(fake.client)

    expect(fake.send).toHaveBeenCalledWith("Target.createTarget", { url: "about:blank" })
    expect(fake.send).toHaveBeenCalledWith(
      "Target.attachToTarget",
      { flatten: true, targetId: "created-page" },
    )
  })

  it("bounds page setup", async () => {
    vi.useFakeTimers()
    try {
      const fake = fakeClient()
      fake.send.mockImplementation(async () => await new Promise(() => {}))

      const attached = attachCDPPage(fake.client)
      const result = expect(attached).rejects.toMatchObject({ code: "BROWSER_PROVIDER_ERROR" })
      await vi.advanceTimersByTimeAsync(30_100)
      await result
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("navigates and interacts with locators", async () => {
    const fake = fakeClient()
    const { page } = await attachCDPPage(fake.client)

    const navigation = page.goto("https://ray.so/")
    await vi.waitFor(() => expect(fake.send).toHaveBeenCalledWith(
      "Page.navigate",
      { url: "https://ray.so/" },
      "page-session",
    ))
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
    expect(fake.send).toHaveBeenCalledWith(
      "Input.dispatchMouseEvent",
      { button: "left", clickCount: 1, type: "mousePressed", x: 10, y: 20 },
      "page-session",
    )
    const clickEvaluation = fake.send.mock.calls.find((call) => {
      return call[0] === "Runtime.evaluate" && String(call[1]?.expression).includes('"click" === "click"')
    })
    expect(String(clickEvaluation?.[1]?.expression)).toContain("element.scrollIntoView")
    expect(String(clickEvaluation?.[1]?.expression)).toContain("element.getClientRects")
    expect(String(clickEvaluation?.[1]?.expression)).toContain("document.elementFromPoint")
    expect(String(clickEvaluation?.[1]?.expression)).toContain("for (const rect of rects)")
    expect(fake.send).toHaveBeenCalledWith(
      "Input.dispatchMouseEvent",
      { button: "left", clickCount: 1, type: "mouseReleased", x: 10, y: 20 },
      "page-session",
    )
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
    await expect(page.locator("main").count()).rejects.toMatchObject({
      code: "BROWSER_PROVIDER_ERROR",
    })
    expect(fake.send).not.toHaveBeenCalledWith("Runtime.evaluate", expect.anything(), "page-session")
  })

  it("treats visible SVG elements as locator matches", async () => {
    const fake = fakeClient()
    const { page } = await attachCDPPage(fake.client)

    await page.locator("svg").waitFor()

    expect(fake.send).toHaveBeenCalledWith(
      "Runtime.evaluate",
      expect.objectContaining({ expression: expect.stringContaining("element instanceof Element") }),
      "page-session",
    )
  })

  it("does not invalidate a reusable page after a short locator wait timeout", async () => {
    vi.useFakeTimers()
    try {
      const fake = fakeClient()
      let visibleEvaluations = 0
      fake.send.mockImplementation(async (method: string, params?: { expression?: string }) => {
        if (method === "Target.getTargets") return { targetInfos: [{ targetId: "page", type: "page" }] }
        if (method === "Target.attachToTarget") return { sessionId: "page-session" }
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main-frame" } } }
        if (method !== "Runtime.evaluate") return {}
        if (params?.expression?.includes('"visible" === "visible"') && visibleEvaluations++ === 0) {
          return await new Promise(() => {})
        }
        if (params?.expression?.includes('"count" === "count"')) return { result: { value: 1 } }
        return { result: { value: true } }
      })
      const { page } = await attachCDPPage(fake.client)

      const wait = page.locator("main").waitFor({ timeoutMs: 10 })
      const result = expect(wait).rejects.toMatchObject({ code: "BROWSER_PROVIDER_ERROR" })
      await vi.advanceTimersByTimeAsync(10)
      await result
      await vi.advanceTimersByTimeAsync(30_000)

      await expect(page.locator("main").count()).resolves.toBe(1)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("allows SVG elements through the pointer click path", async () => {
    const fake = fakeClient()
    const { page } = await attachCDPPage(fake.client)

    await page.locator("svg[role=button]").click()

    const clickEvaluation = fake.send.mock.calls.find((call) => {
      return call[0] === "Runtime.evaluate" && String(call[1]?.expression).includes('"click" === "click"')
    })
    expect(String(clickEvaluation?.[1]?.expression)).toContain("element instanceof Element")
    expect(String(clickEvaluation?.[1]?.expression).indexOf("element instanceof Element"))
      .toBeLessThan(String(clickEvaluation?.[1]?.expression).indexOf("element instanceof HTMLElement"))
  })

  it("serializes overlapping page navigations", async () => {
    const fake = fakeClient()
    let navigation = 0
    fake.send.mockImplementation(async (method: string) => {
      if (method === "Target.getTargets") return { targetInfos: [{ targetId: "page", type: "page" }] }
      if (method === "Target.attachToTarget") return { sessionId: "page-session" }
      if (method === "Page.navigate") return { loaderId: `loader-${++navigation}` }
      return {}
    })
    const { page } = await attachCDPPage(fake.client)
    const first = page.goto("https://example.com/first")
    const second = page.goto("https://example.com/second")
    await vi.waitFor(() => expect(navigation).toBe(1))
    fake.emit("Page.lifecycleEvent", { loaderId: "loader-1", name: "load" })
    await first
    await vi.waitFor(() => expect(navigation).toBe(2))
    fake.emit("Page.lifecycleEvent", { loaderId: "loader-2", name: "load" })
    await second
  })

  it("serializes locator clicks behind explicit navigation", async () => {
    const fake = fakeClient()
    const { page } = await attachCDPPage(fake.client)

    const navigation = page.goto("https://example.com/first")
    await vi.waitFor(() => expect(fake.send).toHaveBeenCalledWith(
      "Page.navigate",
      { url: "https://example.com/first" },
      "page-session",
    ))
    const click = page.locator("a.next").click()
    await Promise.resolve()
    expect(fake.send).not.toHaveBeenCalledWith(
      "Runtime.evaluate",
      expect.objectContaining({ expression: expect.stringContaining('"click" === "click"') }),
      "page-session",
    )

    fake.emit("Page.lifecycleEvent", { loaderId: "document-loader", name: "load" })
    await navigation
    await click

    expect(fake.send).toHaveBeenCalledWith(
      "Runtime.evaluate",
      expect.objectContaining({ expression: expect.stringContaining('"click" === "click"') }),
      "page-session",
    )
  })

  it("keeps later clicks usable when a queued click expires", async () => {
    vi.useFakeTimers()
    try {
      const fake = fakeClient()
      const { page } = await attachCDPPage(fake.client)

      const navigation = page.goto("https://example.com/slow", { timeoutMs: 60_000 })
      await vi.waitFor(() => expect(fake.send).toHaveBeenCalledWith(
        "Page.navigate",
        { url: "https://example.com/slow" },
        "page-session",
      ))
      const expiredClick = page.locator("a.expired").click()
      const expiredResult = expect(expiredClick).rejects.toMatchObject({ code: "BROWSER_PROVIDER_ERROR" })
      await vi.advanceTimersByTimeAsync(30_000)
      await expiredResult

      fake.emit("Page.lifecycleEvent", { loaderId: "document-loader", name: "load" })
      await navigation
      const currentClick = page.locator("a.current").click()
      await vi.advanceTimersByTimeAsync(0)
      await currentClick

      const clickExpressions = fake.send.mock.calls.filter((call) => {
        return call[0] === "Runtime.evaluate" && String(call[1]?.expression).includes('"click" === "click"')
      })
      expect(clickExpressions).toHaveLength(1)
      expect(String(clickExpressions[0]?.[1]?.expression)).toContain("a.current")
    }
    finally {
      vi.useRealTimers()
    }
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

  it("completes locator clicks after same-document navigation", async () => {
    const fake = fakeClient()
    fake.send.mockImplementation(async (method: string, params?: { expression?: string, type?: string }) => {
      if (method === "Target.getTargets") return { targetInfos: [{ targetId: "page", type: "page" }] }
      if (method === "Target.attachToTarget") return { sessionId: "page-session" }
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main-frame" } } }
      if (method === "Runtime.evaluate") {
        if (params?.expression?.includes('"count" === "count"')) return { result: { value: 1 } }
        fake.emit("Page.frameRequestedNavigation", { frameId: "main-frame" })
        return { result: { value: { x: 10, y: 20 } } }
      }
      if (method === "Input.dispatchMouseEvent") {
        if (params?.type === "mouseReleased") fake.emit("Page.navigatedWithinDocument", { frameId: "main-frame" })
      }
      return {}
    })
    const { page } = await attachCDPPage(fake.client)

    await page.locator("a[href='#main']").click()
    await expect(page.locator("main").count()).resolves.toBe(1)
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

  it("invalidates later clicks after a navigation timeout", async () => {
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
      await expect(page.locator("a:last-child").click()).rejects.toMatchObject({ code: "BROWSER_PROVIDER_ERROR" })
      await expect(page.locator("main").count()).rejects.toMatchObject({ code: "BROWSER_PROVIDER_ERROR" })
      fake.emit("Page.frameStoppedLoading", { frameId: "main-frame" })
      await vi.advanceTimersByTimeAsync(0)
      expect(evaluations).toBe(1)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("invalidates the page after a partial pointer dispatch", async () => {
    const fake = fakeClient()
    fake.send.mockImplementation(async (method: string, params?: { expression?: string, type?: string }) => {
      if (method === "Target.getTargets") return { targetInfos: [{ targetId: "page", type: "page" }] }
      if (method === "Target.attachToTarget") return { sessionId: "page-session" }
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main-frame" } } }
      if (method === "Runtime.evaluate") return { result: { value: { x: 10, y: 20 } } }
      if (method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased") throw new Error("release failed")
      return {}
    })
    const { page } = await attachCDPPage(fake.client)

    await expect(page.locator("button").click()).rejects.toThrow("release failed")
    await expect(page.locator("main").count()).rejects.toThrow("release failed")
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

  it("does not advance the click queue after a timed-out evaluation resolves late", async () => {
    vi.useFakeTimers()
    try {
      const fake = fakeClient()
      let evaluations = 0
      let resolveEvaluation!: (value: { result: { value: boolean } }) => void
      fake.send.mockImplementation(async (method: string) => {
        if (method === "Target.getTargets") return { targetInfos: [{ targetId: "page", type: "page" }] }
        if (method === "Target.attachToTarget") return { sessionId: "page-session" }
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main-frame" } } }
        if (method === "Runtime.evaluate") {
          evaluations++
          return await new Promise<{ result: { value: boolean } }>((resolve) => {
            resolveEvaluation = resolve
          })
        }
        return {}
      })
      const { page } = await attachCDPPage(fake.client)

      const first = page.locator("a:first-child").click()
      const firstResult = expect(first).rejects.toMatchObject({ code: "BROWSER_PROVIDER_ERROR" })
      await vi.advanceTimersByTimeAsync(10_000)
      const second = page.locator("a:last-child").click()
      const secondResult = expect(second).rejects.toMatchObject({ code: "BROWSER_PROVIDER_ERROR" })
      await vi.advanceTimersByTimeAsync(20_000)
      await firstResult
      resolveEvaluation({ result: { value: true } })
      await vi.advanceTimersByTimeAsync(0)
      await secondResult
      expect(evaluations).toBe(1)
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

  it("bounds direct locator evaluation", async () => {
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

      const count = page.locator("button").count()
      const result = expect(count).rejects.toMatchObject({ code: "BROWSER_PROVIDER_ERROR" })
      await vi.advanceTimersByTimeAsync(30_000)
      await result
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("invalidates the page after a direct locator timeout", async () => {
    vi.useFakeTimers()
    try {
      let resolveEvaluation!: (value: { result: { value: boolean } }) => void
      const fake = fakeClient()
      fake.send.mockImplementation(async (method: string) => {
        if (method === "Target.getTargets") return { targetInfos: [{ targetId: "page", type: "page" }] }
        if (method === "Target.attachToTarget") return { sessionId: "page-session" }
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main-frame" } } }
        if (method === "Runtime.evaluate") {
          return await new Promise<{ result: { value: boolean } }>(resolve => {
            resolveEvaluation = resolve
          })
        }
        return {}
      })
      const { page } = await attachCDPPage(fake.client)

      const first = page.locator("input").fill("late")
      const firstResult = expect(first).rejects.toMatchObject({ code: "BROWSER_PROVIDER_ERROR" })
      await vi.advanceTimersByTimeAsync(30_000)
      await firstResult
      await expect(page.locator("input").fill("next")).rejects.toMatchObject({ code: "BROWSER_PROVIDER_ERROR" })
      resolveEvaluation({ result: { value: true } })
      await vi.advanceTimersByTimeAsync(0)
      expect(fake.send.mock.calls.filter(([method]) => method === "Runtime.evaluate")).toHaveLength(1)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("bounds page key dispatches", async () => {
    vi.useFakeTimers()
    try {
      const fake = fakeClient()
      fake.send.mockImplementation(async (method: string) => {
        if (method === "Target.getTargets") return { targetInfos: [{ targetId: "page", type: "page" }] }
        if (method === "Target.attachToTarget") return { sessionId: "page-session" }
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main-frame" } } }
        if (method === "Input.dispatchKeyEvent") return await new Promise(() => {})
        return {}
      })
      const { page } = await attachCDPPage(fake.client)

      const press = page.press("Enter")
      const result = expect(press).rejects.toMatchObject({ code: "BROWSER_PROVIDER_ERROR" })
      await vi.advanceTimersByTimeAsync(30_000)
      await result
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("sends text for printable keys", async () => {
    const fake = fakeClient()
    fake.send.mockImplementation(async (method: string) => {
      if (method === "Target.getTargets") return { targetInfos: [{ targetId: "page", type: "page" }] }
      if (method === "Target.attachToTarget") return { sessionId: "page-session" }
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main-frame" } } }
      return {}
    })
    const { page } = await attachCDPPage(fake.client)

    await page.press("a")

    expect(fake.send).toHaveBeenCalledWith(
      "Input.dispatchKeyEvent",
      { code: "KeyA", key: "a", nativeVirtualKeyCode: 65, text: "a", type: "keyDown", windowsVirtualKeyCode: 65 },
      "page-session",
    )

    await page.press("Enter")
    expect(fake.send).toHaveBeenCalledWith(
      "Input.dispatchKeyEvent",
      { code: "Enter", key: "Enter", nativeVirtualKeyCode: 13, text: "\r", type: "keyDown", windowsVirtualKeyCode: 13 },
      "page-session",
    )

    await page.press("😀")
    expect(fake.send).toHaveBeenCalledWith(
      "Input.dispatchKeyEvent",
      { key: "😀", text: "😀", type: "keyDown" },
      "page-session",
    )
  })

  it("invalidates the page after a partial key dispatch", async () => {
    const fake = fakeClient()
    let keyEvents = 0
    fake.send.mockImplementation(async (method: string) => {
      if (method === "Target.getTargets") return { targetInfos: [{ targetId: "page", type: "page" }] }
      if (method === "Target.attachToTarget") return { sessionId: "page-session" }
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main-frame" } } }
      if (method === "Input.dispatchKeyEvent" && ++keyEvents === 2) throw new Error("key release failed")
      return {}
    })
    const { page } = await attachCDPPage(fake.client)

    await expect(page.press("Enter")).rejects.toThrow("key release failed")
    await expect(page.locator("main").count()).rejects.toThrow("key release failed")
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
