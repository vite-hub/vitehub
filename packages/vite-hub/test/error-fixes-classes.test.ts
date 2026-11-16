import { afterEach, expect, it, vi } from "vitest"

const runTask = vi.hoisted(() => vi.fn())
vi.mock("nitro/task", () => ({ runTask }))

import { viteHubErrorDiagnostics } from "../src/error-diagnostics.ts"
import { createLogBuffer, logCursorExpiredError } from "../src/logs.ts"
import { listTasks, runNamedTask } from "../src/task/runtime.ts"
import { taskRegistryKey } from "../src/task/registry.ts"

// The codes that replace the Logs and Task error classes.
const codes = ["LOGS_CURSOR_EXPIRED", "TASK_FAILED", "TASK_NOT_FOUND", "TASK_NOT_IMPLEMENTED", "TASK_RUNTIME_UNAVAILABLE"] as const
const scope = globalThis as Record<symbol, unknown>

afterEach(() => {
  runTask.mockReset()
  Reflect.deleteProperty(scope, Symbol.for(taskRegistryKey))
})

it("gives each code that replaces a vite-hub error class a fix and its own docs page", () => {
  for (const code of codes) {
    // SAFETY: each code reads only the params it declares from this shared object.
    const error = (viteHubErrorDiagnostics[code] as (input: { detail: string, name: string }) => Error & { docs?: string, fix?: string })({ detail: "d", name: "n" })
    expect(error.message, code).toMatch(/\S/)
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/development/diagnostics/${code.toLowerCase()}`)
  }
})

it("rejects an expired log cursor with LOGS_CURSOR_EXPIRED and a fix", async () => {
  const buffer = createLogBuffer({ maxEntries: 1 })
  buffer.append({ data: {}, id: "a", level: "info", message: "a", service: "app", timestamp: new Date(0).toISOString() })
  buffer.append({ data: {}, id: "b", level: "info", message: "b", service: "app", timestamp: new Date(1).toISOString() })
  await expect(buffer.source.query({ cursor: "a" })).rejects.toMatchObject({ code: "LOGS_CURSOR_EXPIRED", fix: expect.stringContaining("first page") })
  expect(logCursorExpiredError()).toMatchObject({ code: "LOGS_CURSOR_EXPIRED" })
})

it("reports a task runtime without tasks and an unknown task with a code, status, and fix", async () => {
  await expect(listTasks()).rejects.toMatchObject({ code: "TASK_RUNTIME_UNAVAILABLE", fix: expect.stringContaining("server/tasks/"), status: 503 })
  scope[Symbol.for(taskRegistryKey)] = { "db:seed": {} }
  await expect(runNamedTask("nope")).rejects.toMatchObject({ code: "TASK_NOT_FOUND", fix: expect.stringContaining("vitehub task list"), status: 404 })
  runTask.mockRejectedValueOnce(new Error("no such table: notes"))
  vi.spyOn(console, "error").mockImplementationOnce(() => {})
  await expect(runNamedTask("db:seed")).rejects.toMatchObject({ code: "TASK_FAILED", message: "Task \"db:seed\" failed: no such table: notes", status: 500 })
})
