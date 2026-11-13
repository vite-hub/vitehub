import { afterEach, describe, expect, it, vi } from "vitest"
import { organization } from "better-auth/plugins"

import { defineAuth } from "../src/index.ts"
import { createAuthRequestRuntimeOptions, createBetterAuthOptions, getAuth, getAuthForDefinition, handleAuthRequest, requireAuthAccessRoutes, resetAuth, setAuthRuntimeEnvResolver, withAuth } from "../src/internal/server.ts"
import { requestEvent } from "./request-event.ts"

describe("server auth helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    resetAuth()
    setAuthRuntimeEnvResolver(undefined)
  })

  it("turns an Auth Definition into Better Auth options with runtime storage", () => {
    const runtimeDatabase = { runtime: "database" }
    const runtimeSecondaryStorage = { runtime: "secondary-storage" }
    const definition = defineAuth(() => ({
      appName: "ViteHub",
      basePath: "/auth/",
      baseURL: "https://example.com",
      database: runtimeDatabase as never,
      secret: "runtime-secret",
      secondaryStorage: runtimeSecondaryStorage as never,
    }))

    const options = createBetterAuthOptions(definition)

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

  it("passes Auth Definition callback options to Better Auth", () => {
    const definition = defineAuth(({ requestOrigin }) => ({
      appName: "ViteHub",
      baseURL: requestOrigin,
      secret: "runtime-secret",
    }))

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

  it("keeps environment resolvers isolated between Auth Definitions", () => {
    const first = defineAuth(({ env }) => ({ appName: "First", secret: env.secret as string }))
    const second = defineAuth(({ env }) => ({ appName: "Second", secret: env.secret as string }))
    setAuthRuntimeEnvResolver(() => ({ secret: "first-secret" }), first)
    setAuthRuntimeEnvResolver(() => ({ secret: "second-secret" }), second)

    expect(createBetterAuthOptions(first).secret).toBe("first-secret")
    expect(createBetterAuthOptions(second).secret).toBe("second-secret")
  })

  it("derives request runtime origin defaults", () => {
    const definition = defineAuth({ appName: "ViteHub" })
    const request = new Request("https://app.example.com/api/auth/session")

    expect(createAuthRequestRuntimeOptions(definition, request)).toMatchObject({
      baseURL: "https://app.example.com",
      trustedOrigins: ["https://app.example.com"],
    })

    expect(createAuthRequestRuntimeOptions(defineAuth(() => ({
      baseURL: "https://auth.example.com",
      trustedOrigins: ["https://app.example.com"],
    })), request)).toMatchObject({
      baseURL: "https://auth.example.com",
      trustedOrigins: ["https://app.example.com"],
    })

    expect(createAuthRequestRuntimeOptions(defineAuth({
      appName: "ViteHub",
      trustedOrigins: ["https://trusted.example.com"],
    }), request)).not.toHaveProperty("trustedOrigins")
  })

  it("defaults the base URL to vitehub({ publicUrl })", () => {
    const request = new Request("http://agents.example.com/api/auth/session")
    try {
      vi.stubGlobal("__VITEHUB_PUBLIC_URL__", { url: "https://public.example.com" })
      expect(createAuthRequestRuntimeOptions(defineAuth({ appName: "ViteHub" }), request)).toMatchObject({
        baseURL: "https://public.example.com",
        trustedOrigins: ["https://public.example.com"],
      })
      vi.stubGlobal("__VITEHUB_PUBLIC_URL__", { agents: { bot: "https://bot.example.com", dev: "https://agents.example.com" } })
      expect(createAuthRequestRuntimeOptions(defineAuth({ appName: "ViteHub" }), request).baseURL).toBe("https://agents.example.com")
      // An unset value keeps the default instead of overriding it with undefined.
      expect(createAuthRequestRuntimeOptions(defineAuth(() => ({ appName: "ViteHub", baseURL: undefined })), request).baseURL).toBe("https://agents.example.com")
    }
    finally {
      vi.unstubAllGlobals()
    }
  })

  it("derives request runtime options from the Auth Definition", () => {
    const definition = defineAuth(({ request, requestOrigin }) => ({
      appName: "ViteHub",
      baseURL: requestOrigin,
      requestURL: request?.url,
      secret: "request-secret",
    }) as never)
    const request = new Request("https://request.example.com/api/auth/session")

    expect(createAuthRequestRuntimeOptions(definition, request)).toMatchObject({
      baseURL: "https://request.example.com",
      requestURL: "https://request.example.com/api/auth/session",
      secret: "request-secret",
      trustedOrigins: ["https://request.example.com"],
    })
  })

  it("keeps the runtime env resolver when a dev reload re-runs the server module", async () => {
    setAuthRuntimeEnvResolver(() => ({ secret: "env-secret" }))
    vi.resetModules()
    const reloaded = await import("../src/internal/server.ts")
    const definition = defineAuth(({ env }) => ({ secret: env.secret as string }))

    expect(reloaded.createBetterAuthOptions(definition)).toMatchObject({ secret: "env-secret" })
  })

  it("passes ViteHub runtime env into Auth Definition callbacks", () => {
    setAuthRuntimeEnvResolver(() => ({ secret: "env-secret" }))
    const definition = defineAuth(({ env, requestOrigin }) => ({
      appName: "ViteHub",
      baseURL: requestOrigin,
      secret: env.secret as string,
    }))

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

  it.each([
    ["BETTER_AUTH_SECRET", "first-secret-at-least-32-characters", "second-secret-at-least-32-characters"],
    ["AUTH_SECRET", "first-secret-at-least-32-characters", "second-secret-at-least-32-characters"],
    ["BETTER_AUTH_SECRETS", "1:first-secret-at-least-32-characters", "2:second-secret-at-least-32-characters"],
  ])("rejects a cookie of the old %s after it changes", async (name, first, second) => {
    vi.stubEnv(name, first)
    const definition = defineAuth({ appName: "ViteHub", emailAndPassword: { enabled: true } })
    const origin = "http://localhost:3000"
    const signUp = await handleAuthRequest(definition, new Request(`${origin}/api/auth/sign-up/email`, {
      body: JSON.stringify({ email: `rotate-${name}@example.com`, name: "Rotate", password: "passwordpassword" }),
      headers: { "content-type": "application/json", origin },
      method: "POST",
    }))
    expect(signUp.status).toBe(200)
    const cookie = signUp.headers.getSetCookie().map(value => value.split(";")[0]).join("; ")
    const guard = withAuth(() => "ok", definition)
    const send = () => guard(new Request(`${origin}/private`, { headers: { cookie } }))
    expect(await send()).toBe("ok")
    vi.stubEnv(name, second)
    expect(await send()).toMatchObject({ status: 401 })
  })

  it("signs in a user who signed up in an earlier request without a database", async () => {
    const definition = defineAuth({
      appName: "ViteHub",
      emailAndPassword: { enabled: true },
    })
    const origin = "http://localhost:3000"
    const request = (path: string, body: object) => handleAuthRequest(definition, new Request(`${origin}/api/auth/${path}`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", origin },
      method: "POST",
    }))

    expect((await request("sign-up/email", { email: "memory@example.com", name: "Memory", password: "passwordpassword" })).status).toBe(200)
    const signIn = await request("sign-in/email", { email: "memory@example.com", password: "passwordpassword" })
    const cookie = signIn.headers.getSetCookie().map(value => value.split(";")[0]).join("; ")
    const session = await getAuthForDefinition(definition).api.getSession({ headers: new Headers({ cookie }), query: { disableCookieCache: true } })

    expect(signIn.status).toBe(200)
    expect(session?.user.email).toBe("memory@example.com")
    expect((await request("sign-in/email", { email: "memory@example.com", password: "wrong-password" })).status).toBe(401)
    expect(await getAuthForDefinition(defineAuth({ appName: "Other" })).api.getSession({ headers: new Headers({ cookie }), query: { disableCookieCache: true } })).toBeNull()
  })

  it("shares configured core and plugin model names across requests without a database", async () => {
    const definition = defineAuth({
      emailAndPassword: { enabled: true },
      user: { modelName: "users" },
      account: { modelName: "accounts" },
      session: { modelName: "sessions" },
      verification: { modelName: "verifications" },
      plugins: [organization({
        schema: {
          organization: { modelName: "organizations" },
          member: { modelName: "members" },
          invitation: { modelName: "invitations" },
        },
      })],
    })
    const origin = "http://localhost:3000"
    const request = (path: string, body: object, cookie = "") => handleAuthRequest(definition, new Request(`${origin}/api/auth/${path}`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", cookie, origin },
      method: "POST",
    }))

    expect((await request("sign-up/email", { email: "models@example.com", name: "Models", password: "passwordpassword" })).status).toBe(200)
    const signIn = await request("sign-in/email", { email: "models@example.com", password: "passwordpassword" })
    expect(signIn.status).toBe(200)
    const cookie = signIn.headers.getSetCookie().map(value => value.split(";")[0]).join("; ")
    const session = await getAuthForDefinition(definition).api.getSession({ headers: new Headers({ cookie }), query: { disableCookieCache: true } })
    expect(session?.user.email).toBe("models@example.com")

    expect((await request("organization/create", { name: "Models", slug: "models" }, cookie)).status).toBe(200)
    const organizations = await handleAuthRequest(definition, new Request(`${origin}/api/auth/organization/list`, { headers: { cookie } }))
    expect(organizations.status).toBe(200)
    expect(await organizations.json()).toMatchObject([{ name: "Models", slug: "models" }])
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
    const runtime = vi.fn(() => ({
      access: {
        signIn: {
          callbackURL: "/app",
          errorCallbackURL: "/app?auth_error=github",
          provider: "github",
        },
      },
      appName: "ViteHub",
      secret: "abcdefghijklmnopqrstuvwxyz0123456789",
      socialProviders: {
        github: {
          clientId: "github-client",
          clientSecret: "github-secret",
        },
      },
    }))
    const definition = defineAuth(runtime)

    const response = await withAuth(() => undefined, definition)(new Request("https://app.example.com/app", {
      headers: { accept: "text/html" },
    }))

    expect(response?.status).toBe(302)
    expect(response?.headers.get("location")).toContain("https://github.com/login/oauth/authorize")
    expect(response?.headers.get("location")).toContain("client_id=github-client")
    expect(response?.headers.get("set-cookie")).toContain("better-auth.state=")
    expect(runtime).toHaveBeenCalledOnce()
  })

  it("returns JSON unauthorized for non-HTML guarded requests", async () => {
    const definition = defineAuth(() => ({
      appName: "ViteHub",
      secret: "abcdefghijklmnopqrstuvwxyz0123456789",
    }))

    const response = await withAuth(() => undefined, definition)(new Request("https://app.example.com/api/data", {
      method: "POST",
    }))

    expect(response?.status).toBe(401)
    expect(response?.statusText).toBe("Unauthorized")
    expect(await response?.json()).toEqual({ status: 401, statusText: "Unauthorized", message: "Unauthorized.", data: { code: "SIGNED_OUT" } })
  })

  it("accepts request events with Standard Context for guarded requests", async () => {
    const definition = defineAuth(() => ({
      appName: "ViteHub",
      secret: "abcdefghijklmnopqrstuvwxyz0123456789",
    }))

    const response = await withAuth(() => undefined, definition)(requestEvent(new Request("https://app.example.com/api/data", { method: "POST" })))

    expect(response?.status).toBe(401)
    expect(await response?.json()).toEqual({ status: 401, statusText: "Unauthorized", message: "Unauthorized.", data: { code: "SIGNED_OUT" } })
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

    const response = await requireAuthAccessRoutes(new Request("https://app.example.com/_vitehub/usage"), [0], definition)

    expect(response?.status).toBe(401)
    expect(called).toBe(false)
  })

  it("suppresses automatic provider sign-in when requested by a host sign-in page", async () => {
    const definition = defineAuth({
      access: {
        routes: [{ route: "/_vitehub/**" }],
        signIn: { provider: "github" },
      },
      appName: "ViteHub",
    })
    const request = new Request("https://app.example.com/_vitehub", { headers: { accept: "text/html" } })

    const response = await requireAuthAccessRoutes(request, [0], definition, [], { redirectToSignIn: false })
    expect(response?.status).toBe(401)
    expect(response?.headers.get("location")).toBeNull()
  })

  it("rejects invalid route indexes", async () => {
    const definition = defineAuth({ appName: "ViteHub" })

    await expect(requireAuthAccessRoutes(new Request("https://app.example.com/app"), [-1], definition))
      .rejects.toThrow(/non-empty array of non-negative integers/)
  })
})
