import { describe, expect, it, vi } from "vitest"
import { createWorkTracker } from "../src/work.ts"

function fixture() {
  let time = 0
  const records = new Map<string, unknown>()
  const store = { get: async (key: string) => records.get(key), set: async (key: string, state: unknown) => { records.set(key, state) } }
  const tracker = createWorkTracker({ store, retryMs: 100, maxRetryMs: 400, now: () => time })
  return { tracker, records, store, advance: (ms: number) => { time += ms } }
}
describe("work checkpoints", () => {
  it("parks unchanged work and admits a new fingerprint", async () => {
    const { tracker } = fixture()
    expect(await tracker.run("a", "v1", async () => ({ disposition: "park" }))).toBe(true)
    expect(await tracker.eligible("a", "v1")).toBe(false)
    expect(await tracker.eligible("a", "v2")).toBe(true)
  })
  it("does not trust inherited checkpoint fields", async () => {
    const { tracker, records } = fixture()
    records.set("a", Object.create({ version: 1, fingerprint: "v1", disposition: "park", attempt: 0 }))
    const run = vi.fn(async () => ({ disposition: "park" as const }))

    expect(await tracker.run("a", "v1", run)).toBe(true)
    expect(run).toHaveBeenCalledOnce()
  })
  it("does not trust inherited descriptor values", async () => {
    const { tracker, records } = fixture()
    const record = { fingerprint: "v1", disposition: "park", attempt: 0 }
    Object.defineProperty(record, "version", { get: () => 1, enumerable: true })
    records.set("a", record)
    const run = vi.fn(async () => ({ disposition: "park" as const }))
    const polluted = Object.prototype as Record<string, unknown>
    polluted.value = 1
    try {
      const result = await tracker.run("a", "v1", run)
      delete polluted.value
      expect(result).toBe(true)
      expect(run).toHaveBeenCalledOnce()
    }
    finally {
      delete polluted.value
    }
  })
  it.each(["version", "metadata"])("rejects an accessor on %s without invoking it", async (key) => {
    const { tracker, records } = fixture()
    const record = { version: 1, fingerprint: "v1", disposition: "park", attempt: 0 }
    const getter = vi.fn(() => {
      record.fingerprint = "mutated"
      throw new Error("checkpoint getter executed")
    })
    Object.defineProperty(record, key, { get: getter, enumerable: true })
    records.set("a", record)
    const run = vi.fn(async () => ({ disposition: "park" as const }))

    expect(await tracker.eligible("a", "v1")).toBe(true)
    expect(await tracker.run("a", "v1", run)).toBe(true)
    expect(run).toHaveBeenCalledOnce()
    expect(getter).not.toHaveBeenCalled()
    expect(record.fingerprint).toBe("v1")
  })
  it("rejects nested checkpoint data without traversing its accessors", async () => {
    const { tracker, records } = fixture()
    const getter = vi.fn(() => { throw new Error("nested checkpoint getter executed") })
    const metadata = Object.defineProperty({}, "detail", { get: getter, enumerable: true })
    records.set("a", { version: 1, fingerprint: "v1", disposition: "park", attempt: 0, metadata })
    const run = vi.fn(async () => ({ disposition: "park" as const }))

    expect(await tracker.eligible("a", "v1")).toBe(true)
    expect(await tracker.run("a", "v1", run)).toBe(true)
    expect(run).toHaveBeenCalledOnce()
    expect(getter).not.toHaveBeenCalled()
  })
  it("does not trust proxy-fabricated checkpoint descriptors", async () => {
    const { tracker, records } = fixture()
    const fabricated: Record<string, unknown> = { version: 1, fingerprint: "v1", disposition: "park", attempt: 0 }
    records.set("a", new Proxy({}, {
      getOwnPropertyDescriptor: (_target, key) => ({ value: fabricated[String(key)], enumerable: true, configurable: true, writable: true }),
      ownKeys: () => Object.keys(fabricated),
    }))
    const run = vi.fn(async () => ({ disposition: "park" as const }))

    expect(await tracker.run("a", "v1", run)).toBe(true)
    expect(run).toHaveBeenCalledOnce()
  })
  it("does not invoke checkpoint accessors", async () => {
    const { tracker, records } = fixture()
    const getter = vi.fn(() => 1)
    const record = { fingerprint: "v1", disposition: "park", attempt: 0 }
    Object.defineProperty(record, "version", { enumerable: true, get: getter })
    records.set("a", record)
    const run = vi.fn(async () => ({ disposition: "park" as const }))

    expect(await tracker.run("a", "v1", run)).toBe(true)
    expect(getter).not.toHaveBeenCalled()
    expect(run).toHaveBeenCalledOnce()
  })
  it("parks the new version produced by a repair", async () => {
    const { tracker } = fixture()
    await tracker.run("a", "v1", async () => ({ disposition: "park", fingerprint: "v2" }))
    expect(await tracker.eligible("a", "v2")).toBe(false)
  })
  it("cools down exceptions and increases bounded retry delays", async () => {
    const { tracker, records, advance } = fixture()
    const fail = async (): Promise<never> => { throw new Error("checkout unavailable") }
    await expect(tracker.run("a", "v1", fail)).rejects.toThrow("checkout unavailable")
    expect(tracker.active).toBe(0)
    expect(await tracker.eligible("a", "v1")).toBe(false)
    advance(100)
    await expect(tracker.run("a", "v1", fail)).rejects.toThrow()
    expect(records.get("a")).toMatchObject({ attempt: 2, retryAt: 300 })
    expect(await tracker.eligible("a", "v2")).toBe(true)
  })
  it("keeps a local cooldown when persistence fails", async () => {
    const { tracker, store } = fixture()
    store.set = async () => { throw new Error("disk unavailable") }
    await expect(tracker.run("a", "v1", async () => { throw new Error("provider unavailable") })).rejects.toThrow("could not be persisted")
    expect(await tracker.eligible("a", "v1")).toBe(false)
    expect(tracker.active).toBe(0)
  })
  it.each([
    { version: 1, fingerprint: "v1", disposition: "park", attempt: 0 },
    { version: 1, fingerprint: "v1", disposition: "retry", attempt: 8, retryAt: 400 },
  ])("preserves $disposition state when the checkpoint read fails", async (state) => {
    const { tracker, records, store } = fixture()
    records.set("a", state)
    const error = new Error("read unavailable")
    const get = vi.spyOn(store, "get").mockRejectedValueOnce(error)
    const set = vi.spyOn(store, "set")
    const run = vi.fn(async () => ({ disposition: "park" as const }))

    await expect(tracker.run("a", "v1", run)).rejects.toBe(error)
    expect(run).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
    expect(records.get("a")).toBe(state)
    expect(tracker.active).toBe(0)
    expect(tracker.has("a")).toBe(false)
    expect(await tracker.run("a", "v1", run)).toBe(false)
    expect(get).toHaveBeenCalledTimes(2)
    expect(run).not.toHaveBeenCalled()
  })
  it("excludes concurrent owners and releases after completion", async () => {
    const { tracker } = fixture()
    let release!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    const first = tracker.run("a", "v1", async () => { await waiting; return { disposition: "park" } })
    expect(await tracker.run("a", "v1", async () => ({ disposition: "retry" }))).toBe(false)
    release()
    await first
    expect(tracker.active).toBe(0)
  })
  it("retains cooldown after restart", async () => {
    const { tracker, store } = fixture()
    await tracker.run("a", "v1", async () => ({ disposition: "retry" }))
    const restarted = createWorkTracker({ store, now: () => 50 })
    expect(await restarted.eligible("a", "v1")).toBe(false)
  })
  it("cools down the repaired version when its checkpoint write fails", async () => {
    const { tracker, store } = fixture()
    store.set = async () => { throw new Error("disk unavailable") }
    await expect(tracker.run("a", "v1", async () => ({ disposition: "park", fingerprint: "v2" }))).rejects.toThrow()
    expect(await tracker.eligible("a", "v2")).toBe(false)
  })

})
