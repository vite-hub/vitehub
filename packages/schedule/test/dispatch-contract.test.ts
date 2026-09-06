import { afterEach, expect, it } from "vitest"
import { defineScheduleTarget } from "../src/definition.ts"
import { schedules } from "../src/runtime/client.ts"
import { resetScheduleRuntime, setScheduleRuntimeRegistry } from "../src/runtime/state.ts"

const received: unknown[] = []
const report = defineScheduleTarget<{ prompt: string }>({ handler: context => { received.push(context.input) } })

declare module "../src/types.ts" {
  interface ScheduleTargetRegistry {
    report: typeof report
  }
}

afterEach(() => {
  resetScheduleRuntime()
  received.length = 0
})

it("executes typed creation and replaces or clears target input on update", async () => {
  setScheduleRuntimeRegistry({ report: async () => report })
  const created = await schedules.create({ target: "report", cron: "0 9 * * *", input: { prompt: "first" } })
  await schedules.run(created.id)
  await schedules.update(created.id, { target: "report", input: { prompt: "second" } })
  await schedules.run(created.id, { scheduledAt: new Date(Date.now() + 60_000) })
  await schedules.update(created.id, { target: "report", input: undefined })
  await schedules.run(created.id, { scheduledAt: new Date(Date.now() + 120_000) })
  expect(received).toEqual([{ prompt: "first" }, { prompt: "second" }, undefined])
})
