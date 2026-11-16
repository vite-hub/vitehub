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

type Page = Awaited<ReturnType<typeof openPage>>

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

  it("drops the answer of a loader call that started before another account, also when no copy is stored", async () => {
    const page = await openPage()
    await page.openDevice()
    await page.setDeviceAccount("ada")
    const { calls, loader } = deferredLoader<string[]>()
    const { root } = mount(() => page.useStoredData("projects", loader, { default: () => [] }))
    await page.setDeviceAccount("grace")
    expect(calls[0]!.signal.aborted).toBe(true)
    // The loader of `ada` answers late and does not look at its signal.
    calls[0]!.resolve(["ada only"])
    await tick()
    expect(root.textContent).toBe("[] pending")
    expect(browser.disk.keys).toEqual([])
    expect(calls).toHaveLength(2)
    calls[1]!.resolve(["grace"])
    await tick()
    expect(root.textContent).toBe("[\"grace\"] success")
    await tick()
    expect(browser.disk.entry("projects")?.json).toBe("[\"grace\"]")
  })

  it.each([
    ["a sign-out", (page: Page) => page.setDeviceAccount(null)],
    ["another account", (page: Page) => page.setDeviceAccount("grace")],
    ["clearDevice()", (page: Page) => page.clearDevice()],
  ])("shows the default and calls the loader again after %s, also for a read whose loader answered", async (_, change) => {
    const page = await openPage()
    await page.openDevice()
    await page.setDeviceAccount("ada")
    const { calls, loader } = deferredLoader<string[]>()
    const { root } = mount(() => page.useStoredData("projects", loader, { default: () => [] }))
    calls[0]!.resolve(["ada only"])
    await tick()
    expect(root.textContent).toBe("[\"ada only\"] success")
    await change(page)
    await tick()
    expect(root.textContent).toBe("[] pending")
    expect(calls).toHaveLength(2)
  })

  it("shows an answer that came before the page named its account, stores only the answer of the call after it", async () => {
    const page = await openPage()
    await page.openDevice()
    const { calls, loader } = deferredLoader<string[]>()
    const { root } = mount(() => page.useStoredData("projects", loader, { default: () => [] }))
    calls[0]!.resolve(["before"])
    await tick()
    expect(root.textContent).toBe("[\"before\"] success")
    await page.setDeviceAccount("ada")
    await tick()
    // The answer stays on the screen, and the read calls its loader again.
    expect(root.textContent).toBe("[\"before\"] pending")
    expect(browser.disk.keys).toEqual([])
    expect(calls).toHaveLength(2)
    calls[1]!.resolve(["after"])
    await tick()
    await tick()
    expect(root.textContent).toBe("[\"after\"] success")
    expect(browser.disk.entry("projects")?.json).toBe("[\"after\"]")
  })

  it("calls each loader once when the page names its account before the reads start", async () => {
    await visit()
    const page = await openPage()
    await page.openDevice()
    await page.setDeviceAccount("ada")
    const { calls, loader } = deferredLoader<string[]>()
    const { root } = mount(() => page.useStoredData("projects", loader, { default: () => [] }))
    expect(root.textContent).toBe("[\"p1\"] pending stored")
    calls[0]!.resolve(["p1", "p2"])
    await tick()
    await tick()
    expect(calls).toHaveLength(1)
    expect(browser.disk.entry("projects")?.json).toBe("[\"p1\",\"p2\"]")
  })

  it.each([
    ["before", true],
    ["after", false],
  ])("never stores under a new account an answer of a call that started before the page named it, when the answer comes %s the naming", async (_, answersFirst) => {
    const page = await openPage()
    await page.openDevice()
    await page.setDeviceAccount("ada")
    const { calls, loader } = deferredLoader<string[]>()
    const { root } = mount(() => page.useStoredData("projects", loader, { default: () => [] }))
    // Another tab signs in as `grace`. This tab drops everything and calls its loader again, with the session it had.
    const other = await openPage()
    await other.openDevice()
    await other.setDeviceAccount("grace")
    await tick()
    expect(calls).toHaveLength(2)
    if (answersFirst) {
      calls[1]!.resolve(["ada only"])
      await tick()
    }
    await page.setDeviceAccount("grace")
    if (!answersFirst) calls[1]!.resolve(["ada only"])
    await tick()
    await tick()
    expect(browser.disk.entry("projects")).toBeUndefined()
    expect(calls).toHaveLength(3)
    expect(calls[1]!.signal.aborted).toBe(true)
    calls[2]!.resolve(["grace"])
    await tick()
    await tick()
    expect(root.textContent).toBe("[\"grace\"] success")
    expect(browser.disk.entry("projects")?.json).toBe("[\"grace\"]")
  })

  it("shows the default in a tab whose read answered when another tab signs out", async () => {
    const first = await openPage()
    await first.openDevice()
    await first.setDeviceAccount("ada")
    const { calls, loader } = deferredLoader<string[]>()
    const { root } = mount(() => first.useStoredData("projects", loader, { default: () => [] }))
    calls[0]!.resolve(["ada only"])
    await tick()
    const second = await openPage()
    await second.openDevice()
    await second.setDeviceAccount(null)
    await tick()
    expect(root.textContent).toBe("[] pending")
    expect(calls).toHaveLength(2)
  })

  it("aborts the loader call of a read that nobody shows, so a late answer does not replace a newer one", async () => {
    const page = await openPage()
    await page.openDevice()
    await page.setDeviceAccount("ada")
    const slow = deferredLoader<string>()
    mount(() => page.useStoredData("status", slow.loader))
    for (const unmount of unmounts.splice(0)) unmount()
    expect(slow.calls[0]!.signal.aborted).toBe(true)
    const newer = mount(() => page.useStoredData("status", async () => "new"))
    await tick()
    expect(newer.root.textContent).toBe("\"new\" success")
    slow.calls[0]!.resolve("old")
    await tick()
    await tick()
    expect(newer.root.textContent).toBe("\"new\" success")
    expect(browser.disk.entry("status")?.json).toBe("\"new\"")
  })

  it("aborts the loader call of the previous key when the key changes", async () => {
    const page = await openPage()
    await page.openDevice()
    await page.setDeviceAccount("ada")
    const id = ref("p1")
    const { calls, loader } = deferredLoader<string>()
    mount(() => page.useStoredData(() => `project:${id.value}`, loader))
    id.value = "p2"
    await tick()
    expect(calls[0]!.signal.aborted).toBe(true)
    const again = mount(() => page.useStoredData("project:p1", async () => "Docs v2"))
    await tick()
    calls[0]!.resolve("Docs v1")
    await tick()
    await tick()
    expect(again.root.textContent).toBe("\"Docs v2\" success")
    expect(browser.disk.entry("project:p1")?.json).toBe("\"Docs v2\"")
  })

  it("throws for an empty key and a negative maxAge", async () => {
    const page = await openPage()
    expect(() => page.useStoredData("", async () => 1)).toThrow(expect.objectContaining({ code: "DEVICE_INVALID_KEY" }))
    expect(() => page.useStoredData("projects", async () => 1, { maxAge: -1 })).toThrow(expect.objectContaining({ code: "DEVICE_INVALID_MAX_AGE" }))
    expect(() => page.setDeviceAccount("")).toThrow(expect.objectContaining({ code: "DEVICE_INVALID_ACCOUNT" }))
  })
})

describe("the read that says who is signed in", () => {
  type Session = { user: { id: string } | null }
  const accountOf = (session: Session) => session.user?.id ?? null

  it("names the account from its answer and stores it, and the other reads start over so their answers are stored", async () => {
    const page = await openPage()
    await page.openDevice()
    const session = deferredLoader<Session>()
    const projects = deferredLoader<string[]>()
    const shown = mount(() => page.useStoredData("session", session.loader, { account: accountOf }))
    const list = mount(() => page.useStoredData("projects", projects.loader, { default: () => [] }))
    session.calls[0]!.resolve({ user: { id: "ada" } })
    await tick()
    expect(shown.root.textContent).toBe("{\"user\":{\"id\":\"ada\"}} success")
    // The read that named the account keeps its answer and calls its loader once. The other read starts over.
    expect(session.calls).toHaveLength(1)
    expect(projects.calls[0]!.signal.aborted).toBe(true)
    projects.calls[1]!.resolve(["p1"])
    await tick()
    await tick()
    expect(list.root.textContent).toBe("[\"p1\"] success")
    expect(browser.disk.meta).toMatchObject({ account: "ada" })
    expect(browser.disk.keys).toEqual(["projects", "session"])
  })

  it("empties the device when the session answers for another person, and stores that person's session", async () => {
    await visit()
    const page = await openPage()
    await page.openDevice()
    const session = deferredLoader<Session>()
    const projects = deferredLoader<string[]>()
    const shown = mount(() => page.useStoredData("session", session.loader, { account: accountOf }))
    const list = mount(() => page.useStoredData("projects", projects.loader, { default: () => [] }))
    expect(list.root.textContent).toBe("[\"p1\"] pending stored")
    session.calls[0]!.resolve({ user: { id: "bob" } })
    await tick()
    expect(shown.root.textContent).toBe("{\"user\":{\"id\":\"bob\"}} success")
    expect(list.root.textContent).toBe("[] pending")
    expect(session.calls).toHaveLength(1)
    await tick()
    expect(browser.disk.meta).toMatchObject({ account: "bob" })
    expect(browser.disk.keys).toEqual(["session"])
  })

  it("names nothing from a stored copy or a failed call, and resets the device when nobody is signed in", async () => {
    const first = await openPage()
    await first.openDevice()
    mount(() => first.useStoredData("session", async (): Promise<Session> => ({ user: { id: "ada" } }), { account: accountOf }))
    await tick()
    await tick()
    expect(browser.disk.keys).toEqual(["session"])
    for (const unmount of unmounts.splice(0)) unmount()
    const page = await openPage()
    await page.openDevice()
    const session = deferredLoader<Session>()
    const shown = mount(() => page.useStoredData("session", session.loader, { account: accountOf }))
    expect(shown.root.textContent).toBe("{\"user\":{\"id\":\"ada\"}} pending stored")
    expect(page.inspectDevice().persisted).toBe(false)
    session.calls[0]!.reject(new Error("offline"))
    await tick()
    expect(page.inspectDevice().persisted).toBe(false)
    const refreshing = shown.read.refresh()
    session.calls[1]!.resolve({ user: null })
    await refreshing
    await tick()
    expect(page.inspectDevice()).toMatchObject({ account: null, persisted: false })
    expect(browser.disk.keys).toEqual([])
  })

  it("names nothing from an answer whose call started before a clear, and names from the call after it", async () => {
    const page = await openPage()
    await page.openDevice()
    const session = deferredLoader<Session>()
    mount(() => page.useStoredData("session", session.loader, { account: accountOf }))
    void page.clearDevice()
    await tick()
    session.calls[0]!.resolve({ user: { id: "ada" } })
    await tick()
    expect(page.inspectDevice().persisted).toBe(false)
    expect(session.calls).toHaveLength(2)
    session.calls[1]!.resolve({ user: { id: "ada" } })
    await tick()
    await tick()
    expect(page.inspectDevice()).toMatchObject({ account: "ada", persisted: true })
    expect(browser.disk.keys).toEqual(["session"])
  })
})
