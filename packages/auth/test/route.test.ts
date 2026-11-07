import { memoryAdapter } from "better-auth/adapters/memory"
import { admin } from "better-auth/plugins"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { AuthDefinition } from "../src/types.ts"

const definition = vi.hoisted(() => ({ current: undefined as AuthDefinition | undefined }))
vi.mock("#vitehub/auth/definition", () => ({
  get default() { return definition.current },
}))

import { defineAuth } from "../src/definition.ts"
import authRoute, { resetAuth } from "../src/server.ts"
import { requestEvent } from "./request-event.ts"

const origin = "https://app.example.com"
const secret = "abcdefghijklmnopqrstuvwxyz0123456789"
const credentials = { email: "owner@example.com", password: "correct-horse-battery" }

function useDefinition(): void {
  const db: Record<string, unknown[]> = { account: [], session: [], user: [], verification: [] }
  definition.current = defineAuth({
    emailAndPassword: { enabled: true },
    plugins: [admin()],
    runtime: { database: memoryAdapter(db), secret },
  })
}

function authRequest(path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${origin}/api/auth/${path}`, body === undefined
    ? { headers }
    : { body: JSON.stringify(body), headers: { "content-type": "application/json", origin, ...headers }, method: "POST" })
}

/** A Request as Nitro passes it to a Fetchable route: it carries the Standard Context of its H3 event. */
function nitroRequest(request: Request, env?: Record<string, unknown>): Request {
  requestEvent(request, env)
  return request
}

afterEach(() => {
  definition.current = undefined
  resetAuth()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe("Auth route", () => {
  it("is a Fetchable that signs a user up and in and reads the session", async () => {
    useDefinition()
    expect(typeof authRoute.fetch).toBe("function")

    expect((await authRoute.fetch(authRequest("sign-up/email", { ...credentials, name: "Owner" }))).status).toBe(200)
    const signIn = await authRoute.fetch(authRequest("sign-in/email", credentials))
    expect(signIn.status).toBe(200)
    const cookie = signIn.headers.getSetCookie().map(value => value.split(";")[0]).join("; ")

    expect(await (await authRoute.fetch(authRequest("get-session"))).json()).toBeNull()
    expect(await (await authRoute.fetch(authRequest("get-session", undefined, { cookie }))).json()).toMatchObject({ user: { email: credentials.email } })
    expect((await authRoute.fetch(authRequest("unknown-endpoint"))).status).toBe(404)
  })

  it("reads the Cloudflare bindings of the Request's Standard Context", async () => {
    useDefinition()
    const response = await authRoute.fetch(nitroRequest(
      authRequest("sign-up/email", { ...credentials, name: "Owner" }),
      { VITEHUB_ADMIN_EMAILS: credentials.email },
    ))

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ user: { email: credentials.email, role: "admin" } })
  })

  it("limits each client address of the Request's Standard Context in its own bucket", async () => {
    // A Worker build: no NODE_ENV, and the Auth Vite plugin marked the bundle as a build.
    vi.stubGlobal("__VITEHUB_AUTH_DEV__", false)
    vi.stubEnv("NODE_ENV", "")
    useDefinition()
    const send = (address: string) => {
      const request = authRequest("sign-in/email", { email: "nobody@example.com", password: "wrong-password" }, { "x-forwarded-for": "203.0.113.1" })
      // A host adapter reports the peer address as `context.clientAddress`. Better Auth does not read it itself.
      return authRoute.fetch(nitroRequest(Object.assign(request, { context: { clientAddress: address } })))
    }

    const statuses: number[] = []
    for (let index = 0; index < 4; index++) statuses.push((await send("198.51.100.201")).status)
    expect(statuses).toEqual([401, 401, 401, 429])
    expect((await send("198.51.100.202")).status).toBe(401)
  })
})
