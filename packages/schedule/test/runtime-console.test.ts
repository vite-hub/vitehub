import { afterEach, describe, expect, it, vi } from "vitest"

import { scheduleDevHeader, scheduleDevHeaderValue } from "../src/dev.ts"
import { defineSchedule } from "../src/index.ts"
import { executeStaticSchedule } from "../src/runtime/execute.ts"
import {
  handleScheduleDevRequest as handleAuthorizedScheduleDevRequest,
  listScheduleRuns,
  summarizeScheduleRun,
} from "../src/runtime/console.ts"
import type { ScheduleRunAttemptSummary, ScheduleRunSummary } from "../src/runtime/console.ts"
import { resetScheduleRuntime, setScheduleRunStore } from "../src/runtime/state.ts"
import { createMemoryScheduleRunStore, ScheduleHistoryIncompleteError } from "../src/runtime/store.ts"

import type { ScheduleHandler } from "../src/types.ts"

const now = new Date("2026-05-23T08:15:00.000Z")

function handleScheduleDevRequest(request: Request): Promise<Response> {
  return handleAuthorizedScheduleDevRequest(request, { authorize: async () => true })
}

interface DevResponseBody {
  attempts?: ScheduleRunAttemptSummary[]
  error?: { code?: string, message: string }
  run?: ScheduleRunSummary
  runs?: ScheduleRunSummary[]
}

async function readBody(response: Response): Promise<DevResponseBody> {
  return await response.json() as DevResponseBody
}

function devRequest(body: unknown, init: { headers?: Record<string, string>, method?: string } = {}): Request {
  const method = init.method ?? "POST"
  return new Request("http://localhost/_vitehub/schedule/dev", {
    ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    headers: { "content-type": "application/json", [scheduleDevHeader]: scheduleDevHeaderValue, ...init.headers },
    method,
  })
}

async function runDigest(scheduledAt: Date, handler: ScheduleHandler = () => {}): Promise<void> {
  await executeStaticSchedule({ cron: "0 9 * * *", definition: { cron: "0 9 * * *", handler }, name: "digest", scheduledAt }).catch(() => {})
}

afterEach(() => {
  resetScheduleRuntime()
  vi.useRealTimers()
})

describe("Schedule Run inspection", () => {
  it("lists runs newest first with a limit and redacts error messages", async () => {
    const handler = () => {
      throw new Error("Request to https://user:hunter2@example.test failed")
    }
    await runDigest(new Date("2026-05-21T09:00:00.000Z"), handler)
    await runDigest(new Date("2026-05-22T09:00:00.000Z"), handler)

    const runs = await listScheduleRuns("digest", { limit: 1 })

    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ scheduledAt: "2026-05-22T09:00:00.000Z", status: "failed" })
    expect(runs[0]?.error?.message).not.toContain("hunter2")
  })

  it("redacts error names and response status text", async () => {
    await runDigest(new Date("2026-05-22T09:00:00.000Z"), () => {
      const error = new Error("safe message")
      error.name = "Authorization: Bearer secret-name"
      throw error
    })

    const runs = await listScheduleRuns("digest")
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
      target: "digest",
    })
    expect(summary.response?.statusText).toBe("Authorization: [redacted]")
  })
})

describe("Schedule dev request handler", () => {
  it("rejects requests without the guard, from other origins, with other methods, or without JSON", async () => {
    const missingHeader = new Request("http://localhost/_vitehub/schedule/dev", {
      body: JSON.stringify({ operation: "runs", id: "digest" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
    expect((await handleScheduleDevRequest(missingHeader)).status).toBe(403)
    expect((await handleScheduleDevRequest(devRequest({ operation: "runs", id: "digest" }, { headers: { origin: "https://attacker.test" } }))).status).toBe(403)
    expect((await handleScheduleDevRequest(devRequest(undefined, { method: "GET" }))).status).toBe(405)
    expect((await handleScheduleDevRequest(devRequest({ operation: "runs", id: "digest" }, { headers: { "content-type": "text/plain" } }))).status).toBe(415)
    expect((await handleScheduleDevRequest(devRequest("{"))).status).toBe(400)
    expect((await handleScheduleDevRequest(devRequest({ operation: "delete", id: "digest" }))).status).toBe(400)
    for (const operation of ["list", "get", "run", "enable", "disable"]) {
      expect((await handleScheduleDevRequest(devRequest({ operation, id: "digest" }))).status).toBe(400)
    }
    expect((await handleScheduleDevRequest(devRequest({ limit: 0, operation: "runs", id: "digest" }))).status).toBe(400)
  })

  it("lists runs and the attempts of one run", async () => {
    await runDigest(new Date("2026-05-22T09:00:00.000Z"))

    const response = await handleScheduleDevRequest(devRequest({ id: "digest", operation: "runs" }))
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    const { runs } = await readBody(response)
    expect(runs).toMatchObject([{ attemptCount: 1, scheduleId: "digest", status: "succeeded" }])
    const runId = runs?.[0]?.id

    const attempts = await readBody(await handleScheduleDevRequest(devRequest({ id: runId, operation: "attempts" })))
    expect(attempts).toMatchObject({ attempts: [{ runId, status: "succeeded" }], run: { id: runId } })
  })

  it("reports incomplete history", async () => {
    const listRuns = vi.fn(() => { throw new ScheduleHistoryIncompleteError(1001, 1000) })
    setScheduleRunStore({ ...createMemoryScheduleRunStore(), listRuns })

    const response = await handleScheduleDevRequest(devRequest({ id: "digest", operation: "runs" }))
    expect(response.status).toBe(503)
    expect(await readBody(response)).toMatchObject({ error: { code: "SCHEDULE_HISTORY_INCOMPLETE" } })
    expect(listRuns).toHaveBeenCalledWith({ scheduleId: "digest" })
  })

  it("reports missing records and missing ids", async () => {
    expect((await handleScheduleDevRequest(devRequest({ id: "srun_missing", operation: "attempts" }))).status).toBe(404)
    expect((await handleScheduleDevRequest(devRequest({ operation: "runs" }))).status).toBe(400)
  })

  it("runs a manual Static Schedule Definition from the registry and records the run", async () => {
    const effect = vi.fn()
    const registry = {
      fail: async () => defineSchedule("0 9 * * *", () => { throw new Error("Bearer abc.def.ghi rejected") }, { manual: true }),
      locked: async () => defineSchedule("0 9 * * *", effect),
      sync: async () => ({ default: defineSchedule("0 9 * * *", effect, { manual: true }) }),
    }
    const run = (id: string) => handleAuthorizedScheduleDevRequest(devRequest({ id, operation: "run-static" }), { authorize: async () => true, registry })

    const succeeded = await run("sync")
    expect(succeeded.status).toBe(200)
    const body = await readBody(succeeded)
    expect(body.run).toEqual({ completedAt: expect.any(String), id: expect.stringMatching(/^srun_manual_sync_/), scheduleId: "sync", startedAt: expect.any(String), status: "succeeded" })
    expect(effect).toHaveBeenCalledTimes(1)
    expect(await listScheduleRuns("sync")).toMatchObject([{ id: body.run?.id, status: "succeeded" }])

    const failed = await run("fail")
    expect(failed.status).toBe(200)
    const failure = await failed.text()
    expect(JSON.parse(failure)).toMatchObject({ run: { error: { message: "Bearer [redacted] rejected" }, status: "failed" } })
    expect(failure).not.toContain("abc.def.ghi")

    expect(await run("locked").then(async response => [response.status, await readBody(response)])).toEqual([403, { error: { code: "SCHEDULE_MANUAL_RUN_DISABLED", message: expect.any(String) } }])
    expect((await run("missing")).status).toBe(404)
    expect(effect).toHaveBeenCalledTimes(1)
    expect((await handleScheduleDevRequest(devRequest({ id: "sync", operation: "run-static" }))).status).toBe(409)
    expect((await handleAuthorizedScheduleDevRequest(devRequest({ id: "sync", operation: "run-static" }), { authorize: async () => false, registry })).status).toBe(403)
    expect(effect).toHaveBeenCalledTimes(1)
  })
})
