import { afterEach, describe, expect, it, vi } from "vitest"

import { scheduleDevHeader, scheduleDevHeaderValue } from "../src/dev.ts"
import { defineScheduleTarget, schedules } from "../src/index.ts"
import {
  handleScheduleDevRequest as handleAuthorizedScheduleDevRequest,
  inspectRuntimeSchedules,
  listRuntimeScheduleRuns,
  readScheduleConsoleRecords,
  summarizeScheduleRun,
} from "../src/runtime/console.ts"
import type { RuntimeScheduleSummary, ScheduleRunAttemptSummary, ScheduleRunSummary } from "../src/runtime/console.ts"
import type { RuntimeScheduleRecord } from "../src/types.ts"
import { nextRuntimeScheduleRunAt } from "../src/runtime/due.ts"
import { resetScheduleRuntime, setScheduleRunStore, setScheduleRuntimeRegistry, setScheduleWakeDriverActive } from "../src/runtime/state.ts"
import { createMemoryScheduleRunStore, ScheduleHistoryIncompleteError } from "../src/runtime/store.ts"

const now = new Date("2026-05-23T08:15:00.000Z")

function handleScheduleDevRequest(request: Request): Promise<Response> {
  return handleAuthorizedScheduleDevRequest(request, { authorize: async () => true })
}

interface DevResponseBody {
  attempts?: ScheduleRunAttemptSummary[]
  error?: { code?: string, message: string }
  run?: ScheduleRunSummary
  schedule?: RuntimeScheduleSummary
}

async function readBody(response: Response): Promise<DevResponseBody> {
  return await response.json() as DevResponseBody
}

function scheduleRecord(cron: string, timeZone?: string): RuntimeScheduleRecord {
  return { createdAt: now, cron, enabled: true, id: "digest", target: "report", ...(timeZone ? { timeZone } : {}), updatedAt: now }
}

function devRequest(body: unknown, init: { headers?: Record<string, string>, method?: string } = {}): Request {
  const method = init.method ?? "POST"
  return new Request("http://localhost/_vitehub/schedule/dev", {
    ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    headers: { "content-type": "application/json", [scheduleDevHeader]: scheduleDevHeaderValue, ...init.headers },
    method,
  })
}

function installTargets(handler: (input: unknown) => void = () => {}): void {
  setScheduleRuntimeRegistry({
    report: async () => defineScheduleTarget<{ prompt?: string, token?: string }>({
      handler: async context => handler(context.input),
    }),
  })
}

afterEach(() => {
  resetScheduleRuntime()
  vi.useRealTimers()
})

describe("Runtime Schedule inspection", () => {
  it.each(["enable", "disable"])("preserves the updated Schedule when %s history is incomplete", async (operation) => {
    installTargets()
    await schedules.dynamic.create({ cron: "0 9 * * *", enabled: operation !== "enable", id: "digest", target: "report" })
    const listRuns = vi.fn(() => { throw new ScheduleHistoryIncompleteError(1001, 1000) })
    setScheduleRunStore({ ...createMemoryScheduleRunStore(), listRuns })

    const response = await handleScheduleDevRequest(devRequest({ id: "digest", operation }))
    expect(response.status).toBe(503)
    expect(await readBody(response)).toMatchObject({
      error: { code: "SCHEDULE_HISTORY_INCOMPLETE" },
      schedule: { enabled: operation === "enable", id: "digest" },
    })
    expect(listRuns).toHaveBeenCalledWith({ scheduleId: "digest", runtimeOnly: true, limit: 1 })
    expect((await schedules.get("digest"))?.enabled).toBe(operation === "enable")
  })

  it.each([9, 10, 11, 12])("shows an older-run hint only when %i runs exceed the visible history", async (count) => {
    installTargets()
    await schedules.dynamic.create({ cron: "0 9 * * *", id: "digest", target: "report" })
    for (let index = 0; index < count; index++) {
      await schedules.run("digest", { scheduledAt: new Date(now.getTime() - index * 60_000) })
    }

    const record = (await readScheduleConsoleRecords())[0]!
    expect(record.fields.filter(field => /^Run \d+$/.test(field.label))).toHaveLength(Math.min(count, 10))
    expect(record.fields.find(field => field.label === "Older runs")).toEqual(count > 10
      ? { label: "Older runs", value: "More runs are available. Use `vitehub schedule runs digest`." }
      : undefined)
  })

  it("finds the next due minute in the Schedule time zone", () => {
    expect(nextRuntimeScheduleRunAt(scheduleRecord("30 9 * * *", "Europe/Copenhagen"), now)?.toISOString()).toBe("2026-05-24T07:30:00.000Z")
    expect(nextRuntimeScheduleRunAt(scheduleRecord("0 9 * * *"), now)?.toISOString()).toBe("2026-05-23T09:00:00.000Z")
    expect(nextRuntimeScheduleRunAt(scheduleRecord("0 0 30 2 *"), now)).toBeUndefined()
  })

  it("lists Runtime Schedules with next run, last run, and redacted input", async () => {
    installTargets()
    await schedules.dynamic.create({ cron: "0 9 * * *", id: "digest", input: { prompt: "Read https://bot:pw-secret@example.test/feed", token: "sk-live-secret" }, target: "report" })
    await schedules.dynamic.create({ cron: "0 10 * * *", enabled: false, id: "paused", target: "report" })
    await schedules.run("digest", { scheduledAt: new Date("2026-05-22T09:00:00.000Z") })

    const inspection = await inspectRuntimeSchedules({ now })

    expect(inspection.automaticRuns).toBe(false)
    expect(inspection.schedules.map(schedule => schedule.id)).toEqual(["digest", "paused"])
    expect(inspection.schedules[0]).toMatchObject({
      console: { dispatch: false, visible: true },
      cron: "0 9 * * *",
      enabled: true,
      input: { prompt: "Read https://[redacted]@example.test/feed", token: "[redacted]" },
      lastRun: { id: "srun_runtime_digest_2026-05-22T09:00:00.000Z", status: "succeeded" },
      nextRunAt: "2026-05-23T09:00:00.000Z",
      target: "report",
      timeZone: "UTC",
    })
    expect(inspection.schedules[1]).not.toHaveProperty("nextRunAt")
    expect(JSON.stringify(inspection)).not.toMatch(/sk-live-secret|pw-secret/)
  })

  it("lists runs newest first with a limit and redacts error messages", async () => {
    installTargets(() => {
      throw new Error("Request to https://user:hunter2@example.test failed")
    })
    await schedules.dynamic.create({ cron: "0 9 * * *", id: "digest", target: "report" })
    await schedules.run("digest", { scheduledAt: new Date("2026-05-21T09:00:00.000Z") }).catch(() => {})
    await schedules.run("digest", { scheduledAt: new Date("2026-05-22T09:00:00.000Z") }).catch(() => {})

    const runs = await listRuntimeScheduleRuns("digest", { limit: 1 })

    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ scheduledAt: "2026-05-22T09:00:00.000Z", status: "failed" })
    expect(runs[0]?.error?.message).not.toContain("hunter2")
  })

  it("redacts error names and response status text", async () => {
    installTargets(() => {
      const error = new Error("safe message")
      error.name = "Authorization: Bearer secret-name"
      throw error
    })
    await schedules.dynamic.create({ cron: "0 9 * * *", id: "digest", target: "report" })
    await schedules.run("digest", { scheduledAt: new Date("2026-05-22T09:00:00.000Z") }).catch(() => {})

    const runs = await listRuntimeScheduleRuns("digest")
    expect(runs[0]?.error?.name).toBe("Authorization: [redacted]")
    const summary = summarizeScheduleRun({
      attemptCount: 1,
      id: "run",
      createdAt: now,
      updatedAt: now,
      response: { body: { data: "", encoding: "base64", mediaType: "text/plain" }, headers: [], status: 401, statusText: "Authorization: Bearer response-secret" },
      scheduleId: "digest",
      scheduledAt: now,
      status: "succeeded",
      target: "report",
    })
    expect(summary.response?.statusText).toBe("Authorization: [redacted]")
  })

  it("reads Console records with run history and hides records that opt out", async () => {
    installTargets()
    setScheduleWakeDriverActive(true)
    await schedules.dynamic.create({ cron: "0 9 * * *", id: "digest", target: "report", timeZone: "Europe/Copenhagen" })
    await schedules.dynamic.create({ console: { enabled: false }, cron: "0 9 * * *", id: "hidden", target: "report" })
    await schedules.run("digest", { scheduledAt: new Date("2026-05-22T07:00:00.000Z") })

    const records = await readScheduleConsoleRecords()

    expect(records.map(record => record.id)).toEqual(["digest"])
    expect(records[0]?.cells).toMatchObject({
      enabled: "Enabled",
      kind: "Runtime",
      lastRun: "succeeded at 2026-05-22T07:00:00.000Z",
      schedule: "digest",
      target: "report",
      timing: "0 9 * * * (Europe/Copenhagen)",
    })
    expect(records[0]?.cells.nextRun).not.toContain("not automatic")
    expect(records[0]?.fields).toContainEqual({
      label: "Run 1",
      value: "2026-05-22T07:00:00.000Z, succeeded, 1 attempt, srun_runtime_digest_2026-05-22T07:00:00.000Z",
    })

    setScheduleWakeDriverActive(false)
    expect((await readScheduleConsoleRecords())[0]?.cells.nextRun).toMatch(/\(not automatic\)$/)
  })
})

describe("Schedule dev request handler", () => {
  it("rejects requests without the guard, from other origins, with other methods, or without JSON", async () => {
    const missingHeader = new Request("http://localhost/_vitehub/schedule/dev", {
      body: JSON.stringify({ operation: "list" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
    expect((await handleScheduleDevRequest(missingHeader)).status).toBe(403)
    expect((await handleScheduleDevRequest(devRequest({ operation: "list" }, { headers: { origin: "https://attacker.test" } }))).status).toBe(403)
    expect((await handleScheduleDevRequest(devRequest(undefined, { method: "GET" }))).status).toBe(405)
    expect((await handleScheduleDevRequest(devRequest({ operation: "list" }, { headers: { "content-type": "text/plain" } }))).status).toBe(415)
    expect((await handleScheduleDevRequest(devRequest("{"))).status).toBe(400)
    expect((await handleScheduleDevRequest(devRequest({ operation: "delete", id: "digest" }))).status).toBe(400)
    expect((await handleScheduleDevRequest(devRequest({ limit: 0, operation: "runs", id: "digest" }))).status).toBe(400)
  })

  it("runs, disables, and enables a Runtime Schedule", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(now)
    installTargets()
    await schedules.dynamic.create({ cron: "0 9 * * *", id: "digest", target: "report" })

    const run = await handleScheduleDevRequest(devRequest({ id: "digest", operation: "run" }))
    expect(run.status).toBe(200)
    expect(run.headers.get("cache-control")).toBe("no-store")
    const { run: summary } = await readBody(run)
    expect(summary).toMatchObject({ attemptCount: 1, scheduleId: "digest", status: "succeeded" })
    const runId = summary?.id

    const attempts = await readBody(await handleScheduleDevRequest(devRequest({ id: runId, operation: "attempts" })))
    expect(attempts).toMatchObject({ attempts: [{ runId, status: "succeeded" }], run: { id: runId } })

    const disabled = await readBody(await handleScheduleDevRequest(devRequest({ id: "digest", operation: "disable" })))
    expect(disabled.schedule).toMatchObject({ enabled: false, id: "digest" })
    expect(disabled.schedule).not.toHaveProperty("nextRunAt")
    const blocked = await handleScheduleDevRequest(devRequest({ id: "digest", operation: "run" }))
    expect(blocked.status).toBe(409)
    expect(await readBody(blocked)).toMatchObject({ error: { code: "SCHEDULE_DISABLED" } })

    const enabled = await readBody(await handleScheduleDevRequest(devRequest({ id: "digest", operation: "enable" })))
    expect(enabled.schedule).toMatchObject({ enabled: true, id: "digest", nextRunAt: expect.any(String) })
  })

  it("returns the stored failed run when the handler fails", async () => {
    installTargets(() => {
      const error = new Error("Bearer abc.def.ghi rejected")
      error.name = "access_token=secret-name"
      throw error
    })
    await schedules.dynamic.create({ cron: "0 9 * * *", id: "digest", target: "report" })

    const response = await handleScheduleDevRequest(devRequest({ id: "digest", operation: "run" }))

    expect(response.status).toBe(200)
    const body = await readBody(response)
    expect(body.run).toMatchObject({ scheduleId: "digest", status: "failed" })
    expect(JSON.stringify(body)).not.toContain("abc.def.ghi")
    expect(JSON.stringify(body)).not.toContain("secret-name")
  })

  it("returns a failed outer run when its handler invokes a disabled child schedule", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(now)
    setScheduleRuntimeRegistry({
      report: async () => defineScheduleTarget({ handler: async () => { await schedules.run("child") } }),
    })
    await schedules.dynamic.create({ cron: "0 9 * * *", id: "child", target: "report", enabled: false })
    await schedules.dynamic.create({ cron: "0 9 * * *", id: "digest", target: "report" })
    const failed = await handleScheduleDevRequest(devRequest({ id: "digest", operation: "run" }))
    expect(failed.status).toBe(200)
    expect(await readBody(failed)).toMatchObject({ run: { scheduleId: "digest", status: "failed" } })
    await schedules.disable("digest")
    const blocked = await handleScheduleDevRequest(devRequest({ id: "digest", operation: "run" }))
    expect(blocked.status).toBe(409)
    expect(await readBody(blocked)).toMatchObject({ error: { code: "SCHEDULE_DISABLED" } })
  })

  it("does not replay a stored handler failure after the schedule is disabled", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(now)
    installTargets(() => { throw new Error("Handler failed") })
    await schedules.dynamic.create({ cron: "0 9 * * *", id: "digest", target: "report" })
    const failed = await handleScheduleDevRequest(devRequest({ id: "digest", operation: "run" }))
    expect(failed.status).toBe(200)
    expect(await readBody(failed)).toMatchObject({ run: { status: "failed" } })
    await schedules.disable("digest")
    const blocked = await handleScheduleDevRequest(devRequest({ id: "digest", operation: "run" }))
    expect(blocked.status).toBe(409)
    expect(await readBody(blocked)).toMatchObject({ error: { code: "SCHEDULE_DISABLED" } })
  })

  it("reports missing records and a missing registry", async () => {
    expect(await readBody(await handleScheduleDevRequest(devRequest({ id: "missing", operation: "get" })))).toMatchObject({
      error: { code: "SCHEDULE_NOT_FOUND" },
    })
    expect((await handleScheduleDevRequest(devRequest({ id: "srun_missing", operation: "attempts" }))).status).toBe(404)
    expect((await handleScheduleDevRequest(devRequest({ operation: "get" }))).status).toBe(400)

    installTargets()
    await schedules.dynamic.create({ cron: "0 9 * * *", id: "digest", target: "report" })
    setScheduleRuntimeRegistry(undefined)
    const response = await handleScheduleDevRequest(devRequest({ id: "digest", operation: "run" }))
    expect(response.status).toBe(409)
    expect((await readBody(response)).error?.message).toContain("No Schedule registry is installed")
  })
})
