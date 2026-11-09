import { describe, expect, it } from "vitest"

import { createRealtimeNodeBus, resolveRealtimeNodeAuthority } from "../src/bus.ts"

describe("the room authority of a Node server", () => {
  it("does not read DATABASE_URL", () => {
    expect(resolveRealtimeNodeAuthority("auto", { env: { DATABASE_URL: "postgres://other/unrelated" } })).toEqual({ authority: "memory" })
  })

  it("uses the Default Database when the build found it on Postgres", () => {
    expect(resolveRealtimeNodeAuthority("auto", { database: true, env: { DATABASE_URL: "postgres://other/unrelated" } }))
      .toEqual({ authority: "postgres", source: "Default Database" })
  })

  it("prefers REDIS_URL, then REALTIME_POSTGRES_URL over the Default Database", () => {
    const env = { REALTIME_POSTGRES_URL: "postgres://rooms/realtime", REDIS_URL: "redis://cache" }
    expect(resolveRealtimeNodeAuthority("auto", { database: true, env })).toMatchObject({ authority: "redis", source: "REDIS_URL" })
    expect(resolveRealtimeNodeAuthority("auto", { database: true, env: { REALTIME_POSTGRES_URL: env.REALTIME_POSTGRES_URL } }))
      .toEqual({ authority: "postgres", source: "REALTIME_POSTGRES_URL", url: "postgres://rooms/realtime" })
    expect(resolveRealtimeNodeAuthority("postgres", { env })).toMatchObject({ authority: "postgres", source: "REALTIME_POSTGRES_URL" })
  })

  it("requires a connection for an explicit authority", () => {
    expect(() => resolveRealtimeNodeAuthority("postgres", { env: { DATABASE_URL: "postgres://other/unrelated" } }))
      .toThrow(expect.objectContaining({ code: "REALTIME_MISSING_BUS_CONNECTION" }))
    expect(() => resolveRealtimeNodeAuthority("redis", { env: {} })).toThrow(expect.objectContaining({ code: "REALTIME_MISSING_BUS_CONNECTION" }))
    expect(() => resolveRealtimeNodeAuthority("auto", { env: { REALTIME_POSTGRES_URL: "mysql://nope" } }))
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
