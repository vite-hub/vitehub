import { describe, expect, it } from "vitest"

import { realtimeDeploymentEnv } from "../src/deployment-env.ts"

const owners = ["realtime"]
const namespace = { names: ["REALTIME_NAMESPACE"], required: false, secret: false, hasDefault: true, owners }

describe("realtimeDeploymentEnv", () => {
  it("names the optional bus variables that a Node server reads at boot", () => {
    expect(realtimeDeploymentEnv({ authority: "auto", postgresDatabase: false }, { host: "node" })).toEqual([
      { names: ["REDIS_URL"], required: false, secret: true, hasDefault: false, owners },
      { names: ["REALTIME_POSTGRES_URL"], required: false, secret: true, hasDefault: false, owners },
      namespace,
    ])
  })

  it("requires the connection of an explicit authority, unless a Postgres Default Database supplies it", () => {
    expect(realtimeDeploymentEnv({ authority: "redis", postgresDatabase: false }, { host: "node" })).toEqual([
      { names: ["REDIS_URL"], required: true, secret: true, hasDefault: false, owners },
      namespace,
    ])
    expect(realtimeDeploymentEnv({ authority: "postgres", postgresDatabase: false }, { host: "node" })[0]).toMatchObject({ names: ["REALTIME_POSTGRES_URL"], required: true, hasDefault: false })
    expect(realtimeDeploymentEnv({ authority: "postgres", postgresDatabase: true }, { host: "node" })[0]).toMatchObject({ names: ["REALTIME_POSTGRES_URL"], required: false, hasDefault: true })
  })

  it("names nothing for Durable Objects on Cloudflare or rooms in memory", () => {
    expect(realtimeDeploymentEnv({ authority: "auto", postgresDatabase: false }, { host: "cloudflare" })).toEqual([])
    expect(realtimeDeploymentEnv({ authority: "cloudflare", postgresDatabase: false }, { host: "node" })).toEqual([])
    expect(realtimeDeploymentEnv({ authority: "memory", postgresDatabase: false }, { host: "node" })).toEqual([])
  })
})
