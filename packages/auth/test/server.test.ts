import { afterEach, describe, expect, it } from "vitest"

import { defineAuth } from "../src/index.ts"
import { createAuthRequestRuntimeOptions, createBetterAuthOptions, getAuth, getAuthForDefinition, requireAuth, requireAuthAccessRoute, resetAuth, setAuthRuntimeEnvResolver } from "../src/server.ts"

describe("server auth helpers", () => {
  afterEach(() => {
    resetAuth()
    setAuthRuntimeEnvResolver(undefined)
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

  it("merges Auth Definition runtime options into Better Auth options", () => {
    const definition = defineAuth({
      appName: "ViteHub",
      runtime: ({ requestOrigin }) => ({
        baseURL: requestOrigin,
        secret: "runtime-secret",
      }),
    })

    expect(createBetterAuthOptions(definition)).toMatchObject({
      appName: "ViteHub",
      baseURL: "http://localhost",
      secret: "runtime-secret",
    })

    const auth = getAuthForDefinition(definition)
    expect(auth).toHaveProperty("handler")
  })

  it("uses request-scoped Auth Definition callback options", () => {
    const runtimeDatabase = { runtime: "database" }
    const definition = defineAuth(({ env, requestOrigin }) => ({
      appName: "ViteHub",
      baseURL: requestOrigin,
      database: runtimeDatabase as never,
      secret: env.secret as string,
    }))
    setAuthRuntimeEnvResolver(() => ({ secret: "env-secret" }))

    expect(createAuthRequestRuntimeOptions(definition, new Request("https://callback.example.com/api/auth"))).toMatchObject({
      appName: "ViteHub",
      baseURL: "https://callback.example.com",
      database: runtimeDatabase,
      secret: "env-secret",
      trustedOrigins: ["https://callback.example.com"],
    })

    expect(createBetterAuthOptions(definition)).toMatchObject({
      appName: "ViteHub",
      baseURL: "http://localhost",
      database: runtimeDatabase,
      secret: "env-secret",
    })
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

  it("derives request runtime options from the Auth Definition", () => {
    const definition = defineAuth({
      appName: "ViteHub",
      runtime: ({ request, requestOrigin }) => ({
        baseURL: requestOrigin,
        requestURL: request?.url,
        secret: "request-secret",
      }) as never,
    })
    const request = new Request("https://request.example.com/api/auth/session")

    expect(createAuthRequestRuntimeOptions(definition, request)).toMatchObject({
      baseURL: "https://request.example.com",
      requestURL: "https://request.example.com/api/auth/session",
      secret: "request-secret",
      trustedOrigins: ["https://request.example.com"],
    })
  })

  it("passes ViteHub runtime env into Auth Definition runtime callbacks", () => {
    setAuthRuntimeEnvResolver(() => ({ secret: "env-secret" }))
    const definition = defineAuth({
      appName: "ViteHub",
      runtime: ({ env, requestOrigin }) => ({
        baseURL: requestOrigin,
        secret: env.secret as string,
      }),
    })

    expect(createAuthRequestRuntimeOptions(definition, new Request("https://env.example.com/api/auth"))).toMatchObject({
      baseURL: "https://env.example.com",
      secret: "env-secret",
    })
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

  it("requires an Auth Session and starts configured provider sign-in for HTML requests", async () => {
    const definition = defineAuth({
      access: {
        signIn: {
          callbackURL: "/app",
          errorCallbackURL: "/app?auth_error=github",
          provider: "github",
        },
      },
      appName: "ViteHub",
      runtime: () => ({
        secret: "abcdefghijklmnopqrstuvwxyz0123456789",
        socialProviders: {
          github: {
            clientId: "github-client",
            clientSecret: "github-secret",
          },
        },
      }),
    })

    const response = await requireAuth(new Request("https://app.example.com/app", {
      headers: { accept: "text/html" },
    }), definition)

    expect(response?.status).toBe(302)
    expect(response?.headers.get("location")).toContain("https://github.com/login/oauth/authorize")
    expect(response?.headers.get("location")).toContain("client_id=github-client")
    expect(response?.headers.get("set-cookie")).toContain("better-auth.oauth_state=")
  })

  it("returns JSON unauthorized for non-HTML guarded requests", async () => {
    const definition = defineAuth({
      appName: "ViteHub",
      runtime: () => ({ secret: "abcdefghijklmnopqrstuvwxyz0123456789" }),
    })

    const response = await requireAuth(new Request("https://app.example.com/api/data", {
      method: "POST",
    }), definition)

    expect(response?.status).toBe(401)
    expect(await response?.json()).toEqual({ error: "Unauthorized." })
  })

  it("accepts server events with a req property for guarded requests", async () => {
    const definition = defineAuth({
      appName: "ViteHub",
      runtime: () => ({ secret: "abcdefghijklmnopqrstuvwxyz0123456789" }),
    })

    const response = await requireAuth({
      req: new Request("https://app.example.com/api/data", { method: "POST" }),
    }, definition)

    expect(response?.status).toBe(401)
    expect(await response?.json()).toEqual({ error: "Unauthorized." })
  })

  it("does not run route authorization without an Auth Session", async () => {
    let called = false
    const definition = defineAuth({
      access: {
        routes: [{
          authorize: () => {
            called = true
            return true
          },
          route: "/_vitehub/**",
        }],
      },
      appName: "ViteHub",
    })

    const response = await requireAuthAccessRoute(new Request("https://app.example.com/_vitehub/usage"), 0, definition)

    expect(response?.status).toBe(401)
    expect(called).toBe(false)
  })

  it("rejects invalid route indexes", async () => {
    const definition = defineAuth({ appName: "ViteHub" })

    await expect(requireAuthAccessRoute(new Request("https://app.example.com/app"), -1, definition))
      .rejects.toThrow(/non-negative integer/)
  })
})
