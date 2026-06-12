import { describe, expect, it } from "vitest"

import { executeCloudflareStaticSchedules, executeMatchingStaticSchedules } from "../src/runtime/static.ts"

import type { ScheduleDefinitionRegistry } from "../src/types.ts"

describe("Static Schedule runtime", () => {
  it("executes all static schedules matching a cron", async () => {
    const calls: string[] = []
    const registry: ScheduleDefinitionRegistry = {
      cleanup: async () => ({
        default: {
          cron: "0 4 * * *",
          handler: async ({ scheduledAt }) => calls.push(`cleanup:${scheduledAt.toISOString()}`),
        },
      }),
      report: async () => ({
        cron: "0 4 * * *",
        handler: async ({ scheduledAt }) => calls.push(`report:${scheduledAt.toISOString()}`),
      }),
      skipped: async () => ({
        default: {
          cron: "0 5 * * *",
          handler: async () => calls.push("skipped"),
        },
      }),
    }

    await executeMatchingStaticSchedules({
      cron: "0 4 * * *",
      registry,
      scheduledAt: new Date("2026-06-12T04:00:00.000Z"),
    })

    expect(calls).toEqual([
      "cleanup:2026-06-12T04:00:00.000Z",
      "report:2026-06-12T04:00:00.000Z",
    ])
  })

  it("executes Cloudflare scheduled events with runtime env active", async () => {
    const seen: Array<string | undefined> = []
    const registry: ScheduleDefinitionRegistry = {
      sync: async () => ({
        default: {
          cron: "0 4 * * *",
          handler: async () => {
            seen.push((globalThis as { __env__?: Record<string, unknown> }).__env__?.AIRTABLE_TOKEN as string | undefined)
          },
        },
      }),
    }

    await executeCloudflareStaticSchedules({
      controller: {
        cron: "0 4 * * *",
        scheduledTime: "2026-06-12T04:00:00.000Z",
      },
      env: {
        AIRTABLE_TOKEN: "airtable-secret",
      },
    }, { registry })

    expect(seen).toEqual(["airtable-secret"])
    expect((globalThis as { __env__?: Record<string, unknown> }).__env__).toBeUndefined()
  })
})
