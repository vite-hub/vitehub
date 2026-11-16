import { memoryAdapter } from "better-auth/adapters/memory"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { AuthDefinition } from "../src/types.ts"

const definition = vi.hoisted(() => ({ current: undefined as AuthDefinition | undefined }))
vi.mock("#vitehub/auth/definition", () => ({
  get default() { return definition.current },
}))

import authRoute, { resetAuth } from "../src/internal/server.ts"
import { requestEvent } from "./request-event.ts"
import { defineFixedAuth } from "./fixed-auth.ts"

const origin = "https://app.example.com"
const secret = "abcdefghijklmnopqrstuvwxyz0123456789"
const credentials = { email: "owner@example.com", password: "correct-horse-battery" }

function useDefinition(runtime: { secret?: string } = { secret }): void {
  const db: Record<string, unknown[]> = { account: [], session: [], user: [], verification: [] }
  definition.current = defineFixedAuth({
    emailAndPassword: { enabled: true },
    database: memoryAdapter(db),
    ...runtime,
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
    for (const name of ["VITEHUB_SECRET", "BETTER_AUTH_SECRET", "BETTER_AUTH_SECRETS", "AUTH_SECRET"]) vi.stubEnv(name, undefined)
    useDefinition({})
    const env = { VITEHUB_SECRET: secret }
    const response = await authRoute.fetch(nitroRequest(
      authRequest("sign-up/email", { ...credentials, name: "Owner" }),
      env,
    ))

    expect(response.status).toBe(200)
    const cookie = response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ")
    const session = await authRoute.fetch(nitroRequest(authRequest("get-session", undefined, { cookie }), env))
    expect(await session.json()).toMatchObject({ user: { email: credentials.email } })

    const otherSecret = await authRoute.fetch(nitroRequest(
      authRequest("get-session", undefined, { cookie }),
      { VITEHUB_SECRET: `${secret}-other` },
    ))
    expect(await otherSecret.json()).toBeNull()
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
