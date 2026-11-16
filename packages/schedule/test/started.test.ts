import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { afterEach, describe, expect, it, vi } from "vitest"

import { defineSchedule } from "../src/definition.ts"
import { discoverScheduleDefinitions, discoverStartableScheduleDefinitions } from "../src/discovery.ts"
import { scheduleIdempotencyKey } from "../src/runtime/date.ts"
import { getScheduleRunStore, resetScheduleRuntime } from "../src/runtime/state.ts"
import { createMemoryStartedScheduleStore, installStartedSchedules, runStartedSchedules } from "../src/runtime/started.ts"
import { cancelSchedule, getSchedule, listSchedules, startSchedule } from "../src/started.ts"

import type { ScheduleRunContext } from "../src/types.ts"

const directories: string[] = []

afterEach(async () => {
  resetScheduleRuntime()
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

async function createTempDir(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  directories.push(dir)
  return dir
}

function tick(scheduledAt: Date): Promise<void> {
  return runStartedSchedules({ id: "tick", idempotencyKey: scheduleIdempotencyKey("vitehub/started-schedules", scheduledAt), scheduledAt, waitUntil: () => {} })
}

function installReminder() {
  const calls: ScheduleRunContext[] = []
  const reminder = defineSchedule({ handler: (context) => { calls.push(context) } })
  installStartedSchedules({ registry: { reminder: async () => ({ default: reminder }) }, store: createMemoryStartedScheduleStore() })
  return calls
}

describe("defineSchedule without cron", () => {
  it("returns a Definition that only startSchedule() runs", () => {
    const definition = defineSchedule({ handler: () => {}, manual: true })
    expect(Object.hasOwn(definition, "cron")).toBe(false)
    expect(definition.options).toEqual({ manual: true })
  })

  it("rejects timeZone, which belongs to startSchedule() then", () => {
    expect(() => defineSchedule({ handler: () => {}, timeZone: "Europe/Madrid" })).toThrow(/timeZone needs a cron/)
  })
})

describe("discovery of Definitions without cron", () => {
  it("lists them apart and adds the tick Schedule that wakes them each minute", async () => {
    const rootDir = await createTempDir("vitehub-schedule-started-")
    await mkdir(join(rootDir, "server", "schedules"), { recursive: true })
    await writeFile(join(rootDir, "server", "schedules", "reminder.ts"), "export default defineSchedule({ handler: () => {} })\n")
    await writeFile(join(rootDir, "server", "schedules", "daily.ts"), "export default defineSchedule({ cron: '0 8 * * *', handler: () => {} })\n")

    const definitions = discoverScheduleDefinitions({ rootDir })
    expect(definitions.map(definition => definition.name)).toEqual(["daily", "vitehub/started-schedules"])
    const tickFile = definitions[1]!.handler
    expect(tickFile).toBe(join(rootDir, ".vitehub", "schedule-started", "tick.mjs"))
    expect(definitions[1]).toMatchObject({ contributor: "@vite-hub/schedule", manual: true, source: "vite-plugin-contribution" })
    expect(await readFile(tickFile, "utf8")).toContain("export default defineSchedule({ cron: \"* * * * *\", handler: runStartedSchedules, manual: true })")

    expect(discoverStartableScheduleDefinitions({ rootDir })).toMatchObject([{ name: "reminder", startable: true }])
  })

  it("adds no tick when every Definition has a cron", async () => {
    const rootDir = await createTempDir("vitehub-schedule-started-none-")
    await mkdir(join(rootDir, "server", "schedules"), { recursive: true })
    await writeFile(join(rootDir, "server", "schedules", "daily.ts"), "export default defineSchedule({ cron: '0 8 * * *', handler: () => {} })\n")

    expect(discoverScheduleDefinitions({ rootDir }).map(definition => definition.name)).toEqual(["daily"])
    expect(discoverStartableScheduleDefinitions({ rootDir })).toEqual([])
  })
})

describe("startSchedule()", () => {
  it("returns SCHEDULE_STORE_MISSING when the server installed no store", async () => {
    const [error] = await startSchedule("reminder", { at: new Date() })
    expect(error?.code).toBe("SCHEDULE_STORE_MISSING")
  })

  it("returns an error for a name without a Definition and for invalid options", async () => {
    installReminder()
    expect((await startSchedule("daily", { at: new Date() }))[0]?.code).toBe("SCHEDULE_NOT_STARTABLE")
    // @ts-expect-error at and cron are exclusive.
    expect((await startSchedule("reminder", { at: new Date(), cron: "* * * * *" }))[0]?.why).toMatch(/not both/)
    expect((await startSchedule("reminder", { cron: "* * *" }))[0]?.code).toBe("SCHEDULE_INVALID_OPTIONS")
    expect((await startSchedule("reminder", { cron: "0 9 * * *", timeZone: "+01:00" }))[0]?.why).toMatch(/IANA/)
    expect((await startSchedule("reminder", { at: "2026-11-08T09:00:00" }))[0]?.why).toMatch(/time zone/)
    expect((await startSchedule("reminder", { at: new Date(), payload: 1n }))[0]?.why).toMatch(/JSON/)
    expect((await listSchedules())[1]).toEqual([])
  })

  it.each([
    { value: undefined }, { value: NaN }, { value: Infinity },
    { value: () => {} }, { value: Symbol("value") },
    [undefined], Array(1), new Date(), new Map(), new Set(), 1n, NaN, Infinity,
  ].map(payload => ({ payload })))("rejects non-JSON payload %# without storing it", async ({ payload }) => {
    installReminder()
    const [error] = await startSchedule("reminder", { at: new Date(), payload })
    expect(error?.code).toBe("SCHEDULE_INVALID_OPTIONS")
    expect((await listSchedules())[1]).toEqual([])
  })

  it("accepts nested JSON and shared values, but rejects cycles", async () => {
    installReminder()
    const shared = { value: [null, true, false, 1, "text"] }
    const payload = { left: shared, right: shared }
    const [error, schedule] = await startSchedule("reminder", { at: new Date(), payload })
    expect(error).toBeUndefined()
    expect(schedule?.payload).toEqual(payload)
    expect(schedule?.payload).not.toBe(payload)
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    expect((await startSchedule("reminder", { at: new Date(), payload: cycle }))[0]?.code).toBe("SCHEDULE_INVALID_OPTIONS")
  })

  it.each(["list", "load"] as const)("catches up a minute after a transient %s failure without repeating successful runs", async (failure) => {
    const calls: string[] = []
    const store = createMemoryStartedScheduleStore()
    const reminder = defineSchedule({ handler: ({ scheduledAt }) => { calls.push(scheduledAt.toISOString()) } })
    const load = vi.fn(async () => reminder)
    installStartedSchedules({ catchUpMs: 3_600_000, registry: { reminder: load }, store })
    vi.useFakeTimers({ now: new Date("2026-11-08T08:58:00Z"), toFake: ["Date"] })
    await startSchedule("reminder", { cron: "0 9 * * *" })
    vi.useRealTimers()
    await tick(new Date("2026-11-08T08:59:00Z"))
    const error = new Error("temporary failure")
    if (failure === "list") vi.spyOn(store, "list").mockRejectedValueOnce(error)
    else load.mockRejectedValueOnce(error)
    vi.spyOn(console, "error").mockImplementation(() => {})
    const failed = tick(new Date("2026-11-08T09:00:00Z"))
    if (failure === "list") await expect(failed).rejects.toThrow("temporary failure")
    else await failed
    await tick(new Date("2026-11-08T09:01:00Z"))
    await tick(new Date("2026-11-08T09:02:00Z"))
    expect(calls).toEqual(["2026-11-08T09:00:00.000Z"])
  })

  it("runs a one-time Schedule once at `at` with its payload, then removes it", async () => {
    const calls = installReminder()
    const [error, schedule] = await startSchedule("reminder", { at: "2026-11-08T09:00:00Z", payload: { text: "Call Ana" } })
    expect(error).toBeUndefined()
    expect(schedule).toMatchObject({ at: new Date("2026-11-08T09:00:00Z"), payload: { text: "Call Ana" }, name: "reminder" })

    await tick(new Date("2026-11-08T08:59:00Z"))
    expect(calls).toHaveLength(0)
    await tick(new Date("2026-11-08T09:00:00Z"))
    await tick(new Date("2026-11-08T09:01:00Z"))
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ idempotencyKey: `schedule:${schedule!.id}:2026-11-08T09:00:00.000Z`, payload: { text: "Call Ana" }, scheduleId: schedule!.id, scheduledAt: new Date("2026-11-08T09:00:00Z"), target: "reminder" })

    expect((await getSchedule(schedule!.id))[0]?.code).toBe("SCHEDULE_NOT_FOUND")
    const runs = await getScheduleRunStore().listRuns({ scheduleId: schedule!.id })
    expect(runs.map(run => [run.id, run.status])).toEqual([[`srun_started_${schedule!.id}_2026-11-08T09:00:00.000Z`, "succeeded"]])
  })

  it("runs a cron Schedule in its time zone until it is cancelled", async () => {
    const calls = installReminder()
    vi.useFakeTimers({ now: new Date("2026-07-14T12:00:00Z"), toFake: ["Date"] })
    const [, schedule] = await startSchedule("reminder", { cron: "0 9 * * *", timeZone: "Europe/Madrid" })
    vi.useRealTimers()

    // 09:00 in Madrid is 07:00 UTC in summer.
    await tick(new Date("2026-07-15T06:00:00Z"))
    await tick(new Date("2026-07-15T07:00:00Z"))
    expect(calls.map(call => call.scheduledAt.toISOString())).toEqual(["2026-07-15T07:00:00.000Z"])

    const [, cancelled] = await cancelSchedule(schedule!.id)
    expect(cancelled?.id).toBe(schedule!.id)
    await tick(new Date("2026-07-16T07:00:00Z"))
    expect(calls).toHaveLength(1)
    expect((await cancelSchedule(schedule!.id))[0]?.code).toBe("SCHEDULE_NOT_FOUND")
  })

  it("records a failed handler as a failed run and does not fail the tick", async () => {
    const failing = defineSchedule({ handler: () => { throw new Error("boom") } })
    installStartedSchedules({ registry: { failing: async () => failing }, store: createMemoryStartedScheduleStore() })
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    const [, schedule] = await startSchedule("failing", { at: "2026-11-08T09:00:00Z" })

    await expect(tick(new Date("2026-11-08T09:00:00Z"))).resolves.toBeUndefined()
    const [run] = await getScheduleRunStore().listRuns({ scheduleId: schedule!.id })
    expect(run).toMatchObject({ error: { message: "boom" }, status: "failed" })
    expect(log).not.toHaveBeenCalled()
  })
})

const execFileAsync = promisify(execFile)
const runtimeEntry = fileURLToPath(new URL("../dist/runtime.js", import.meta.url))
const rootEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url))

// One process starts the Schedules and exits. A second process, a new Node.js process with the same store directory,
// runs them. The store is a directory of JSON files, as a file-backed KV driver keeps it.
const restartScript = `
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
const [runtimeEntry, rootEntry, storeDir, phase, now] = process.argv.slice(2)
const runtime = await import(runtimeEntry)
const root = await import(rootEntry)
const file = key => join(storeDir, encodeURIComponent(key))
const kvStore = {
  async delete(key) { await rm(file(key), { force: true }) },
  async get(key) { try { return JSON.parse(await readFile(file(key), "utf8")) } catch { return undefined } },
  async has(key) { return (await readdir(storeDir)).includes(encodeURIComponent(key)) },
  async keys(base) { return (await readdir(storeDir)).map(decodeURIComponent).filter(key => key.startsWith(base)) },
  async set(key, value) { await writeFile(file(key), JSON.stringify(value)) },
}
await mkdir(storeDir, { recursive: true })
const ran = []
const reminder = root.defineSchedule({ handler: context => { ran.push({ payload: context.payload, scheduledAt: context.scheduledAt.toISOString() }) } })
runtime.setScheduleRunStore(runtime.createKVScheduleRunStore({ kvStore }))
runtime.installStartedSchedules({ catchUpMs: 3_600_000, registry: { reminder: async () => reminder }, store: runtime.createKVStartedScheduleStore({ kvStore }) })
if (phase === "start") {
  const [error, once] = await root.startSchedule("reminder", { at: new Date(Date.parse(now) + 60_000), payload: "once" })
  const [error2, every] = await root.startSchedule("reminder", { cron: "* * * * *", payload: "every minute" })
  if (error || error2) throw error ?? error2
  console.log(JSON.stringify({ every: every.id, once: once.id }))
}
else {
  await runtime.runStartedSchedules({ id: "tick", idempotencyKey: "schedule:vitehub/started-schedules:" + new Date(now).toISOString(), scheduledAt: new Date(now), waitUntil: () => {} })
  const [, left] = await root.listSchedules()
  console.log(JSON.stringify({ left: left.map(schedule => schedule.payload), ran }))
}
`

describe("started Schedules across a process restart", () => {
  it("keep their store, run when due in the next process, and catch up minutes that no process checked", async () => {
    const dir = await createTempDir("vitehub-schedule-restart-")
    const script = join(dir, "restart.mjs")
    await writeFile(script, restartScript)
    const storeDir = join(dir, "kv")
    const node = (phase: string, now: string) => execFileAsync(process.execPath, [script, runtimeEntry, rootEntry, storeDir, phase, now])

    const now = new Date(Math.floor(Date.now() / 60_000) * 60_000)
    await node("start", now.toISOString())
    // The first process exits. The next one starts two minutes later.
    const later = new Date(now.getTime() + 2 * 60_000)
    const { stdout } = await node("tick", later.toISOString())
    const result = JSON.parse(stdout) as { left: unknown[], ran: Array<{ payload: unknown, scheduledAt: string }> }

    expect(result.ran.filter(run => run.payload === "once")).toHaveLength(1)
    // The cron Schedule runs the minute after it started and the current minute: the first of them no process checked.
    expect(result.ran.filter(run => run.payload === "every minute").map(run => run.scheduledAt).sort()).toEqual([
      new Date(now.getTime() + 60_000).toISOString(),
      later.toISOString(),
    ])
    expect(result.left).toEqual(["every minute"])
  })
})
