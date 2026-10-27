import { memoryAdapter } from "better-auth/adapters/memory"
import { describe, expect, it } from "vitest"
import { defineAuth } from "../src/index.ts"
import { createAuth, getAuthForDefinition, handleAuthRequest } from "../src/server.ts"
import { authSessionMarkerCookie } from "../src/session-marker.ts"

import type { AuthDefinition } from "../src/index.ts"
import type { BetterAuthPlugin } from "better-auth"

const origin = "https://app.example.com"
const secret = "vitehub-session-marker-test-secret-2f8a9c1e7b"

function createDefinition(plugins: BetterAuthPlugin[] = []): AuthDefinition {
  return defineAuth({
    emailAndPassword: { enabled: true },
    plugins,
    runtime: { baseURL: origin, database: memoryAdapter({ account: [], session: [], user: [], verification: [] }), secret },
    session: { expiresIn: 3600 },
  })
}

function post(definition: AuthDefinition, path: string, body: unknown, cookie?: string, handler = (request: Request) => handleAuthRequest(definition, request)): Promise<Response> {
  return handler(new Request(`${origin}/api/auth/${path}`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", origin, ...(cookie ? { cookie } : {}) },
    method: "POST",
  }))
}

function find(response: Response, name: string): string | undefined {
  return response.headers.getSetCookie().find(cookie => cookie.startsWith(`${name}=`))
}

const account = { email: "ada@example.com", name: "Ada", password: "passwordpassword" }

describe("session marker cookie", () => {
  it.each([
    ["handleAuthRequest", (definition: AuthDefinition) => (request: Request) => handleAuthRequest(definition, request)],
    ["createAuth.handler", (definition: AuthDefinition) => createAuth(definition).handler],
    ["getAuthForDefinition.handler", (definition: AuthDefinition) => getAuthForDefinition(definition).handler],
    ["createAuth.fetch", (definition: AuthDefinition) => createAuth(definition).fetch],
  ] as const)("tracks session creation and clearing after a user response hook through %s", async (_name, createHandler) => {
    const definition = createDefinition([{
      id: "application-response",
      onResponse(response) {
        const headers = new Headers(response.headers)
        headers.set("x-application-response", "1")
        // A returned response ends Better Auth's response hook pipeline.
        return { response: new Response(response.body, { headers, status: response.status }) }
      },
    }])
    const handler = createHandler(definition)
    const signUp = await post(definition, "sign-up/email", account, undefined, handler)
    expect(signUp.status).toBe(200)
    expect(signUp.headers.get("x-application-response")).toBe("1")
    expect.soft(find(signUp, authSessionMarkerCookie)).toMatch(/^vitehub_session=1;/)
    expect(await signUp.clone().json()).toMatchObject({ user: { email: account.email } })

    const cookie = signUp.headers.getSetCookie().map(value => value.split(";")[0]).join("; ")
    const signOut = await post(definition, "sign-out", {}, cookie, handler)
    expect(signOut.status).toBe(200)
    expect(signOut.headers.get("x-application-response")).toBe("1")
    expect(find(signOut, authSessionMarkerCookie)).toMatch(/^vitehub_session=;.*Max-Age=0/i)
  })

  it("uses the request's resolved cookie name with a dynamic cross-subdomain configuration", async () => {
    const definition = createDefinition([{ id: "passthrough", onResponse: response => ({ response }) }])
    const auth = createAuth(definition, {
      advanced: {
        cookies: { session_token: { name: "app_session" } },
        crossSubDomainCookies: { enabled: true },
      },
      baseURL: { allowedHosts: ["app.example.com"], protocol: "auto" },
    })
    const signUp = await post(definition, "sign-up/email", account, undefined, auth.handler)
    expect(signUp.status).toBe(200)
    expect(find(signUp, "__Secure-app_session")).toBeDefined()
    const marker = find(signUp, authSessionMarkerCookie)
    expect(marker).toMatch(/^vitehub_session=1;/)
    expect(marker).toMatch(/Domain=app.example.com/i)
    expect(marker).toMatch(/Secure/i)

    const cookie = signUp.headers.getSetCookie().map(value => value.split(";")[0]).join("; ")
    const signOut = await post(definition, "sign-out", {}, cookie, auth.fetch)
    expect(signOut.status).toBe(200)
    expect(find(signOut, authSessionMarkerCookie)).toMatch(/^vitehub_session=;.*Max-Age=0/i)
  })

  it("sets a readable marker with the session cookie's lifetime when a session starts, and clears it on sign-out", async () => {
    const definition = createDefinition()
    const signUp = await post(definition, "sign-up/email", account)
    expect(signUp.status).toBe(200)
    const sessionCookie = signUp.headers.getSetCookie().find(cookie => /session_token=/.test(cookie))!
    const marker = find(signUp, authSessionMarkerCookie)!
    expect(marker).toBeDefined()
    expect(marker.split(";")[0]).toBe(`${authSessionMarkerCookie}=1`)
    expect(marker).not.toMatch(/httponly/i)
    // Same attributes as the session cookie, except for HttpOnly.
    for (const attribute of ["Max-Age", "Path", "SameSite", "Secure"]) {
      expect(marker.match(new RegExp(`${attribute}(=[^;]*)?`, "i"))?.[0]).toBe(sessionCookie.match(new RegExp(`${attribute}(=[^;]*)?`, "i"))?.[0])
    }
    expect(sessionCookie).toMatch(/httponly/i)

    const cookie = signUp.headers.getSetCookie().map(value => value.split(";")[0]).join("; ")
    const signOut = await post(definition, "sign-out", {}, cookie)
    const cleared = find(signOut, authSessionMarkerCookie)!
    expect(cleared).toMatch(/^vitehub_session=;/)
    expect(cleared).toMatch(/Max-Age=0/i)
    expect(cleared).not.toMatch(/httponly/i)
  })

  it("leaves a response that does not touch the session cookie alone", async () => {
    const response = await handleAuthRequest(createDefinition(), new Request(`${origin}/api/auth/get-session`))
    expect(response.headers.getSetCookie().filter(cookie => cookie.startsWith(`${authSessionMarkerCookie}=`))).toEqual([])
  })

  it("keeps the marker out of a failed sign-in", async () => {
    const response = await post(createDefinition(), "sign-in/email", { email: "nobody@example.com", password: "passwordpassword" })
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(find(response, authSessionMarkerCookie)).toBeUndefined()
  })
})
