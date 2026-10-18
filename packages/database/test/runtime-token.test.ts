import { afterEach, describe, expect, it, vi } from "vitest"

import { createRuntimeEnvConfigValue } from "../src/config-value.ts"
import { createDrizzleSqliteAdapter } from "../src/runtime/drizzle-adapter.ts"

afterEach(() => vi.unstubAllEnvs())

describe("libSQL runtime credentials", () => {
  it.each([false, true])("refreshes changed credentials with requireRemoteUrl=%s", (requireRemoteUrl) => {
    vi.stubEnv("VITEHUB_TEST_DATABASE_TOKEN", "first-token")
    const clients: Array<{ authToken?: string, close: ReturnType<typeof vi.fn>, url: string }> = []
    const createClient = vi.fn((options: { authToken?: string, url: string }) => {
      const client = { ...options, close: vi.fn() }
      clients.push(client)
      return client
    })
    const drizzle = vi.fn(() => ({ run: vi.fn() }))
    const db = createDrizzleSqliteAdapter({
      connection: {
        authToken: createRuntimeEnvConfigValue(["VITEHUB_TEST_DATABASE_TOKEN"]),
        url: "libsql://database.example",
      },
      drizzle: {},
      name: "test",
    }, {}, {
      libsql: { createClient, drizzle },
      missingConnection: "a connection",
      requireRemoteUrl,
    })

    db.run("select 1")
    db.run("select 1")
    expect(createClient).toHaveBeenCalledTimes(1)
    expect(createClient).toHaveBeenLastCalledWith({ authToken: "first-token", url: "libsql://database.example" })

    vi.stubEnv("VITEHUB_TEST_DATABASE_TOKEN", "second-token")
    db.run("select 1")
    expect(createClient).toHaveBeenCalledTimes(2)
    expect(createClient).toHaveBeenLastCalledWith({ authToken: "second-token", url: "libsql://database.example" })
    expect(clients[0]!.close).toHaveBeenCalledOnce()
    expect(clients[1]!.close).not.toHaveBeenCalled()

    vi.stubEnv("VITEHUB_TEST_DATABASE_TOKEN", undefined)
    db.run("select 1")
    db.run("select 1")
    expect(createClient).toHaveBeenCalledTimes(3)
    expect(createClient).toHaveBeenLastCalledWith({ authToken: undefined, url: "libsql://database.example" })
    expect(clients[1]!.close).toHaveBeenCalledOnce()
    expect(clients[2]!.close).not.toHaveBeenCalled()
  })
})
