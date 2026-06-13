import { describe, expect, it } from "vitest"

import { defineAuth } from "../src/index.ts"
import { createBetterAuthOptions } from "../src/server.ts"

describe("server auth helpers", () => {
  it("turns an Auth Definition into Better Auth options with runtime storage", () => {
    const runtimeDatabase = { runtime: "database" }
    const runtimeSecondaryStorage = { runtime: "secondary-storage" }
    const definition = defineAuth({
      appName: "ViteHub",
      basePath: "/auth/",
      database: { dedicated: true, name: "auth" },
      secondaryStorage: { store: "auth" },
    })

    const options = createBetterAuthOptions(definition, {
      baseURL: "https://example.com",
      database: runtimeDatabase as never,
      secret: "runtime-secret",
      secondaryStorage: runtimeSecondaryStorage as never,
    })

    expect(options).toMatchObject({
      appName: "ViteHub",
      basePath: "/auth",
      baseURL: "https://example.com",
      database: runtimeDatabase,
      secret: "runtime-secret",
      secondaryStorage: runtimeSecondaryStorage,
    })
    expect(options).not.toHaveProperty("route")
  })
})
