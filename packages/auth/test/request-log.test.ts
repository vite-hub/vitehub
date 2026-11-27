import { DatabaseSync } from "node:sqlite"

import { memoryAdapter } from "better-auth/adapters/memory"
import { createRequestLogger, initLogger } from "evlog"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createAuthForRequest, handleAuthRequest, resetAuth, withAuth } from "../src/internal/server.ts"
import { mcpOAuth } from "../src/mcp.ts"
import { setAuthResponseOutcome } from "../src/request-log.ts"
import { defineFixedAuth } from "./fixed-auth.ts"
import { requestEvent } from "./request-event.ts"

import type { AuthRuntimeOptions } from "../src/types.ts"

const origin = "https://shop.example"
const credentials = { email: "ada@shop.example", password: "passwordpassword" }

afterEach(() => {
  resetAuth()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function evlogLogger() {
  return { set: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

function createDefinition(options: Partial<AuthRuntimeOptions> = {}) {
  const db: Record<string, unknown[]> = { account: [], session: [], user: [], verification: [] }
  return defineFixedAuth({
    appName: "Shop",
    baseURL: origin,
    database: memoryAdapter(db),
    emailAndPassword: { enabled: true },
    secret: "abcdefghijklmnopqrstuvwxyz0123456789",
    socialProviders: { github: { clientId: "github-client", clientSecret: "github-secret" } },
    ...options,
  })
}

function event(path: string, init: RequestInit = {}, log?: ReturnType<typeof evlogLogger> | ReturnType<typeof createRequestLogger>) {
  const request = new Request(new URL(path, origin), init)
  if (log) Object.assign(request, { context: { log } })
  return requestEvent(request)
}

function post(path: string, body: object, log?: Parameters<typeof event>[2]) {
  return event(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", origin } }, log)
}

function authFields(log: ReturnType<typeof evlogLogger>): unknown[] {
  return log.set.mock.calls.map(([fields]) => fields).filter(fields => "auth" in fields).map(fields => fields.auth)
}

describe("Auth outcomes on the request's wide event", () => {
  it("sets a failed sign-in with Better Auth's error code, and no email", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const definition = createDefinition()
    await handleAuthRequest(definition, post("/api/auth/sign-up/email", { ...credentials, name: "Ada" }))

    const log = evlogLogger()
    const response = await handleAuthRequest(definition, post("/api/auth/sign-in/email", { ...credentials, password: "wrong-password" }, log))

    expect(response.status).toBe(401)
    expect(authFields(log)).toEqual([{ path: "/sign-in/email", outcome: "failure", status: 401, code: "INVALID_EMAIL_OR_PASSWORD" }])
    expect(JSON.stringify([log.set.mock.calls, log.warn.mock.calls, log.error.mock.calls])).not.toContain(credentials.email)
  })

  it("sets a completed sign-in with the user id", async () => {
    const definition = createDefinition()
    const signUp = await handleAuthRequest(definition, post("/api/auth/sign-up/email", { ...credentials, name: "Ada" }))
    const { user } = await signUp.json() as { user: { id: string } }

    const log = evlogLogger()
    const response = await handleAuthRequest(definition, post("/api/auth/sign-in/email", credentials, log))

    expect(response.status).toBe(200)
    expect(authFields(log)).toEqual([{ path: "/sign-in/email", outcome: "success", userId: user.id }])
  })

  it.each([{ requireEmailVerification: true }, { autoSignIn: false }])("logs account creation without a session (%j)", async (options) => {
    const definition = createDefinition({ emailAndPassword: { enabled: true, ...options } })
    const log = evlogLogger()
    const payload = { ...credentials, name: "Ada" }
    const response = await handleAuthRequest(definition, post("/api/auth/sign-up/email", payload, log))
    const { user, token } = await response.json() as { user: { id: string }, token: string | null }

    expect(response.status).toBe(200)
    expect(token).toBeNull()
    expect(authFields(log)).toEqual([{ outcome: "success", path: "/sign-up/email", userId: user.id }])

    const duplicate = evlogLogger()
    const duplicateResponse = await handleAuthRequest(definition, post("/api/auth/sign-up/email", payload, duplicate))
    expect(duplicateResponse.status).toBe(200)
    expect(authFields(duplicate)).toEqual([])
  })

  it.each([false, true])("classifies a GitHub callback by its Auth outcome, not the app query (fails: %s)", async (fails) => {
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.href === "https://github.com/login/oauth/access_token") return Response.json({ access_token: "github-token", token_type: "bearer" })
      if (url.href === "https://api.github.com/user") return Response.json({ id: 7, login: "ada", name: "Ada", email: credentials.email })
      if (url.href === "https://api.github.com/user/emails") return Response.json([{ email: credentials.email, primary: true, verified: true }])
      throw new Error(`Unexpected fetch: ${url.href}`)
    })
    const definition = createDefinition()
    const signIn = await handleAuthRequest(definition, post("/api/auth/sign-in/social", {
      provider: "github",
      callbackURL: "/app?error=draft-not-found",
      errorCallbackURL: "/sign-in?source=github",
    }))
    const { url } = await signIn.json() as { url: string }
    const state = new URL(url).searchParams.get("state")!
    const cookie = signIn.headers.getSetCookie().map(value => value.split(";")[0]).join("; ")
    const params = new URLSearchParams({ state, ...(fails ? { error: "access_denied" } : { code: "github-code" }) })

    const log = evlogLogger()
    const response = await handleAuthRequest(definition, event(`/api/auth/callback/github?${params}`, { headers: { cookie } }, log))
    expect(response.status).toBe(302)
    expect(new URL(response.headers.get("location")!, origin).pathname).toBe(fails ? "/sign-in" : "/app")
    expect(authFields(log)).toEqual([{
      path: "/callback/:id",
      provider: "github",
      ...(fails ? { outcome: "failure", status: 302, code: "access_denied" } : { outcome: "success", userId: expect.any(String) }),
    }])
  })

  it("does not treat a form-post handoff to the GET callback as a failure", async () => {
    const log = evlogLogger()
    const response = await handleAuthRequest(createDefinition(), event("/api/auth/callback/github", {
      method: "POST",
      headers: { origin },
      body: new URLSearchParams({ error: "access_denied" }),
    }, log))
    expect(response.status).toBe(302)
    expect(response.headers.get("location")).toContain("/api/auth/callback/github?error=access_denied")
    expect(authFields(log)).toEqual([])
  })

  it("keeps callback causes and rejected URLs out of serialized Evlog events", async () => {
    initLogger({ redact: false, silent: true, drain: vi.fn() })
    const callbackLog = createRequestLogger()
    const validationLog = createRequestLogger()
    const appLog = vi.fn()
    const privateURL = "https://other.example/ada%40shop.example?token=private-token"
    const definition = createDefinition({
      advanced: { disableOriginCheck: false },
      emailAndPassword: { enabled: true, autoSignIn: false },
      logger: { log: appLog },
      events: {
        store: { append: vi.fn(), list: vi.fn(), aggregate: vi.fn() },
        onEvent: () => { throw new Error(`Delivery to ${credentials.email} failed: ${privateURL}`) },
      },
    })
    const signUp = await handleAuthRequest(definition, post("/api/auth/sign-up/email", { ...credentials, name: "Ada" }, callbackLog))
    expect(signUp.status).toBe(200)
    const callbackEvent = JSON.stringify(callbackLog.emit())
    expect(callbackEvent).toContain("AUTH_EVENT_CALLBACK_FAILED")
    expect(callbackEvent).toContain("user.signed_up")

    const rejected = await handleAuthRequest(definition, post("/api/auth/sign-in/social", { provider: "github", callbackURL: privateURL }, validationLog))
    expect(rejected.status).toBe(403)
    const validationEvent = JSON.stringify(validationLog.emit())
    expect(validationEvent).toContain("[Better Auth] Invalid callbackURL")
    expect(appLog).toHaveBeenCalledWith("error", `Invalid callbackURL: ${privateURL}`)
    for (const secret of [credentials.email, "ada%40shop.example", "other.example", "private-token"]) {
      expect(callbackEvent).not.toContain(secret)
      expect(validationEvent).not.toContain(secret)
    }
  })

  it("sets the error of a failed OAuth callback, which the browser gets only as a redirect", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const log = evlogLogger()
    const response = await handleAuthRequest(createDefinition(), event("/api/auth/callback/github?code=provider-code&state=forged-state", {}, log))

    expect(response.status).toBe(302)
    const error = new URL(response.headers.get("location")!).searchParams.get("error")
    expect(error).toBeTruthy()
    expect(authFields(log)).toEqual([{ path: "/callback/:id", provider: "github", outcome: "failure", status: 302, code: error }])
    const lines = [...log.warn.mock.calls, ...log.error.mock.calls].map(([entry]) => entry instanceof Error ? `${entry.message}\n${entry.stack}` : String(entry))
    expect(lines.some(line => line.startsWith("[Better Auth] "))).toBe(true)
    expect(JSON.stringify([log.set.mock.calls, lines])).not.toContain("provider-code")
  })

  it("sets a refusal of Better Auth's rate limit from the response", async () => {
    const definition = createDefinition({ rateLimit: { enabled: true, window: 60, max: 100, customRules: { "/sign-in/email": { window: 60, max: 1 } } } })
    await handleAuthRequest(definition, post("/api/auth/sign-in/email", credentials))

    const log = evlogLogger()
    const response = await handleAuthRequest(definition, post("/api/auth/sign-in/email", credentials, log))

    expect(response.status).toBe(429)
    expect(authFields(log)).toEqual([expect.objectContaining({ outcome: "failure", status: 429 })])
  })

  it("sets a refusal of an Auth guard with its code", async () => {
    const log = evlogLogger()
    const response = await withAuth(() => "orders", createDefinition())(post("/api/orders", {}, log))

    expect(response).toBeInstanceOf(Response)
    expect(authFields(log)).toEqual([{ outcome: "refused", status: 401, code: "SIGNED_OUT" }])
  })

  it("sets the OAuth error of a refused token request as its code", async () => {
    const database = new DatabaseSync(":memory:")
    const definition = defineFixedAuth({
      baseURL: origin,
      database,
      emailAndPassword: { enabled: true },
      plugins: mcpOAuth({ loginPage: "/oauth", resource: `${origin}/mcp` }),
      secret: "abcdefghijklmnopqrstuvwxyz0123456789",
    })
    await (await createAuthForRequest(definition, new Request(origin)).$context).runMigrations()
    const registration = await handleAuthRequest(definition, post("/api/auth/oauth2/register", { redirect_uris: ["http://127.0.0.1:53682/callback"], token_endpoint_auth_method: "none" }))
    const { client_id } = await registration.json() as { client_id: string }

    const log = evlogLogger()
    const response = await handleAuthRequest(definition, event("/api/auth/oauth2/token", {
      body: new URLSearchParams({ client_id, code: "forged-code", code_verifier: "v".repeat(43), grant_type: "authorization_code", redirect_uri: "http://127.0.0.1:53682/callback" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    }, log))

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: "invalid_grant" })
    expect(authFields(log)).toEqual([{ path: "/oauth2/token", outcome: "failure", status: 400, code: "invalid_grant" }])
    expect(JSON.stringify(log.set.mock.calls)).not.toContain("forged-code")
    database.close()
  })

  it("reads the OAuth error of a response body, and Better Auth's code before it", async () => {
    for (const [body, code] of [
      [{ error: "invalid_grant", error_description: "The code expired." }, "invalid_grant"],
      [{ code: "INVALID_TOKEN", error: "invalid_token" }, "INVALID_TOKEN"],
    ] as const) {
      const log = evlogLogger()
      const request = Object.assign(new Request(`${origin}/api/auth/oauth2/token`), { context: { log } })
      await setAuthResponseOutcome(request, Response.json(body, { status: 400 }))
      expect(authFields(log)).toEqual([{ outcome: "failure", status: 400, code }])
    }
  })

  it("keeps the app's own Better Auth logger", async () => {
    const appLog = vi.fn()
    const log = evlogLogger()
    await handleAuthRequest(createDefinition({ logger: { log: appLog } }), event("/api/auth/callback/github?code=provider-code&state=forged-state", {}, log))

    expect(appLog).toHaveBeenCalled()
    expect(appLog.mock.calls.some(([level]) => level === "error" || level === "warn")).toBe(true)
  })

  it("answers as before and sets nothing without evlog", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const definition = createDefinition()
    await expect(handleAuthRequest(definition, post("/api/auth/sign-in/email", credentials))).resolves.toMatchObject({ status: 401 })
    await expect(handleAuthRequest(definition, event("/api/auth/callback/github?code=provider-code&state=forged-state"))).resolves.toMatchObject({ status: 302 })
    await expect(withAuth(() => "orders", definition)(post("/api/orders", {}))).resolves.toMatchObject({ status: 401 })
  })
})
