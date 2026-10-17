import { describe, expect, it } from "vitest"

import { renderScheduleRegistryModule } from "../src/internal/registry-module.ts"

describe("Schedule registry module", () => {
  it("imports each definition by an absolute path that Vite and Node accept", () => {
    const source = renderScheduleRegistryModule([
      { handler: "C:\\repo\\server\\schedules\\sync.ts", name: "sync" },
      { handler: "/repo/server/schedules/report.ts", name: "report" },
    ])

    expect(source).toContain(`["sync"]: async () => import("C:/repo/server/schedules/sync.ts")`)
    expect(source).toContain(`["report"]: async () => import("/repo/server/schedules/report.ts")`)
    expect(source).not.toContain("\\\\")
  })
})
