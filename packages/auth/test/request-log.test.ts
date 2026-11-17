import { memoryAdapter } from "better-auth/adapters/memory"
import { afterEach, describe, expect, it, vi } from "vitest"

import { handleAuthRequest, resetAuth, withAuth } from "../src/internal/server.ts"
import { defineFixedAuth } from "./fixed-auth.ts"
import { requestEvent } from "./request-event.ts"

import type { AuthRuntimeOptions } from "../src/types.ts"

const origin = "https://shop.example"
const credentials = { email: "ada@shop.example", password: "passwordpassword" }

afterEach(() => {
  resetAuth()
  vi.restoreAllMocks()
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

/** A Nitro v3 request event. With `log`, it has evlog's request logger where evlog's Nitro plugin puts it. */
function event(path: string, init: RequestInit = {}, log?: ReturnType<typeof evlogLogger>) {
  const request = new Request(new URL(path, origin), init)
  if (log) Object.assign(request, { context: { log } })
  return requestEvent(request)
}

function post(path: string, body: object, log?: ReturnType<typeof evlogLogger>) {
  return event(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", origin } }, log)
}

/** The `auth` fields that the request set on its wide event. */
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

  it("sets the error of a failed OAuth callback, which the browser gets only as a redirect", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const log = evlogLogger()
    const response = await handleAuthRequest(createDefinition(), event("/api/auth/callback/github?code=provider-code&state=forged-state", {}, log))

    expect(response.status).toBe(302)
    const error = new URL(response.headers.get("location")!).searchParams.get("error")
    expect(error).toBeTruthy()
    expect(authFields(log)).toEqual([{ path: "/callback/:id", provider: "github", outcome: "failure", status: 302, code: error }])
    // Better Auth's own log line about the state goes on the event too, without the query of any URL.
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
