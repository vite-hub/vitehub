// @vitest-environment happy-dom
import { createApp, createSSRApp, defineComponent, h, ref } from "vue"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createFakeBrowser, createFakeDisk } from "./support.ts"

import type { FakeDisk } from "./support.ts"
import type { StoredDataContext, UseStoredDataReturn } from "../src/vue.ts"

// Each test is one browser: a disk and a channel that outlive the pages of the test.
const browser = { disk: createFakeDisk(), tabs: createFakeBrowser() }
vi.mock("../src/indexeddb.ts", () => ({
  openIndexedDB: () => browser.disk.open(),
  browserChannel: () => browser.tabs.channel(),
}))

const day = 24 * 60 * 60 * 1000
const unmounts: (() => void)[] = []

beforeEach(() => {
  browser.disk = createFakeDisk()
  browser.tabs = createFakeBrowser()
})

afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount()
  vi.useRealTimers()
})

/** A new page load: fresh modules, so a fresh device and fresh shared reads, on the same disk. */
async function openPage() {
  vi.resetModules()
  const [device, vue] = await Promise.all([import("../src/index.ts"), import("../src/vue.ts")])
  return { ...device, ...vue }
}

/** Mounts a component that renders what `read` returns, and returns its root and the read. */
function mount<T>(read: () => UseStoredDataReturn<T, unknown>) {
  let result: UseStoredDataReturn<T, unknown> | undefined
  const app = createApp(defineComponent({
    setup() {
      const stored = read()
      result = stored
      return () => h("p", `${JSON.stringify(stored.data.value)} ${stored.status.value}${stored.storedAt.value ? " stored" : ""}`)
    },
  }))
  const root = document.createElement("div")
  app.mount(root)
  unmounts.push(() => app.unmount())
  return { root, read: result! }
}

/** A loader that answers when the test says so. */
function deferredLoader<T>() {
  const calls: { signal: AbortSignal, resolve: (value: T) => void, reject: (error: unknown) => void }[] = []
  const loader = ({ signal }: StoredDataContext) => new Promise<T>((resolve, reject) => {
    calls.push({ signal, resolve, reject })
  })
  return { calls, loader }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

/** A first visit as `ada` that stores the projects. */
async function visit(projects: string[] = ["p1"], disk: FakeDisk = browser.disk) {
  const page = await openPage()
  await page.openDevice()
  await page.setDeviceAccount("ada")
  const { root } = mount(() => page.useStoredData("projects", async () => projects, { default: () => [] }))
  await tick()
  expect(root.textContent).toBe(`${JSON.stringify(projects)} success`)
  await tick()
  expect(disk.keys).toEqual(["projects"])
  for (const unmount of unmounts.splice(0)) unmount()
}

describe("useStoredData", () => {
  it("shows the stored copy in the first render after a reload, then the answer of the loader", async () => {
    await visit()
    const page = await openPage()
    await page.openDevice()
    const { calls, loader } = deferredLoader<string[]>()
    const { root, read } = mount(() => page.useStoredData("projects", loader, { default: () => [] }))
    expect(root.textContent).toBe("[\"p1\"] pending stored")
    expect(read.storedAt.value).toBeInstanceOf(Date)
    expect(calls).toHaveLength(1)
    calls[0]!.resolve(["p1", "p2"])
    await tick()
    expect(root.textContent).toBe("[\"p1\",\"p2\"] success")
    expect(read.storedAt.value).toBeUndefined()
  })

  it("keeps the stored copy and sets error when the loader fails", async () => {
    await visit()
    const page = await openPage()
    await page.openDevice()
    const { root, read } = mount(() => page.useStoredData("projects", () => Promise.reject(new TypeError("Failed to fetch")), { default: () => [] }))
    await tick()
    expect(root.textContent).toBe("[\"p1\"] error stored")
    expect(read.error.value).toMatchObject({ name: "TypeError", message: "Failed to fetch" })
  })

  it("shows the default for another account, and for a stored copy older than maxAge", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.UTC(2026, 10, 15) })
    await visit()
    const page = await openPage()
    await page.openDevice()
    vi.setSystemTime(Date.UTC(2026, 10, 17))
    const old = mount(() => page.useStoredData("projects", deferredLoader<string[]>().loader, { default: () => [], maxAge: day }))
    expect(old.root.textContent).toBe("[] pending")
    for (const unmount of unmounts.splice(0)) unmount()
    const { root } = mount(() => page.useStoredData("projects", deferredLoader<string[]>().loader, { default: () => [] }))
    expect(root.textContent).toBe("[\"p1\"] pending stored")
    await page.setDeviceAccount("grace")
    await tick()
    expect(root.textContent).toBe("[] pending")
  })

  it("shares one state and one loader call between the reads of one key", async () => {
    const page = await openPage()
    await page.openDevice()
    const { calls, loader } = deferredLoader<string[]>()
    const first = mount(() => page.useStoredData("projects", loader))
    const second = mount(() => page.useStoredData("projects", loader))
    expect(calls).toHaveLength(1)
    calls[0]!.resolve(["p1"])
    await tick()
    expect(first.root.textContent).toBe("[\"p1\"] success")
    expect(second.root.textContent).toBe("[\"p1\"] success")
  })

  it("aborts an older loader call when refresh() starts a newer one", async () => {
    const page = await openPage()
    await page.openDevice()
    const { calls, loader } = deferredLoader<string>()
    const { root, read } = mount(() => page.useStoredData("status", loader))
    const refreshed = read.refresh()
    expect(calls[0]!.signal.aborted).toBe(true)
    calls[0]!.resolve("old")
    calls[1]!.resolve("new")
    await refreshed
    await tick()
    expect(root.textContent).toBe("\"new\" success")
  })

  it("moves to the stored copy of a new key", async () => {
    const page = await openPage()
    await page.openDevice()
    await page.setDeviceAccount("ada")
    const id = ref("p1")
    const answers: Record<string, string> = { p1: "Docs", p2: "Console" }
    const { root } = mount(() => page.useStoredData(() => `project:${id.value}`, async () => answers[id.value]!))
    await tick()
    id.value = "p2"
    await tick()
    expect(root.textContent).toBe("\"Console\" success")
    const second = await openPage()
    await second.openDevice()
    const again = mount(() => second.useStoredData(() => "project:p1", deferredLoader<string>().loader))
    expect(again.root.textContent).toBe("\"Docs\" pending stored")
  })

  it("renders like the server before openDevice(), starts the loader on mount, and shows a copy that loads later", async () => {
    await visit()
    const page = await openPage()
    const { calls, loader } = deferredLoader<string[]>()
    const { root } = mount(() => page.useStoredData("projects", loader, { default: () => [] }))
    expect(root.textContent).toBe("[] idle")
    expect(calls).toHaveLength(1)
    await tick()
    expect(root.textContent).toBe("[] pending")
    await page.openDevice()
    await tick()
    expect(root.textContent).toBe("[\"p1\"] pending stored")
    calls[0]!.resolve(["p1", "p2"])
    await tick()
    expect(root.textContent).toBe("[\"p1\",\"p2\"] success")
  })

  it("hydrates server HTML without a mismatch when the app opens the device after it mounts", async () => {
    await visit()
    const page = await openPage()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const { calls, loader } = deferredLoader<string[]>()
    const root = document.createElement("div")
    // What the server rendered: the default, and `idle`.
    root.innerHTML = "<p>[] idle</p>"
    const app = createSSRApp(defineComponent({
      setup() {
        const projects = page.useStoredData("projects", loader, { default: () => [] })
        return () => h("p", `${JSON.stringify(projects.data.value)} ${projects.status.value}${projects.storedAt.value ? " stored" : ""}`)
      },
    }))
    app.mount(root)
    unmounts.push(() => app.unmount())
    await page.openDevice()
    await tick()
    expect(warn.mock.calls.filter(([message]) => String(message).includes("Hydration"))).toEqual([])
    expect(root.textContent).toBe("[\"p1\"] pending stored")
    expect(calls).toHaveLength(1)
  })

  it("lists the stored copies in inspectDevice()", async () => {
    await visit(["p1", "p2"])
    const page = await openPage()
    await page.openDevice()
    expect(page.inspectDevice()).toEqual({
      account: "ada",
      persisted: false,
      storage: "indexeddb",
      entries: [{ key: "projects", storedAt: expect.any(Date), bytes: 11 }],
    })
  })

  it("clears the stored copies of every tab", async () => {
    await visit()
    const first = await openPage()
    await first.openDevice()
    await first.setDeviceAccount("ada")
    const shown = mount(() => first.useStoredData("projects", deferredLoader<string[]>().loader, { default: () => [] }))
    expect(shown.root.textContent).toBe("[\"p1\"] pending stored")
    // A second tab of the same browser: its own modules, on the same disk and channel.
    const second = await openPage()
    await second.openDevice()
    expect(await second.clearDevice()).toEqual([undefined, undefined])
    await tick()
    expect(shown.root.textContent).toBe("[] pending")
    expect(browser.disk.keys).toEqual([])
  })

  it("throws for an empty key and a negative maxAge", async () => {
    const page = await openPage()
    expect(() => page.useStoredData("", async () => 1)).toThrow(expect.objectContaining({ code: "DEVICE_INVALID_KEY" }))
    expect(() => page.useStoredData("projects", async () => 1, { maxAge: -1 })).toThrow(expect.objectContaining({ code: "DEVICE_INVALID_MAX_AGE" }))
    expect(() => page.setDeviceAccount("")).toThrow(expect.objectContaining({ code: "DEVICE_INVALID_ACCOUNT" }))
  })
})
