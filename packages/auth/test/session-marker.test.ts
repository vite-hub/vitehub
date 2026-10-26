import { memoryAdapter } from "better-auth/adapters/memory"
import { describe, expect, it } from "vitest"
import { defineAuth } from "../src/index.ts"
import { handleAuthRequest } from "../src/server.ts"
import { authSessionMarkerCookie } from "../src/session-marker.ts"

import type { AuthDefinition } from "../src/index.ts"

const origin = "https://app.example.com"
const secret = "vitehub-session-marker-test-secret-2f8a9c1e7b"

function createDefinition(): AuthDefinition {
  return defineAuth({
    emailAndPassword: { enabled: true },
    runtime: { baseURL: origin, database: memoryAdapter({ account: [], session: [], user: [], verification: [] }), secret },
    session: { expiresIn: 3600 },
  })
}

function post(definition: AuthDefinition, path: string, body: unknown, cookie?: string): Promise<Response> {
  return handleAuthRequest(definition, new Request(`${origin}/api/auth/${path}`, {
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
