import { afterEach, describe, expect, it, vi } from "vitest"

import { createFakeBrowser, createFakeDisk, openPage } from "./support.ts"

import type { Device, DeviceEvent } from "../src/device.ts"

const day = 24 * 60 * 60 * 1000

afterEach(() => {
  vi.restoreAllMocks()
})

/** The answer of a loader call that starts and answers now. */
function answer(page: Device, key: string, value: unknown, maxAge = day): void {
  page.write(key, value, maxAge, page.epoch())
}

/** A page that opened the device and named `ada`, with one stored answer. */
async function pageWithProjects(disk = createFakeDisk(), browser = createFakeBrowser()) {
  const page = openPage(disk, browser)
  await page.open()
  await page.setAccount("ada")
  answer(page, "projects", [{ id: "p1", name: "Docs" }])
  await page.settled()
  return page
}

describe("stored copies", () => {
  it("shows the copy of the last visit at once after a reload", async () => {
    const disk = createFakeDisk()
    await pageWithProjects(disk)
    const reload = openPage(disk)
    await reload.open()
    expect(reload.read("projects", day)?.value).toEqual([{ id: "p1", name: "Docs" }])
    expect(reload.inspect()).toMatchObject({ account: "ada", persisted: false, storage: "indexeddb", entries: [{ key: "projects", bytes: 27 }] })
    await reload.setAccount("ada")
    expect(reload.inspect().persisted).toBe(true)
    expect(reload.read("projects", day)?.value).toEqual([{ id: "p1", name: "Docs" }])
  })

  it("stores only the answers of loader calls that start after the page names its account", async () => {
    const disk = createFakeDisk()
    const page = openPage(disk)
    await page.open()
    // A loader call that starts and answers before the page names an account.
    answer(page, "projects", ["p1"])
    await page.settled()
    expect(disk.keys).toEqual([])
    expect(page.inspect()).toMatchObject({ account: null, persisted: false, entries: [] })
    expect(page.read("projects", day)).toBeUndefined()
    // A loader call that starts before the page names its account and answers after it.
    const started = page.epoch()
    await page.setAccount("ada")
    page.write("projects", ["p1"], day, started)
    await page.settled()
    expect(disk.meta).toMatchObject({ account: "ada", version: "" })
    expect(disk.keys).toEqual([])
    answer(page, "projects", ["p2"])
    await page.settled()
    expect(disk.entry("projects")?.json).toBe("[\"p2\"]")
  })

  it("names the account at once on an open device, so a read that starts right after the call is stored before the disk follows", async () => {
    const disk = createFakeDisk()
    const page = openPage(disk)
    await page.open()
    const naming = page.setAccount("ada")
    expect(page.inspect().account).toBe("ada")
    answer(page, "projects", ["p1"])
    expect(await naming).toEqual([undefined, undefined])
    await page.settled()
    expect(disk.meta).toMatchObject({ account: "ada" })
    expect(disk.keys).toEqual(["projects"])
  })

  it("does not keep the answer of a loader call that started before a clear", async () => {
    const disk = createFakeDisk()
    const page = await pageWithProjects(disk)
    const started = page.epoch()
    await page.clear()
    page.write("projects", ["old"], day, started)
    await page.settled()
    expect(page.read("projects", day)).toBeUndefined()
    expect(disk.keys).toEqual([])
  })

  it("keeps nothing for a page that never names an account", async () => {
    const disk = createFakeDisk()
    const page = openPage(disk)
    await page.open()
    answer(page, "projects", ["p1"])
    await page.settled()
    const reload = openPage(disk)
    await reload.open()
    expect(reload.read("projects", day)).toBeUndefined()
    expect(disk.keys).toEqual([])
  })

  it("empties the device for another account, and stores nothing that came before the page named it", async () => {
    const disk = createFakeDisk()
    await pageWithProjects(disk)
    const reload = openPage(disk)
    const events: DeviceEvent[] = []
    reload.subscribe(event => events.push(event))
    await reload.open()
    // The session check answers after another read.
    answer(reload, "settings", { theme: "dark" })
    expect(await reload.setAccount("grace")).toEqual([undefined, undefined])
    await reload.settled()
    expect(events).toEqual([{ type: "load", keys: ["projects"] }, { type: "reset" }])
    expect(reload.read("projects", day)).toBeUndefined()
    expect(reload.inspect()).toMatchObject({ account: "grace", persisted: true, entries: [] })
    expect(disk.meta).toMatchObject({ account: "grace", version: "" })
    expect(disk.keys).toEqual([])
  })

  it("never shows the copies of another account when the page names its account while the device opens", async () => {
    const disk = createFakeDisk()
    await pageWithProjects(disk)
    const reload = openPage(disk)
    const events: DeviceEvent[] = []
    reload.subscribe(event => events.push(event))
    const opening = reload.open()
    const named = reload.setAccount("grace")
    await opening
    expect(reload.read("projects", day)).toBeUndefined()
    await named
    expect(events.filter(event => event.type === "load")).toEqual([])
    expect(disk.keys).toEqual([])
  })

  it("starts over when the page named its account before it opened the device", async () => {
    const disk = createFakeDisk()
    await pageWithProjects(disk)
    const reload = openPage(disk)
    await reload.setAccount("grace")
    await reload.open()
    await reload.settled()
    expect(reload.read("projects", day)).toBeUndefined()
    expect(disk.meta).toMatchObject({ account: "grace", version: "" })
    expect(disk.keys).toEqual([])
  })

  it("deletes every copy and writes nothing after a sign-out", async () => {
    const disk = createFakeDisk()
    const page = await pageWithProjects(disk)
    await page.setAccount(null)
    answer(page, "projects", ["p2"])
    await page.settled()
    expect(page.read("projects", day)).toBeUndefined()
    expect(page.inspect()).toMatchObject({ account: null, persisted: false, entries: [] })
    expect(disk.meta).toMatchObject({ account: null, version: "" })
    expect(disk.keys).toEqual([])
  })

  it("empties the device when the version changes", async () => {
    const disk = createFakeDisk()
    const first = openPage(disk)
    await first.open({ version: "1" })
    await first.setAccount("ada")
    answer(first, "projects", ["p1"])
    await first.settled()
    const next = openPage(disk)
    await next.open({ version: "2" })
    expect(next.read("projects", day)).toBeUndefined()
    await next.settled()
    expect(disk.keys).toEqual([])
    expect(disk.meta).toMatchObject({ account: "ada", version: "2" })
    // The account stays, so the new build keeps writing for it.
    await next.setAccount("ada")
    answer(next, "projects", ["p1", "p2"])
    await next.settled()
    expect(disk.keys).toEqual(["projects"])
  })

  it("throws when the app opens the device again with another version", async () => {
    const page = openPage(createFakeDisk())
    await page.open({ version: "1" })
    await expect(page.open({ version: "1" })).resolves.toBeUndefined()
    expect(() => page.open({ version: "2" })).toThrow(expect.objectContaining({ code: "DEVICE_ALREADY_OPEN" }))
  })
})

describe("age and size", () => {
  it("hides a copy older than maxAge, and deletes expired copies when the device opens", async () => {
    let time = Date.UTC(2026, 10, 15)
    const disk = createFakeDisk()
    const page = openPage(disk, undefined, { now: () => time })
    await page.open()
    await page.setAccount("ada")
    answer(page, "projects", ["p1"], 7 * day)
    answer(page, "feed", ["f1"], day)
    await page.settled()
    time += 2 * day
    expect(page.read("projects", day)).toBeUndefined()
    expect(page.read("projects", 7 * day)?.storedAt).toBe(Date.UTC(2026, 10, 15))
    const reload = openPage(disk, undefined, { now: () => time })
    await reload.open()
    await reload.settled()
    expect(reload.read("feed", Infinity)).toBeUndefined()
    expect(disk.keys).toEqual(["projects"])
  })

  it("deletes the oldest copies when the device is over its size cap", async () => {
    let time = 1
    const disk = createFakeDisk()
    // Each value is 10 bytes of JSON: "xxxxxxxx".
    const page = openPage(disk, undefined, { maxBytes: 25, now: () => time++ })
    await page.open()
    await page.setAccount("ada")
    answer(page, "a", "x".repeat(8))
    answer(page, "b", "x".repeat(8))
    answer(page, "c", "x".repeat(8))
    await page.settled()
    expect(page.inspect().entries.map(entry => entry.key)).toEqual(["b", "c"])
    expect(disk.keys).toEqual(["b", "c"])
  })

  it("lets the disk pick the oldest copies over the cap, not the memory of a tab", async () => {
    let time = 1
    const disk = createFakeDisk()
    const browser = createFakeBrowser()
    // Each value is 10 bytes of JSON. The disk holds two of them.
    const first = openPage(disk, browser, { maxBytes: 25, now: () => time++ })
    await first.open()
    await first.setAccount("ada")
    const second = openPage(disk, browser, { maxBytes: 25, now: () => time++ })
    await second.open()
    await second.setAccount("ada")
    answer(first, "a", "x".repeat(8))
    answer(first, "b", "x".repeat(8))
    await first.settled()
    answer(second, "c", "x".repeat(8))
    await second.settled()
    // The second tab stores a newer `a`. The first tab still has its older `a` in memory.
    answer(second, "a", "y".repeat(8))
    await second.settled()
    expect(disk.keys).toEqual(["a", "c"])
    answer(first, "d", "x".repeat(8))
    await first.settled()
    // `c` is the oldest copy on the disk. The newer `a` of the second tab stays.
    expect(disk.keys).toEqual(["a", "d"])
    expect(disk.entry("a")?.json).toBe(JSON.stringify("y".repeat(8)))
  })

  it("does not keep a value over the size cap, or a value that JSON cannot store, and removes the older copy", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const disk = createFakeDisk()
    const page = openPage(disk, undefined, { maxBytes: 25 })
    await page.open()
    await page.setAccount("ada")
    answer(page, "report", "small")
    answer(page, "report", "x".repeat(40))
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    answer(page, "tree", cycle)
    answer(page, "tree", cycle)
    await page.settled()
    expect(page.read("report", day)).toBeUndefined()
    expect(disk.keys).toEqual([])
    expect(warn.mock.calls.map(([message]) => String(message).split(":")[0])).toEqual(["[vitehub] DEVICE_VALUE_TOO_LARGE", "[vitehub] DEVICE_VALUE_NOT_JSON"])
  })
})

describe("tabs", () => {
  it("clears the copies in every tab", async () => {
    const disk = createFakeDisk()
    const browser = createFakeBrowser()
    const first = await pageWithProjects(disk, browser)
    const second = openPage(disk, browser)
    await second.open()
    await second.setAccount("ada")
    const events: DeviceEvent[] = []
    second.subscribe(event => events.push(event))
    expect(await first.clear()).toEqual([undefined, undefined])
    expect(events).toEqual([{ type: "reset" }])
    expect(first.read("projects", day)).toBeUndefined()
    expect(second.read("projects", day)).toBeUndefined()
    expect(disk.keys).toEqual([])
    // The account stays, so the next answers are stored again.
    answer(second, "projects", ["p2"])
    await second.settled()
    expect(disk.keys).toEqual(["projects"])
  })

  it("drops the copies of a tab when another tab signs in as another account, and stops its writes", async () => {
    const disk = createFakeDisk()
    const browser = createFakeBrowser()
    const first = await pageWithProjects(disk, browser)
    const second = openPage(disk, browser)
    await second.open()
    await second.setAccount("grace")
    expect(first.read("projects", day)).toBeUndefined()
    expect(first.inspect()).toMatchObject({ account: "grace", persisted: false })
    // A late answer in the first tab came with the old session. It stays out of the disk.
    answer(first, "projects", [{ id: "p1", name: "Docs" }])
    await first.settled()
    expect(disk.keys).toEqual([])
  })

  it("drops everything of a tab that missed a sign-out and then got a sign-in as the same account", async () => {
    const disk = createFakeDisk()
    const browser = createFakeBrowser()
    const first = await pageWithProjects(disk, browser)
    const second = openPage(disk, browser)
    await second.open()
    await second.setAccount("ada")
    const events: DeviceEvent[] = []
    first.subscribe(event => events.push(event))
    // A loader call of the first tab, before the sign-out.
    const started = first.epoch()
    browser.drop = message => message.type === "account" && message.account === null
    await second.setAccount(null)
    browser.drop = undefined
    await second.setAccount("ada")
    await first.settled()
    expect(events).toEqual([{ type: "reset" }])
    expect(first.epoch()).not.toBe(started)
    expect(first.read("projects", day)).toBeUndefined()
    expect(disk.keys).toEqual([])
    first.write("settings", { theme: "dark" }, day, started)
    await first.settled()
    expect(disk.keys).toEqual([])
    // The account on the disk is the account of the tab, so its next answers are stored.
    answer(first, "projects", ["p2"])
    await first.settled()
    expect(disk.keys).toEqual(["projects"])
  })

  it("refuses a write for an account that is no longer on the disk, also without a channel between the tabs", async () => {
    const disk = createFakeDisk()
    const first = await pageWithProjects(disk)
    const second = openPage(disk)
    await second.open()
    await second.setAccount("grace")
    answer(first, "secrets", ["ada only"])
    await first.settled()
    expect(disk.meta).toMatchObject({ account: "grace", version: "" })
    expect(disk.keys).toEqual([])
    expect(first.inspect().persisted).toBe(false)
  })

  it("drops every copy of a tab whose write finds another account on the disk, and writes again only after it names an account", async () => {
    const disk = createFakeDisk()
    const first = await pageWithProjects(disk)
    const events: DeviceEvent[] = []
    first.subscribe(event => events.push(event))
    // A second tab with no channel to the first, as a tab that missed the message.
    const second = openPage(disk)
    await second.open()
    await second.setAccount("grace")
    answer(first, "settings", { theme: "dark" })
    await first.settled()
    // The copies of `ada` must not seed a new read of this tab.
    expect(first.read("projects", day)).toBeUndefined()
    expect(first.inspect()).toMatchObject({ account: "grace", persisted: false, entries: [] })
    expect(events).toEqual([{ type: "reset" }])
    answer(first, "settings", { theme: "light" })
    await first.settled()
    expect(disk.keys).toEqual([])
  })

  it.each([
    ["a clear", (tab: Device) => tab.clear()],
    ["a sign-out and a sign-in as the same account", async (tab: Device) => {
      await tab.setAccount(null)
      await tab.setAccount("ada")
    }],
  ])("refuses a write that a tab queued before %s that it missed", async (_, change) => {
    const disk = createFakeDisk()
    const first = await pageWithProjects(disk)
    // A second tab with no channel to the first, as a suspended tab that missed the messages.
    const second = openPage(disk)
    await second.open()
    await second.setAccount("ada")
    await change(second)
    expect(disk.keys).toEqual([])
    answer(first, "projects", [{ id: "p1", name: "Docs" }])
    await first.settled()
    expect(disk.keys).toEqual([])
    expect(first.read("projects", day)).toBeUndefined()
    // The account on the disk is still the account of the tab, so its next answers are stored.
    expect(first.inspect()).toMatchObject({ account: "ada", persisted: true, entries: [] })
    answer(first, "projects", [])
    await first.settled()
    expect(disk.keys).toEqual(["projects"])
  })

  it.each([
    ["clears the device", (tab: Device) => tab.clear()],
    ["names another account", (tab: Device) => tab.setAccount("grace")],
  ])("does not show the copies that a tab read from the disk when another tab %s meanwhile", async (_, change) => {
    const disk = createFakeDisk()
    const browser = createFakeBrowser()
    const first = await pageWithProjects(disk, browser)
    const second = openPage(disk, browser, { openTimeout: 5000 })
    const events: DeviceEvent[] = []
    second.subscribe(event => events.push(event))
    const release = disk.holdNextRead()
    const opening = second.open()
    // The second tab has read the disk, and the answer waits.
    await new Promise(resolve => setTimeout(resolve, 0))
    await change(first)
    release()
    await opening
    expect(second.read("projects", day)).toBeUndefined()
    expect(second.inspect()).toMatchObject({ storage: "indexeddb", entries: [] })
    expect(events.filter(event => event.type === "load")).toEqual([])
  })

  it("keeps the copies of another account that a tab finds on the disk after it read an expired copy, and missed the message", async () => {
    let time = 1
    const disk = createFakeDisk()
    const ada = openPage(disk, createFakeBrowser(), { now: () => time })
    await ada.open()
    await ada.setAccount("ada")
    ada.write("projects", ["ada"], 10, ada.epoch())
    await ada.settled()
    time = 100
    // The opening tab reads the expired copy of `ada`. Its channel is not the one of the other tab, so it misses the message.
    const opening = openPage(disk, createFakeBrowser(), { now: () => time, openTimeout: 5000 })
    const release = disk.holdNextRead()
    const opened = opening.open()
    await new Promise(resolve => setTimeout(resolve, 0))
    const grace = openPage(disk, createFakeBrowser(), { now: () => time })
    await grace.open()
    await grace.setAccount("grace")
    answer(grace, "projects", ["grace"])
    await grace.settled()
    release()
    await opened
    await opening.settled()
    expect(disk.meta).toMatchObject({ account: "grace" })
    expect(disk.keys).toEqual(["projects"])
    expect(disk.entry("projects")?.json).toBe(JSON.stringify(["grace"]))
    expect(opening.inspect()).toMatchObject({ account: "grace", persisted: false, entries: [] })
  })

  it("keeps the copies of another account that a tab of a new version finds on the disk after it read an old one", async () => {
    const disk = createFakeDisk()
    const old = openPage(disk, createFakeBrowser())
    await old.open({ version: "1" })
    await old.setAccount("ada")
    answer(old, "projects", ["ada"])
    await old.settled()
    // A tab of version 2 reads the copies of `ada` in version 1, and misses the messages of the other tab.
    const opening = openPage(disk, createFakeBrowser(), { openTimeout: 5000 })
    const release = disk.holdNextRead()
    const opened = opening.open({ version: "2" })
    await new Promise(resolve => setTimeout(resolve, 0))
    const grace = openPage(disk, createFakeBrowser())
    await grace.open({ version: "2" })
    await grace.setAccount("grace")
    answer(grace, "projects", ["grace"])
    await grace.settled()
    release()
    await opened
    await opening.settled()
    expect(disk.meta).toMatchObject({ account: "grace", version: "2" })
    expect(disk.entry("projects")?.json).toBe(JSON.stringify(["grace"]))
    expect(opening.inspect()).toMatchObject({ account: "grace", persisted: false, entries: [] })
  })

  it("does not reassert an account that the page named before it opened when another tab named another account meanwhile", async () => {
    const disk = createFakeDisk()
    const old = openPage(disk, createFakeBrowser())
    await old.open({ version: "1" })
    await old.setAccount("ada")
    answer(old, "projects", ["ada"])
    await old.settled()
    // The page names `ada` from its session, then reads the disk of version 1. The tab misses the messages of the other tab.
    const page = openPage(disk, createFakeBrowser(), { openTimeout: 5000 })
    void page.setAccount("ada")
    const release = disk.holdNextRead()
    const opened = page.open({ version: "2" })
    await new Promise(resolve => setTimeout(resolve, 0))
    // Meanwhile Grace signs in, in another tab of version 2, so the session of the page is no longer the one of `ada`.
    const grace = openPage(disk, createFakeBrowser())
    await grace.open({ version: "2" })
    await grace.setAccount("grace")
    answer(grace, "projects", ["grace"])
    await grace.settled()
    release()
    await opened
    await page.settled()
    expect(disk.meta).toMatchObject({ account: "grace", version: "2" })
    expect(disk.entry("projects")?.json).toBe(JSON.stringify(["grace"]))
    expect(page.inspect()).toMatchObject({ account: "grace", persisted: false, entries: [] })
    // An answer with the session of Grace is not stored as a copy of `ada`, or at all, until the page names an account.
    answer(page, "projects", ["grace-fresh"])
    await page.settled()
    expect(disk.entry("projects")?.json).toBe(JSON.stringify(["grace"]))
    await page.setAccount("grace")
    answer(page, "projects", ["grace-fresh"])
    await page.settled()
    expect(disk.entry("projects")?.json).toBe(JSON.stringify(["grace-fresh"]))
  })

  it("drops a naming of the page when a clear of another tab shows another account on the disk, after it missed the naming", async () => {
    const disk = createFakeDisk()
    const browser = createFakeBrowser()
    const old = openPage(disk, browser)
    await old.open({ version: "1" })
    await old.setAccount("ada")
    answer(old, "projects", ["ada"])
    await old.settled()
    old.close()
    const page = openPage(disk, browser, { openTimeout: 5000 })
    void page.setAccount("ada")
    const release = disk.holdNextRead()
    const opened = page.open({ version: "2" })
    await new Promise(resolve => setTimeout(resolve, 0))
    // The page misses the naming of Grace, and then hears her clear, whose meta has the account of Grace.
    browser.drop = message => message.type === "account"
    const grace = openPage(disk, browser)
    await grace.open({ version: "2" })
    await grace.setAccount("grace")
    browser.drop = undefined
    await grace.clear()
    answer(grace, "projects", ["grace"])
    await grace.settled()
    release()
    await opened
    await page.settled()
    expect(disk.meta).toMatchObject({ account: "grace", version: "2" })
    expect(disk.entry("projects")?.json).toBe(JSON.stringify(["grace"]))
    expect(page.inspect()).toMatchObject({ account: "grace", persisted: false })
    answer(page, "projects", ["grace-fresh"])
    await page.settled()
    expect(disk.entry("projects")?.json).toBe(JSON.stringify(["grace"]))
  })

  it("stops when another tab cleared the same account while it opened, and stores again after the page names its account", async () => {
    const disk = createFakeDisk()
    const old = openPage(disk, createFakeBrowser())
    await old.open({ version: "1" })
    await old.setAccount("ada")
    answer(old, "projects", ["ada"])
    await old.settled()
    const page = openPage(disk, createFakeBrowser(), { openTimeout: 5000 })
    void page.setAccount("ada")
    const release = disk.holdNextRead()
    const opened = page.open({ version: "2" })
    await new Promise(resolve => setTimeout(resolve, 0))
    // The tab of version 1, which this one does not hear, clears the copies of `ada`.
    await old.clear()
    release()
    await opened
    await page.settled()
    // One naming, one reset attempt: the disk stays as the other tab left it, in version 1.
    expect(disk.meta).toMatchObject({ account: "ada", version: "1" })
    expect(page.inspect()).toMatchObject({ account: "ada", persisted: false })
    await page.setAccount("ada")
    expect(disk.meta).toMatchObject({ account: "ada", version: "2" })
    expect(page.inspect()).toMatchObject({ account: "ada", persisted: true })
    answer(page, "projects", ["ada"])
    await page.settled()
    expect(disk.keys).toEqual(["projects"])
  })

  it("keeps the shared disk under its size cap when several tabs write", async () => {
    let time = 1
    const disk = createFakeDisk()
    const browser = createFakeBrowser()
    // Each value is 10 bytes of JSON. Each tab holds 20 bytes, under the cap, and the disk would hold 40.
    const first = openPage(disk, browser, { maxBytes: 25, now: () => time++ })
    await first.open()
    await first.setAccount("ada")
    const second = openPage(disk, browser, { maxBytes: 25, now: () => time++ })
    await second.open()
    await second.setAccount("ada")
    answer(first, "a", "x".repeat(8))
    answer(second, "b", "x".repeat(8))
    answer(first, "c", "x".repeat(8))
    answer(second, "d", "x".repeat(8))
    await first.settled()
    await second.settled()
    expect(disk.keys).toEqual(["c", "d"])
  })

  it("names the account of the last call when a clear and another account run together", async () => {
    const disk = createFakeDisk()
    const page = await pageWithProjects(disk)
    expect(await Promise.all([page.clear(), page.setAccount("grace")])).toEqual([[undefined, undefined], [undefined, undefined]])
    expect(disk.meta).toMatchObject({ account: "grace" })
    expect(page.inspect()).toMatchObject({ account: "grace", persisted: true })
    answer(page, "projects", ["grace"])
    await page.settled()
    expect(disk.keys).toEqual(["projects"])
  })
})

describe("storage failures", () => {
  it("keeps copies in memory when IndexedDB refuses to open", async () => {
    const disk = createFakeDisk()
    disk.refuse = true
    const page = openPage(disk)
    await page.open()
    await expect(page.setAccount("ada")).resolves.toEqual([undefined, undefined])
    answer(page, "projects", ["p1"])
    expect(page.read("projects", day)?.value).toEqual(["p1"])
    expect(page.inspect()).toMatchObject({ account: "ada", persisted: false, storage: "memory" })
  })

  it("opens after the timeout when IndexedDB does not answer", async () => {
    const disk = createFakeDisk()
    disk.hang = true
    const page = openPage(disk, undefined, { openTimeout: 20 })
    const start = performance.now()
    await page.open()
    expect(performance.now() - start).toBeLessThan(1000)
    expect(page.inspect().storage).toBe("memory")
  })

  it("returns DEVICE_STORAGE_FAILED when the copies of the previous account cannot be deleted", async () => {
    const disk = createFakeDisk()
    await pageWithProjects(disk)
    const reload = openPage(disk)
    await reload.open()
    disk.failing = true
    const [error] = await reload.setAccount("grace")
    expect(error).toMatchObject({ code: "DEVICE_STORAGE_FAILED", docs: "https://vitehub.dev/docs/device/diagnostics/device_storage_failed" })
    expect(error?.cause).toBeInstanceOf(DOMException)
    expect(reload.inspect().persisted).toBe(false)
    const [clearError] = await reload.clear()
    expect(clearError?.code).toBe("DEVICE_STORAGE_FAILED")
  })

  it("prints DEVICE_NOT_OPEN once when the app stores an answer without openDevice()", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const page = openPage(createFakeDisk())
    answer(page, "projects", ["p1"])
    answer(page, "settings", {})
    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/^\[vitehub\] DEVICE_NOT_OPEN: /)
  })
})

describe("input checks", () => {
  it("throws for an account that is not a string or null", async () => {
    const page = openPage(createFakeDisk())
    await expect(page.setAccount("")).rejects.toMatchObject({ code: "DEVICE_INVALID_ACCOUNT" })
    // @ts-expect-error A number is not an account id.
    await expect(page.setAccount(42)).rejects.toMatchObject({ code: "DEVICE_INVALID_ACCOUNT", why: expect.stringContaining("got 42") })
  })
})
