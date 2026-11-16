// @vitest-environment happy-dom
import { createApp, createSSRApp, defineComponent, h, ref, watch } from "vue"
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

  it("reloads a shared key with the loader of a component that still reads it, after another one moved to another key", async () => {
    const page = await openPage()
    await page.openDevice()
    await page.setDeviceAccount("ada")
    const stays = mount(() => page.useStoredData("project:p1", async () => "p1 of the component that stays"))
    const id = ref("p1")
    // The loader of this component reads `id`, so after the move it loads p2.
    const moves = mount(() => page.useStoredData(() => `project:${id.value}`, async () => `${id.value} of the component that moves`))
    await tick()
    await moves.read.refresh()
    id.value = "p2"
    await tick()
    await page.clearDevice()
    await tick()
    await tick()
    expect(stays.root.textContent).toBe("\"p1 of the component that stays\" success")
    expect(browser.disk.entry("project:p1")?.json).toBe("\"p1 of the component that stays\"")
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

  it("calls the loader of a read with a stored copy once, after the session answered", async () => {
    await visit()
    const page = await openPage()
    await page.openDevice()
    const session = deferredLoader<Session>()
    const projects = deferredLoader<string[]>()
    mount(() => page.useStoredData("session", session.loader, { account: accountOf }))
    const list = mount(() => page.useStoredData("projects", projects.loader, { default: () => [] }))
    // The stored copy shows, and its loader waits for the naming, so it runs once.
    expect(list.root.textContent).toBe("[\"p1\"] pending stored")
    expect(projects.calls).toHaveLength(0)
    session.calls[0]!.resolve({ user: { id: "ada" } })
    await tick()
    expect(projects.calls).toHaveLength(1)
    projects.calls[0]!.resolve(["p2"])
    await tick()
    await tick()
    expect(list.root.textContent).toBe("[\"p2\"] success")
    expect(browser.disk.entry("projects")?.json).toBe("[\"p2\"]")
  })

  it("starts a read without a stored copy at once, and a held read when the session fails", async () => {
    await visit()
    const page = await openPage()
    await page.openDevice()
    const session = deferredLoader<Session>()
    const projects = deferredLoader<string[]>()
    const settings = deferredLoader<string>()
    mount(() => page.useStoredData("session", session.loader, { account: accountOf }))
    mount(() => page.useStoredData("projects", projects.loader, { default: () => [] }))
    mount(() => page.useStoredData("settings", settings.loader))
    expect(settings.calls).toHaveLength(1)
    expect(projects.calls).toHaveLength(0)
    session.calls[0]!.reject(new Error("offline"))
    await tick()
    expect(projects.calls).toHaveLength(1)
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

describe("the read that says who is signed in, against other changes", () => {
  type Session = { user: { id: string } | null }
  const accountOf = (session: Session) => session.user?.id ?? null

  beforeEach(() => {
    // The failed reset prints DEVICE_STORAGE_FAILED once.
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("does not name an account that answered while the device opened, when another tab named another account meanwhile", async () => {
    await visit()
    const page = await openPage()
    const release = browser.disk.holdNextRead()
    const opening = page.openDevice()
    const session = deferredLoader<Session>()
    mount(() => page.useStoredData("session", session.loader, { account: accountOf }))
    session.calls[0]!.resolve({ user: { id: "ada" } })
    await tick()
    // Bob signs in, in another tab.
    const other = await openPage()
    await other.openDevice()
    await other.setDeviceAccount("bob")
    release()
    await opening
    await tick()
    await tick()
    expect(browser.disk.meta).toMatchObject({ account: "bob" })
    expect(page.inspectDevice().account).not.toBe("ada")
    // The read starts over, and the answer of the new call names Bob.
    session.calls.at(-1)!.resolve({ user: { id: "bob" } })
    await tick()
    await tick()
    expect(page.inspectDevice()).toMatchObject({ account: "bob", persisted: true })
  })

  it("does not store the session when the event of its naming names another account", async () => {
    const page = await openPage()
    await page.openDevice()
    const session = deferredLoader<Session>()
    let projectCalls = 0
    mount(() => page.useStoredData("session", session.loader, { account: accountOf }))
    const shown = mount(() => page.useStoredData("projects", () => {
      // The call that the naming of Ada starts names Bob at once.
      if (++projectCalls === 2) void page.setDeviceAccount("bob")
      return new Promise<string[]>(() => undefined)
    }))
    session.calls[0]!.resolve({ user: { id: "ada" } })
    await tick()
    await tick()
    expect(shown.read.status.value).toBe("pending")
    expect(session.calls).toHaveLength(2)
    expect(page.inspectDevice().account).toBe("bob")
    expect(browser.disk.entry("session")).toBeUndefined()
  })

  it("drops an older session call when another session read answered that nobody is signed in", async () => {
    const page = await openPage()
    await page.openDevice()
    const first = deferredLoader<Session>()
    const second = deferredLoader<Session>()
    mount(() => page.useStoredData("session-a", first.loader, { account: accountOf }))
    mount(() => page.useStoredData("session-b", second.loader, { account: accountOf }))
    first.calls[0]!.resolve({ user: null })
    await tick()
    second.calls[0]!.resolve({ user: { id: "ada" } })
    await tick()
    await tick()
    expect(page.inspectDevice().account).toBeNull()
    expect(second.calls).toHaveLength(2)
    expect(browser.disk.keys).toEqual([])
  })

  it("brings the disk to the account again when its session answers after a failed reset", async () => {
    const before = await openPage()
    await before.openDevice()
    await before.setDeviceAccount("bob")
    for (const unmount of unmounts.splice(0)) unmount()
    const page = await openPage()
    await page.openDevice()
    const session = deferredLoader<Session>()
    const read = mount(() => page.useStoredData("session", session.loader, { account: accountOf }))
    browser.disk.failing = true
    session.calls[0]!.resolve({ user: { id: "ada" } })
    await tick()
    await tick()
    expect(browser.disk.meta).toMatchObject({ account: "bob" })
    browser.disk.failing = false
    const refreshing = read.read.refresh()
    session.calls[1]!.resolve({ user: { id: "ada" } })
    await refreshing
    await tick()
    await tick()
    expect(browser.disk.meta).toMatchObject({ account: "ada" })
    expect(page.inspectDevice().persisted).toBe(true)
  })
})

describe("the read that says who is signed in, and the reads it holds", () => {
  type Session = { user: { id: string } | null }
  const accountOf = (session: Session) => session.user?.id ?? null

  /** A first visit as `ada` that stores `projects` and `settings`. */
  async function visitBoth() {
    const page = await openPage()
    await page.openDevice()
    await page.setDeviceAccount("ada")
    mount(() => page.useStoredData("projects", async () => ["p1"]))
    mount(() => page.useStoredData("settings", async () => "dark"))
    await tick()
    await tick()
    expect(browser.disk.keys).toEqual(["projects", "settings"])
    for (const unmount of unmounts.splice(0)) unmount()
  }

  it("names the account of a session that answers right before the page opens the device, and never shows the copies of another account", async () => {
    await visitBoth()
    const page = await openPage()
    const list = mount(() => page.useStoredData("projects", async () => new Promise<string[]>(() => undefined), { default: () => [] }))
    mount(() => page.useStoredData("session", async (): Promise<Session> => ({ user: { id: "bob" } }), { account: accountOf }))
    queueMicrotask(() => void page.openDevice())
    await tick()
    await tick()
    await tick()
    expect(page.inspectDevice().account).toBe("bob")
    expect(list.root.textContent).not.toContain("p1")
    expect(browser.disk.meta).toMatchObject({ account: "bob" })
  })

  it("names the account before the session answer shows, also when code that watches it opens the device", async () => {
    await visitBoth()
    const page = await openPage()
    const list = mount(() => page.useStoredData("projects", async () => new Promise<string[]>(() => undefined), { default: () => [] }))
    const shown = mount(() => page.useStoredData("session", async (): Promise<Session> => ({ user: { id: "bob" } }), { account: accountOf }))
    watch(shown.read.data, () => void page.openDevice(), { flush: "sync", once: true })
    for (let index = 0; index < 5; index++) await tick()
    expect(page.inspectDevice().account).toBe("bob")
    expect(list.root.textContent).not.toContain("p1")
    expect(browser.disk.meta).toMatchObject({ account: "bob" })
  })

  it("resolves refresh() of a held read when the read goes, also while its loader ignores the abort", async () => {
    await visitBoth()
    const page = await openPage()
    await page.openDevice()
    const session = deferredLoader<Session>()
    mount(() => page.useStoredData("session", session.loader, { account: accountOf }))
    const app = createApp(defineComponent({
      setup() {
        const projects = page.useStoredData("projects", () => new Promise<string[]>(() => undefined))
        void projects.refresh().then(() => {
          refreshed = true
        })
        return () => h("p", String(projects.status.value))
      },
    }))
    let refreshed = false
    app.mount(document.createElement("div"))
    session.calls[0]!.resolve({ user: { id: "ada" } })
    await tick()
    expect(refreshed).toBe(false)
    app.unmount()
    await tick()
    expect(refreshed).toBe(true)
  })

  it("does not show a session answer whose call a loader that the naming started replaced", async () => {
    await visitBoth()
    const page = await openPage()
    await page.openDevice()
    const session = deferredLoader<Session>()
    const shown = mount(() => page.useStoredData("session", session.loader, { account: accountOf }))
    mount(() => page.useStoredData("projects", async () => {
      void shown.read.refresh()
      return ["p2"]
    }))
    session.calls[0]!.resolve({ user: { id: "ada" } })
    await tick()
    expect(session.calls).toHaveLength(2)
    expect(shown.read.status.value).toBe("pending")
  })

  it("stops starting held reads when a loader that starts calls the session read again", async () => {
    await visitBoth()
    const page = await openPage()
    await page.openDevice()
    const session = deferredLoader<Session>()
    const shownSession = mount(() => page.useStoredData("session", session.loader, { account: accountOf }))
    const projectCalls: number[] = []
    mount(() => page.useStoredData("projects", async () => {
      projectCalls.push(projectCalls.length)
      void shownSession.read.refresh()
      return ["p2"]
    }))
    const settings = deferredLoader<string>()
    mount(() => page.useStoredData("settings", settings.loader))
    expect(projectCalls).toHaveLength(0)
    session.calls[0]!.reject(new Error("offline"))
    await tick()
    // The projects loader started the session read again, so settings waits for it.
    expect(projectCalls).toHaveLength(1)
    expect(settings.calls).toHaveLength(0)
    session.calls[1]!.resolve({ user: { id: "ada" } })
    await tick()
    expect(settings.calls).toHaveLength(1)
  })

  it("resolves refresh() of a held read when its call after the hold ends", async () => {
    await visitBoth()
    const page = await openPage()
    await page.openDevice()
    const session = deferredLoader<Session>()
    mount(() => page.useStoredData("session", session.loader, { account: accountOf }))
    const projects = deferredLoader<string[]>()
    const list = mount(() => page.useStoredData("projects", projects.loader))
    let refreshed = false
    void list.read.refresh().then(() => {
      refreshed = true
    })
    await tick()
    expect(refreshed).toBe(false)
    session.calls[0]!.resolve({ user: { id: "ada" } })
    await tick()
    expect(projects.calls).toHaveLength(1)
    expect(refreshed).toBe(false)
    projects.calls[0]!.resolve(["p2"])
    await tick()
    expect(refreshed).toBe(true)
    expect(list.read.status.value).toBe("success")
  })
})

describe("useStoredFetch", () => {
  /** A server for `fetch()`: each request waits until the test answers it. */
  function fakeServer() {
    const requests: { url: string, init: RequestInit, answer: (status: number, body: unknown) => void }[] = []
    vi.stubGlobal("fetch", (url: string, init: RequestInit) => new Promise<Response>((resolve) => {
      requests.push({ url, init, answer: (status, body) => resolve(Response.json(body, { status })) })
    }))
    return requests
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("asks for the path with the query sorted by name, and stores the answer under that key", async () => {
    const requests = fakeServer()
    const page = await openPage()
    await page.openDevice()
    await page.setDeviceAccount("ada")
    const { root } = mount(() => page.useStoredFetch<string[]>("/api/projects?sort=name#top", { query: { team: "t1", archived: null, page: 2, open: true, owner: undefined }, default: () => [] }))
    expect(requests.map(request => request.url)).toEqual(["/api/projects?open=true&page=2&sort=name&team=t1"])
    expect(requests[0]!.init.signal).toBeInstanceOf(AbortSignal)
    expect(new Headers(requests[0]!.init.headers).get("accept")).toBe("application/json")
    requests[0]!.answer(200, ["p1"])
    await tick()
    await tick()
    expect(root.textContent).toBe("[\"p1\"] success")
    expect(browser.disk.keys).toEqual(["/api/projects?open=true&page=2&sort=name&team=t1"])

    // The next page load shows the copy in its first render, for a URL written with another order and an absolute URL on
    // the origin of the page.
    const next = await openPage()
    await next.openDevice()
    const again = mount(() => next.useStoredFetch<string[]>(`${location.origin}/api/projects?team=t1`, { query: { page: 2, sort: "name", open: true }, default: () => [] }))
    expect(again.root.textContent).toBe("[\"p1\"] pending stored")
  })

  it("keeps the origin in the key of a URL on another origin", async () => {
    const requests = fakeServer()
    const page = await openPage()
    await page.openDevice()
    await page.setDeviceAccount("ada")
    mount(() => page.useStoredFetch("https://api.example.com/projects?b=2&a=1"))
    requests[0]!.answer(200, ["p1"])
    await tick()
    await tick()
    expect(requests[0]!.url).toBe("https://api.example.com/projects?a=1&b=2")
    expect(browser.disk.keys).toEqual(["https://api.example.com/projects?a=1&b=2"])
  })

  it("puts an answer that is not 2xx in error with DEVICE_FETCH_FAILED, keeps the stored copy, and stores nothing", async () => {
    const requests = fakeServer()
    const first = await openPage()
    await first.openDevice()
    await first.setDeviceAccount("ada")
    mount(() => first.useStoredFetch<string[]>("/api/projects", { default: () => [] }))
    requests[0]!.answer(200, ["p1"])
    await tick()
    await tick()
    for (const unmount of unmounts.splice(0)) unmount()

    const page = await openPage()
    await page.openDevice()
    await page.setDeviceAccount("ada")
    const { root, read } = mount(() => page.useStoredFetch<string[]>("/api/projects", { default: () => [] }))
    requests[1]!.answer(500, { error: "Database down" })
    await tick()
    await tick()
    expect(root.textContent).toBe("[\"p1\"] error stored")
    expect(read.error.value).toMatchObject({ code: "DEVICE_FETCH_FAILED", why: expect.stringContaining("GET /api/projects answered 500") })
    expect(browser.disk.entry("/api/projects")?.json).toBe("[\"p1\"]")
  })

  it("names no account from an error answer of the read that says who is signed in", async () => {
    await visit()
    const requests = fakeServer()
    const page = await openPage()
    await page.openDevice()
    const { read } = mount(() => page.useStoredFetch<{ user: { id: string } | null }>("/api/session", { account: session => session.user?.id ?? null }))
    // A JSON error body with `user: null` must not sign the person out of the device.
    requests[0]!.answer(401, { user: null })
    await tick()
    await tick()
    expect(read.status.value).toBe("error")
    expect(page.inspectDevice().account).toBe("ada")
    expect(browser.disk.keys).toEqual(["projects"])
  })

  it("moves to a new key when the query changes, and aborts the request of the previous key", async () => {
    const requests = fakeServer()
    const page = await openPage()
    await page.openDevice()
    const team = ref("t1")
    const { root } = mount(() => page.useStoredFetch<string[]>("/api/projects", { query: () => ({ team: team.value }), default: () => [] }))
    team.value = "t2"
    await tick()
    expect(requests.map(request => request.url)).toEqual(["/api/projects?team=t1", "/api/projects?team=t2"])
    expect(requests[0]!.init.signal!.aborted).toBe(true)
    requests[1]!.answer(200, ["t2 project"])
    await tick()
    expect(root.textContent).toBe("[\"t2 project\"] success")
  })

  it("asks for the URL of its own key when it starts again, also after the component that called it last moved", async () => {
    const requests = fakeServer()
    const page = await openPage()
    await page.openDevice()
    await page.setDeviceAccount("ada")
    const team = ref("t1")
    const stays = mount(() => page.useStoredFetch<string[]>("/api/projects", { query: { team: "t1" } }))
    const moves = mount(() => page.useStoredFetch<string[]>("/api/projects", { query: () => ({ team: team.value }) }))
    // The component that moves calls the shared read of t1 last, then moves to t2.
    void moves.read.refresh()
    team.value = "t2"
    await tick()
    // A clear starts every read over: the read of t1 must ask for t1 again.
    await page.clearDevice()
    await tick()
    expect(requests.map(request => request.url)).toEqual([
      "/api/projects?team=t1",
      "/api/projects?team=t1",
      "/api/projects?team=t2",
      "/api/projects?team=t1",
      "/api/projects?team=t2",
    ])
    expect(stays.root.textContent).toBe("undefined pending")
  })
})
