import { afterEach, describe, expect, it, vi } from "vitest"

import { createOperationRegistry, operationCliPath, runOperation } from "@vite-hub/internal/operations"

import { defineSchedule } from "../src/index.ts"
import { scheduleOperations } from "../src/operations.ts"
import { executeStaticSchedule } from "../src/runtime/execute.ts"
import { summarizeScheduleRun } from "../src/runtime/operations.ts"
import { resetScheduleRuntime, setScheduleRunStore } from "../src/runtime/state.ts"
import { createMemoryScheduleRunStore, ScheduleHistoryIncompleteError } from "../src/runtime/store.ts"

import type { OperationAccess } from "@vite-hub/internal/operations"
import type { ScheduleHandler } from "../src/types.ts"

const now = new Date("2026-05-23T08:15:00.000Z")
const registry = createOperationRegistry([{ operations: scheduleOperations }])

async function call(name: string, input: unknown, access: OperationAccess = { mode: "local", sections: "all" }) {
  return await runOperation(registry, `schedule.${name}`, input, { access, surface: "cli", user: null })
}

async function runDigest(scheduledAt: Date, handler: ScheduleHandler = () => {}): Promise<void> {
  await executeStaticSchedule({ cron: "0 9 * * *", definition: { cron: "0 9 * * *", handler }, name: "digest", scheduledAt }).catch(() => {})
}

/** The registry that the Console installs: only the definitions that set `manual: true`. */
function installRegistry(value: Record<string, () => Promise<unknown>>): void {
  Reflect.set(globalThis, Symbol.for("vitehub.console.schedules"), value)
}

afterEach(() => {
  resetScheduleRuntime()
  Reflect.deleteProperty(globalThis, Symbol.for("vitehub.console.schedules"))
  vi.useRealTimers()
})

describe("schedule operations", () => {
  it("are the `vitehub schedule` commands of the Schedules section", () => {
    expect(scheduleOperations.map(operation => [operation.name, operation.kind, operation.section, operationCliPath(operation)])).toEqual([
      ["schedule.runs", "read", "schedules", { command: "runs", namespace: "schedule" }],
      ["schedule.attempts", "read", "schedules", { command: "attempts", namespace: "schedule" }],
      ["schedule.run", "write", "schedules", { command: "run", namespace: "schedule" }],
    ])
  })

  it("lets `schedule run --url` sign a dispatch, and only that operation runs app code", () => {
    expect(scheduleOperations.find(operation => operation.name === "schedule.run")?.cli?.dispatch).toBe("/_vitehub/schedules/run")
    expect(scheduleOperations.filter(operation => operation.invoke).map(operation => operation.name)).toEqual(["schedule.run"])
  })

  it("list runs newest first with a limit and redact error messages", async () => {
    const handler = () => {
      throw new Error("Request to https://user:hunter2@example.test failed")
    }
    await runDigest(new Date("2026-05-21T09:00:00.000Z"), handler)
    await runDigest(new Date("2026-05-22T09:00:00.000Z"), handler)

    const result = await call("runs", { id: "digest", limit: 1 })

    expect(result).toMatchObject({ ok: true, value: { runs: [{ scheduledAt: "2026-05-22T09:00:00.000Z", status: "failed" }] } })
    expect(JSON.stringify(result)).not.toContain("hunter2")
    expect(await call("runs", { id: "digest", limit: 0 })).toMatchObject({ ok: false, status: 400 })
    expect(await call("runs", { id: "digest", limit: 101 })).toMatchObject({ ok: false, status: 400 })
    expect(await call("runs", { id: "digest", limit: 100 })).toMatchObject({ ok: true })
    expect(await call("runs", {})).toMatchObject({ ok: false, status: 400 })
  })

  it("limits omitted run queries to the newest 100 records before reading the store", async () => {
    const store = createMemoryScheduleRunStore()
    const listRuns = vi.spyOn(store, "listRuns")
    setScheduleRunStore(store)
    for (let index = 0; index < 101; index++) {
      await runDigest(new Date(now.getTime() + index * 86_400_000))
    }

    const result = await call("runs", { id: "digest" })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("Expected runs.")
    const runs = (result.value as { runs: Array<{ scheduledAt: string }> }).runs
    expect(runs).toHaveLength(100)
    expect(runs[0]?.scheduledAt).toBe(new Date(now.getTime() + 100 * 86_400_000).toISOString())
    expect(runs.at(-1)?.scheduledAt).toBe(new Date(now.getTime() + 86_400_000).toISOString())
    expect(listRuns).toHaveBeenCalledWith({ scheduleId: "digest", limit: 100 })
  })

  it("redact error names and response status text", async () => {
    await runDigest(new Date("2026-05-22T09:00:00.000Z"), () => {
      const error = new Error("safe message")
      error.name = "Authorization: Bearer secret-name"
      throw error
    })

    const result = await call("runs", { id: "digest" })
    expect(result).toMatchObject({ ok: true, value: { runs: [{ error: { name: "Authorization: [redacted]" } }] } })
    const summary = summarizeScheduleRun({
      attemptCount: 1,
      id: "run",
      createdAt: now,
      updatedAt: now,
      response: { body: { data: "", encoding: "base64", mediaType: "text/plain" }, headers: [], status: 401, statusText: "Authorization: Bearer response-secret" },
      scheduleId: "digest",
      scheduledAt: now,
      status: "succeeded",
      target: "digest",
    })
    expect(summary.response?.statusText).toBe("Authorization: [redacted]")
  })

  it("list the attempts of one run, and say when the run is unknown", async () => {
    await runDigest(new Date("2026-05-22T09:00:00.000Z"))
    const runs = await call("runs", { id: "digest" })
    if (!runs.ok) throw new Error("Expected runs.")
    const runId = (runs.value as { runs: Array<{ id: string }> }).runs[0]!.id

    expect(await call("attempts", { id: runId })).toMatchObject({ ok: true, value: { attempts: [{ runId, status: "succeeded" }], run: { id: runId } } })
    expect(await call("attempts", { id: "srun_missing" })).toMatchObject({ code: "SCHEDULE_RUN_NOT_FOUND", fix: expect.any(String), ok: false, status: 404 })
  })

  it("report incomplete history as 503", async () => {
    const listRuns = vi.fn(() => { throw new ScheduleHistoryIncompleteError(1001, 1000) })
    setScheduleRunStore({ ...createMemoryScheduleRunStore(), listRuns })

    expect(await call("runs", { id: "digest" })).toMatchObject({ code: "SCHEDULE_HISTORY_INCOMPLETE", ok: false, status: 503 })
    expect(listRuns).toHaveBeenCalledWith({ scheduleId: "digest", limit: 100 })
  })

  it("run a manual Static Schedule Definition from the installed registry and record the run", async () => {
    const effect = vi.fn()
    installRegistry({
      fail: async () => defineSchedule("0 9 * * *", () => { throw new Error("Bearer abc.def.ghi rejected") }, { manual: true }),
      locked: async () => defineSchedule("0 9 * * *", effect),
      sync: async () => ({ default: defineSchedule("0 9 * * *", effect, { manual: true }) }),
    })

    const succeeded = await call("run", { name: "sync" })
    expect(succeeded).toMatchObject({ ok: true, value: { run: { completedAt: expect.any(String), id: expect.stringMatching(/^srun_manual_sync_/), scheduleId: "sync", startedAt: expect.any(String), status: "succeeded" } } })
    expect(effect).toHaveBeenCalledTimes(1)
    expect(await call("runs", { id: "sync" })).toMatchObject({ ok: true, value: { runs: [{ status: "succeeded" }] } })

    const failed = await call("run", { name: "fail" })
    expect(failed).toMatchObject({ ok: true, value: { run: { error: { message: "Bearer [redacted] rejected" }, status: "failed" } } })
    expect(JSON.stringify(failed)).not.toContain("abc.def.ghi")

    expect(await call("run", { name: "locked" })).toMatchObject({ code: "SCHEDULE_MANUAL_RUN_DISABLED", ok: false, status: 403 })
    expect(await call("run", { name: "missing" })).toMatchObject({ code: "SCHEDULE_DEFINITION_NOT_FOUND", ok: false, status: 404 })
    expect(effect).toHaveBeenCalledTimes(1)
  })

  it("do not run anything when Console invocation installed no registry", async () => {
    expect(await call("run", { name: "sync" })).toMatchObject({
      code: "SCHEDULE_DEFINITION_NOT_FOUND",
      fix: expect.stringContaining("console.invoke"),
      ok: false,
      status: 404,
    })
  })

  it("let a read-only grant read runs but not run a Schedule", async () => {
    const effect = vi.fn()
    installRegistry({ sync: async () => defineSchedule("0 9 * * *", effect, { manual: true }) })
    const readOnly: OperationAccess = { mode: "cloudflare-access", sections: ["schedules:read"] }

    expect(await call("runs", { id: "sync" }, readOnly)).toMatchObject({ ok: true })
    expect(await call("attempts", { id: "srun_missing" }, readOnly)).toMatchObject({ code: "SCHEDULE_RUN_NOT_FOUND", ok: false })
    expect(await call("run", { name: "sync" }, readOnly)).toMatchObject({ ok: false, status: 403 })
    expect(await call("runs", { id: "sync" }, { mode: "cloudflare-access", sections: ["kv"] })).toMatchObject({ ok: false, status: 403 })
    expect(effect).not.toHaveBeenCalled()
    expect(await call("run", { name: "sync" }, { mode: "cloudflare-access", sections: ["schedules"] })).toMatchObject({ ok: true })
    expect(effect).toHaveBeenCalledTimes(1)
  })
})
