import { afterEach, describe, expect, it } from "vitest"

import { defineAuth } from "../src/index.ts"
import { createAuthRequestRuntimeOptions, createBetterAuthOptions, getAuth, getAuthForDefinition, resetAuth } from "../src/server.ts"

describe("server auth helpers", () => {
  afterEach(() => {
    resetAuth()
  })

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

  it("derives request runtime origin defaults", () => {
    const definition = defineAuth({ appName: "ViteHub" })
    const request = new Request("https://app.example.com/api/auth/session")

    expect(createAuthRequestRuntimeOptions(definition, request)).toMatchObject({
      baseURL: "https://app.example.com",
      trustedOrigins: ["https://app.example.com"],
    })

    expect(createAuthRequestRuntimeOptions(definition, request, {
      baseURL: "https://auth.example.com",
      trustedOrigins: ["https://app.example.com"],
    })).toMatchObject({
      baseURL: "https://auth.example.com",
      trustedOrigins: ["https://app.example.com"],
    })

    expect(createAuthRequestRuntimeOptions(defineAuth({
      appName: "ViteHub",
      trustedOrigins: ["https://trusted.example.com"],
    }), request)).not.toHaveProperty("trustedOrigins")
  })

  it("shares the cached Auth instance used by route exposure and session resolution", async () => {
    const definition = defineAuth({
      appName: "ViteHub",
      emailAndPassword: { enabled: true },
    })

    const routeAuth = getAuthForDefinition(definition)
    const helperAuth = getAuthForDefinition(definition)
    const response = await routeAuth.handler(new Request("http://localhost/api/auth/sign-up/email", {
      body: JSON.stringify({
        email: `auth-${Date.now()}@example.com`,
        name: "Auth User",
        password: "passwordpassword",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }))
    const cookie = response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ")

    const session = await helperAuth.api.getSession({
      headers: new Headers({ cookie }),
      query: {
        disableCookieCache: true,
        disableRefresh: true,
      },
    })

    expect(response.status).toBe(200)
    expect(helperAuth).toBe(routeAuth)
    expect(session?.user.email).toMatch(/^auth-\d+@example\.com$/)
  })

  it("does not reuse cached Auth state for a different Auth Definition", () => {
    const first = getAuthForDefinition(defineAuth({ appName: "First" }))
    const second = getAuthForDefinition(defineAuth({ appName: "Second" }))

    expect(second).not.toBe(first)
  })

  it("does not treat an explicitly cached Auth Definition as the default discovered definition", () => {
    getAuthForDefinition(defineAuth({ appName: "Explicit" }))

    expect(() => getAuth()).toThrow(/No Auth Definition was discovered/)
  })
})
