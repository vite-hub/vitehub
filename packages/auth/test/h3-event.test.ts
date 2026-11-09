import { defineHandler } from "h3"
import { memoryAdapter } from "better-auth/adapters/memory"
import { installStandardContext } from "@vite-hub/runtime/internal/h3"
import { afterEach, describe, expect, it } from "vitest"

import { defineAuth } from "../src/index.ts"
import { createAuthAccessHandler, handleAuthRequest, resetAuth, toAuthRequest, withAuth } from "../src/internal/server.ts"

import type { H3Event } from "h3"
import type { ViteHubContext } from "@vite-hub/runtime"

type EventHandler = (event: H3Event & ViteHubContext) => Promise<Response | unknown>

const origin = "https://example.com"

afterEach(() => {
  resetAuth()
})

function serve(handler: EventHandler) {
  const app = defineHandler(async (event) => {
    installStandardContext(event)
    return handler(event)
  })
  return (path: string, init?: RequestInit) => app.fetch(new Request(new URL(path, origin), init))
}

function createDefinition() {
  const db: Record<string, unknown[]> = { account: [], session: [], user: [], verification: [] }
  return defineAuth({
    access: { routes: ["/private/**"] },
    appName: "ViteHub",
    emailAndPassword: { enabled: true },
    runtime: { database: memoryAdapter(db), secret: "abcdefghijklmnopqrstuvwxyz0123456789" },
  })
}

describe("H3 2 server events", () => {
  it("signs a user in through Auth routes, withAuth, and access middleware", async () => {
    const definition = createDefinition()
    const access = createAuthAccessHandler([{ route: "/private/**" }], definition)
    const guarded = withAuth((_event, authorization) => ({ email: authorization.user.email }), definition)
    const fetchEvent = serve(async (event) => {
      const pathname = new URL(event.req.url).pathname
      if (pathname.startsWith("/api/auth/")) return handleAuthRequest(definition, event)
      if (pathname.startsWith("/private/")) return await access(event) ?? Response.json({ private: true })
      return guarded(event)
    })
    const headers = { "content-type": "application/json", origin }
    const credentials = { email: "h3@example.com", password: "passwordpassword" }

    const signUp = await fetchEvent("/api/auth/sign-up/email", { body: JSON.stringify({ ...credentials, name: "H3 2" }), headers, method: "POST" })
    expect(signUp.status).toBe(200)
    const signIn = await fetchEvent("/api/auth/sign-in/email", { body: JSON.stringify(credentials), headers, method: "POST" })
    expect(signIn.status).toBe(200)
    const cookie = signIn.headers.getSetCookie().map(value => value.split(";")[0]).join("; ")

    expect(await (await fetchEvent("/api/auth/get-session", { headers: { cookie } })).json()).toMatchObject({ user: { email: credentials.email } })
    expect(await (await fetchEvent("/api/data", { headers: { cookie } })).json()).toEqual({ email: credentials.email })
    expect((await fetchEvent("/api/data")).status).toBe(401)
    expect(await (await fetchEvent("/private/page", { headers: { cookie } })).json()).toEqual({ private: true })
    expect((await fetchEvent("/private/page")).status).toBe(401)
  })

  it("keeps the app base path in the Standard Context request", async () => {
    let url: string | undefined
    const fetchEvent = serve(async (event) => {
      url = toAuthRequest(event).url
      return Response.json({ path: new URL(event.req.url).pathname })
    })

    expect(await (await fetchEvent("/app/api/auth/get-session?x=1")).json()).toEqual({ path: "/app/api/auth/get-session" })
    expect(url).toBe(`${origin}/app/api/auth/get-session?x=1`)
  })
})
