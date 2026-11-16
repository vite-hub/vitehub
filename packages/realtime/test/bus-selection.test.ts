import { describe, expect, it } from "vitest"

import { createRealtimeNodeBus, resolveRealtimeNodeDriver } from "../src/bus.ts"

describe("the Realtime driver of a Node server", () => {
  it("does not read DATABASE_URL", () => {
    expect(resolveRealtimeNodeDriver("auto", { env: { DATABASE_URL: "postgres://other/unrelated" } })).toEqual({ driver: "memory" })
  })

  it("uses the Default Database when the build found it on Postgres", () => {
    expect(resolveRealtimeNodeDriver("auto", { database: true, env: { DATABASE_URL: "postgres://other/unrelated" } }))
      .toEqual({ driver: "postgres", source: "Default Database" })
  })

  it("prefers REDIS_URL, then REALTIME_POSTGRES_URL over the Default Database", () => {
    const env = { REALTIME_POSTGRES_URL: "postgres://rooms/realtime", REDIS_URL: "redis://cache" }
    expect(resolveRealtimeNodeDriver("auto", { database: true, env })).toMatchObject({ driver: "redis", source: "REDIS_URL" })
    expect(resolveRealtimeNodeDriver("auto", { database: true, env: { REALTIME_POSTGRES_URL: env.REALTIME_POSTGRES_URL } }))
      .toEqual({ driver: "postgres", source: "REALTIME_POSTGRES_URL", url: "postgres://rooms/realtime" })
    expect(resolveRealtimeNodeDriver("postgres", { env })).toMatchObject({ driver: "postgres", source: "REALTIME_POSTGRES_URL" })
  })

  it("requires a connection for an explicit driver", () => {
    expect(() => resolveRealtimeNodeDriver("postgres", { env: { DATABASE_URL: "postgres://other/unrelated" } }))
      .toThrow(expect.objectContaining({ code: "REALTIME_MISSING_BUS_CONNECTION" }))
    expect(() => resolveRealtimeNodeDriver("redis", { env: {} })).toThrow(expect.objectContaining({ code: "REALTIME_MISSING_BUS_CONNECTION" }))
    expect(() => resolveRealtimeNodeDriver("auto", { env: { REALTIME_POSTGRES_URL: "mysql://nope" } }))
      .toThrow(expect.objectContaining({ code: "REALTIME_INVALID_POSTGRES_URL" }))
  })

  it("rejects a Default Database whose client is not postgres.js", async () => {
    await expect(createRealtimeNodeBus("auto", { databases: async () => ({ default: { db: { $client: {} } } }), env: {} }))
      .rejects.toMatchObject({ code: "REALTIME_MISSING_BUS_CONNECTION" })
  })

  it("keeps rooms in this process without a connection", async () => {
    await expect(createRealtimeNodeBus("auto", { env: { DATABASE_URL: "postgres://other/unrelated" } })).resolves.toBeUndefined()
  })
})
