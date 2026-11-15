import { afterEach, describe, expect, it, vi } from "vitest"

import { createFakeBrowser, createFakeDisk, openPage } from "./support.ts"

import type { DeviceEvent } from "../src/device.ts"

const day = 24 * 60 * 60 * 1000

afterEach(() => {
  vi.restoreAllMocks()
})

/** A page that opened the device and named `ada`, with one stored answer. */
async function pageWithProjects(disk = createFakeDisk(), browser = createFakeBrowser()) {
  const page = openPage(disk, browser)
  await page.open()
  await page.setAccount("ada")
  page.write("projects", [{ id: "p1", name: "Docs" }], day)
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

  it("writes nothing to the disk until the page names an account, then keeps the answers of the page", async () => {
    const disk = createFakeDisk()
    const page = openPage(disk)
    await page.open()
    page.write("projects", ["p1"], day)
    await page.settled()
    expect(disk.keys).toEqual([])
    expect(page.inspect()).toMatchObject({ account: null, persisted: false })
    expect(page.read("projects", day)?.value).toEqual(["p1"])
    await page.setAccount("ada")
    expect(disk.meta).toEqual({ account: "ada", version: "" })
    expect(disk.keys).toEqual(["projects"])
  })

  it("keeps nothing for a page that never names an account", async () => {
    const disk = createFakeDisk()
    const page = openPage(disk)
    await page.open()
    page.write("projects", ["p1"], day)
    await page.settled()
    const reload = openPage(disk)
    await reload.open()
    expect(reload.read("projects", day)).toBeUndefined()
    expect(disk.keys).toEqual([])
  })

  it("empties the device for another account, and keeps the answers that came with the new session", async () => {
    const disk = createFakeDisk()
    await pageWithProjects(disk)
    const reload = openPage(disk)
    const events: DeviceEvent[] = []
    reload.subscribe(event => events.push(event))
    await reload.open()
    // The session check answers after another read.
    reload.write("settings", { theme: "dark" }, day)
    expect(await reload.setAccount("grace")).toEqual([undefined, undefined])
    expect(events).toEqual([{ type: "load", keys: ["projects"] }, { type: "drop", keys: ["projects"] }])
    expect(reload.read("projects", day)).toBeUndefined()
    expect(reload.inspect()).toMatchObject({ account: "grace", persisted: true, entries: [{ key: "settings" }] })
    expect(disk.meta).toEqual({ account: "grace", version: "" })
    expect(disk.keys).toEqual(["settings"])
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
    expect(events).toEqual([])
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
    expect(disk.meta).toEqual({ account: "grace", version: "" })
    expect(disk.keys).toEqual([])
  })

  it("deletes every copy and writes nothing after a sign-out", async () => {
    const disk = createFakeDisk()
    const page = await pageWithProjects(disk)
    await page.setAccount(null)
    page.write("projects", ["p2"], day)
    await page.settled()
    expect(page.read("projects", day)).toBeUndefined()
    expect(page.inspect()).toMatchObject({ account: null, persisted: false, entries: [] })
    expect(disk.meta).toEqual({ account: null, version: "" })
    expect(disk.keys).toEqual([])
  })

  it("empties the device when the version changes", async () => {
    const disk = createFakeDisk()
    const first = openPage(disk)
    await first.open({ version: "1" })
    await first.setAccount("ada")
    first.write("projects", ["p1"], day)
    await first.settled()
    const next = openPage(disk)
    await next.open({ version: "2" })
    expect(next.read("projects", day)).toBeUndefined()
    await next.settled()
    expect(disk.keys).toEqual([])
    expect(disk.meta).toEqual({ account: "ada", version: "2" })
    // The account stays, so the new build keeps writing for it.
    await next.setAccount("ada")
    next.write("projects", ["p1", "p2"], day)
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
    page.write("projects", ["p1"], 7 * day)
    page.write("feed", ["f1"], day)
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
    page.write("a", "x".repeat(8), day)
    page.write("b", "x".repeat(8), day)
    page.write("c", "x".repeat(8), day)
    await page.settled()
    expect(page.inspect().entries.map(entry => entry.key)).toEqual(["b", "c"])
    expect(disk.keys).toEqual(["b", "c"])
  })

  it("does not keep a value over the size cap, or a value that JSON cannot store, and removes the older copy", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const disk = createFakeDisk()
    const page = openPage(disk, undefined, { maxBytes: 25 })
    await page.open()
    await page.setAccount("ada")
    page.write("report", "small", day)
    page.write("report", "x".repeat(40), day)
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    page.write("tree", cycle, day)
    page.write("tree", cycle, day)
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
    const dropped: DeviceEvent[] = []
    second.subscribe(event => dropped.push(event))
    expect(await first.clear()).toEqual([undefined, undefined])
    expect(dropped).toEqual([{ type: "drop", keys: ["projects"] }])
    expect(first.read("projects", day)).toBeUndefined()
    expect(second.read("projects", day)).toBeUndefined()
    expect(disk.keys).toEqual([])
    // The account stays, so the next answers are stored again.
    second.write("projects", ["p2"], day)
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
    first.write("projects", [{ id: "p1", name: "Docs" }], day)
    await first.settled()
    expect(disk.keys).toEqual([])
  })

  it("refuses a write for an account that is no longer on the disk, also without a channel between the tabs", async () => {
    const disk = createFakeDisk()
    const first = await pageWithProjects(disk)
    const second = openPage(disk)
    await second.open()
    await second.setAccount("grace")
    first.write("secrets", ["ada only"], day)
    await first.settled()
    expect(disk.meta).toEqual({ account: "grace", version: "" })
    expect(disk.keys).toEqual([])
    expect(first.inspect().persisted).toBe(false)
  })
})

describe("storage failures", () => {
  it("keeps copies in memory when IndexedDB refuses to open", async () => {
    const disk = createFakeDisk()
    disk.refuse = true
    const page = openPage(disk)
    await page.open()
    await expect(page.setAccount("ada")).resolves.toEqual([undefined, undefined])
    page.write("projects", ["p1"], day)
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
    page.write("projects", ["p1"], day)
    page.write("settings", {}, day)
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
