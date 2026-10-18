import { afterEach, describe, expect, it } from "vitest"

import { schedules } from "../src/runtime/client.ts"
import { resetScheduleRuntime, setScheduleRuntimeRegistry } from "../src/runtime/state.ts"

afterEach(() => {
  resetScheduleRuntime()
})

describe("Runtime Schedule input boundaries", () => {
  it("rejects schedule fields inherited from the input prototype", async () => {
    setScheduleRuntimeRegistry({
      report: async () => ({
        cron: "0 9 * * *",
        handler: async () => {},
        options: { allowRuntimeSchedules: true },
      }),
    })

    const inherited = Object.create({
      cron: "0 8 * * *",
      id: "inherited-id",
      target: "report",
    })

    await expect(schedules.dynamic.create(inherited as never)).rejects.toMatchObject({
      code: "SCHEDULE_INVALID_INPUT",
    })
  })

  it("rejects inherited fields in updates", async () => {
    setScheduleRuntimeRegistry({
      report: async () => ({
        cron: "0 9 * * *",
        handler: async () => {},
        options: { allowRuntimeSchedules: true },
      }),
    })
    await schedules.dynamic.create({ cron: "0 9 * * *", id: "owned-id", target: "report" })

    const inherited = Object.create({ cron: "0 8 * * *" })
    await expect(schedules.dynamic.update("owned-id", inherited as never)).rejects.toMatchObject({
      code: "SCHEDULE_INVALID_INPUT",
    })
  })
})
