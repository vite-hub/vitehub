import { describe, expect, it } from "vitest"
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
