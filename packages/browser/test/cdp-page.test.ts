import { describe, expect, it, vi } from "vitest"

import { attachCDPPage } from "../src/internal/cdp-page.ts"

import type { CDPClient } from "../src/controllers/cdp.ts"

function fakeClient() {
  const listeners = new Map<string, Set<(params: unknown, sessionId?: string) => void>>()
  const send = vi.fn(async (method: string, params?: { expression?: string }) => {
    if (method === "Target.getTargets") return { targetInfos: [{ targetId: "page", type: "page" }] }
    if (method === "Target.attachToTarget") return { sessionId: "page-session" }
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
  it("navigates, interacts with locators, and captures native downloads", async () => {
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

    const download = await page.waitForDownload(async () => {
      await page.locator("button", { hasText: "Export Image" }).click()
      fake.emit("Page.downloadWillBegin", {
        suggestedFilename: "ray-so-export.png",
        url: "data:image/png;base64,cG5n",
      })
    })

    expect(download).toEqual({
      suggestedFilename: "ray-so-export.png",
      url: "data:image/png;base64,cG5n",
    })
    expect(fake.send).toHaveBeenCalledWith("Browser.setDownloadBehavior", {
      behavior: "default",
      eventsEnabled: true,
    })
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

  it("bounds the download action", async () => {
    const fake = fakeClient()
    const { page } = await attachCDPPage(fake.client)

    await expect(page.waitForDownload(async () => {
      fake.emit("Page.downloadWillBegin", {
        suggestedFilename: "export.png",
        url: "data:image/png;base64,cG5n",
      })
      await new Promise(() => {})
    }, { timeoutMs: 1 })).rejects.toMatchObject({ code: "BROWSER_PROVIDER_ERROR" })
  })

  it("serializes concurrent download waits", async () => {
    const fake = fakeClient()
    const { page } = await attachCDPPage(fake.client)
    const { page: otherPage } = await attachCDPPage(fake.client)
    const actions: string[] = []

    const first = page.waitForDownload(async () => {
      actions.push("first")
      fake.emit("Page.downloadWillBegin", { suggestedFilename: "first.png", url: "first" })
    })
    const second = otherPage.waitForDownload(async () => {
      actions.push("second")
      fake.emit("Page.downloadWillBegin", { suggestedFilename: "second.png", url: "second" })
    })

    await expect(Promise.all([first, second])).resolves.toEqual([
      { suggestedFilename: "first.png", url: "first" },
      { suggestedFilename: "second.png", url: "second" },
    ])
    expect(actions).toEqual(["first", "second"])
  })

  it("includes download queueing in the timeout", async () => {
    const fake = fakeClient()
    const { page } = await attachCDPPage(fake.client)
    const { page: otherPage } = await attachCDPPage(fake.client)
    let release = () => {}
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const actions: string[] = []

    const first = page.waitForDownload(async () => {
      actions.push("first")
      await blocked
      fake.emit("Browser.downloadWillBegin", { suggestedFilename: "first.png", url: "first" })
    })
    await vi.waitFor(() => expect(actions).toEqual(["first"]))
    const second = otherPage.waitForDownload(async () => {
      actions.push("second")
      fake.emit("Browser.downloadWillBegin", { suggestedFilename: "second.png", url: "second" })
    }, { timeoutMs: 1 })

    await expect(second).rejects.toMatchObject({ code: "BROWSER_PROVIDER_ERROR" })
    expect(actions).toEqual(["first"])
    release()
    await expect(first).resolves.toMatchObject({ suggestedFilename: "first.png" })
  })

  it("keeps late downloads behind the action barrier", async () => {
    const fake = fakeClient()
    const { page } = await attachCDPPage(fake.client)
    const { page: otherPage } = await attachCDPPage(fake.client)
    let release = () => {}
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const actions: string[] = []

    const first = page.waitForDownload(async () => {
      actions.push("first")
      await blocked
      fake.emit("Browser.downloadWillBegin", { suggestedFilename: "late-first.png", url: "late-first" })
    }, { timeoutMs: 1 })
    await expect(first).rejects.toMatchObject({ code: "BROWSER_PROVIDER_ERROR" })
    const second = otherPage.waitForDownload(async () => {
      actions.push("second")
      fake.emit("Browser.downloadWillBegin", { suggestedFilename: "second.png", url: "second" })
    }, { timeoutMs: 100 })

    await new Promise(resolve => setTimeout(resolve, 5))
    expect(actions).toEqual(["first"])
    release()
    await expect(second).resolves.toEqual({ suggestedFilename: "second.png", url: "second" })
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
