import { describe, expect, it } from "vitest"

import { scheduleDeploymentEnv } from "../src/deployment-env.ts"

describe("scheduleDeploymentEnv", () => {
  it("names the required CRON_SECRET of the Vercel cron handler", () => {
    expect(scheduleDeploymentEnv(2, { host: "vercel" })).toEqual([
      { names: ["CRON_SECRET"], required: true, secret: true, hasDefault: false, owners: ["schedule"] },
    ])
  })

  it("names nothing for Cloudflare cron triggers, a Node server, or an app without Schedules", () => {
    expect(scheduleDeploymentEnv(2, { host: "cloudflare" })).toEqual([])
    expect(scheduleDeploymentEnv(2, { host: "node" })).toEqual([])
    expect(scheduleDeploymentEnv(0, { host: "vercel" })).toEqual([])
  })
})
