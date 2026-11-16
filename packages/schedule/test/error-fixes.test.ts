import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, expect, it } from "vitest"

import { defineSchedule } from "../src/definition.ts"
import { scheduleErrorDiagnostics } from "../src/error-diagnostics.ts"
import { createScheduleNitroConfig } from "../src/vite.ts"

const fixedCodes = [
  "SCHEDULE_B0001",
  "SCHEDULE_B0002",
  "SCHEDULE_B0003",
  "SCHEDULE_B0004",
  "SCHEDULE_B0005",
  "SCHEDULE_B0006",
  "SCHEDULE_B0007",
  "SCHEDULE_B0008",
  "SCHEDULE_C0001",
  "SCHEDULE_C0002",
  "SCHEDULE_C0003",
  "SCHEDULE_C0004",
  "SCHEDULE_C0005",
  "SCHEDULE_C0006",
  "SCHEDULE_RUNTIME_CATCH_UP_INVALID",
] as const

const temporaryDirectories: string[] = []

afterAll(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { force: true, recursive: true })))
})

async function emptyRoot() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-error-fixes-"))
  temporaryDirectories.push(root)
  return root
}

it("gives each Schedule build and definition code a fix and its own docs page", () => {
  for (const code of fixedCodes) {
    const error = scheduleErrorDiagnostics[code]({ message: "m" })
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/schedule/diagnostics/${code.toLowerCase()}`)
  }
})

it("names the cron format in the fix of a bad cron", () => {
  expect(() => defineSchedule({ cron: "0 9 * *", handler: () => {} })).toThrow(expect.objectContaining({
    code: "SCHEDULE_C0002",
    fix: expect.stringContaining("`cron` as five fields"),
    message: "`defineSchedule()` cron must be a five-field cron expression.",
  }))
})

it("lists the accepted options in the fix of an unknown option", () => {
  expect(() => defineSchedule({ cron: "0 9 * * *", handler: () => {}, retries: 3 } as never)).toThrow(expect.objectContaining({
    code: "SCHEDULE_C0004",
    fix: expect.stringContaining("`cron`, `handler`, `manual`, and `timeZone`"),
  }))
})

it("names runtime.catchUpMs in the fix of a negative catch-up window", async () => {
  await expect(createScheduleNitroConfig({ command: "build", root: await emptyRoot(), runtime: { catchUpMs: -1, driver: "process" } }))
    .rejects.toMatchObject({
      code: "SCHEDULE_RUNTIME_CATCH_UP_INVALID",
      fix: expect.stringContaining("`runtime.catchUpMs`"),
      message: "Schedule Process Runtime catchUpMs must be a non-negative number.",
    })
})

it("names the Process Runtime driver in the fix of an unknown driver", async () => {
  await expect(createScheduleNitroConfig({ command: "build", root: await emptyRoot(), runtime: { driver: "cron" } as never }))
    .rejects.toMatchObject({
      code: "SCHEDULE_B0001",
      fix: expect.stringContaining("`runtime: { driver: \"process\" }`"),
    })
})
