import { memoryAdapter } from "better-auth/adapters/memory"
import { afterEach, describe, expect, it } from "vitest"

import { handleAuthRequest, resetAuth } from "../src/internal/server.ts"
import { defineFixedAuth } from "./fixed-auth.ts"

const origin = "http://localhost:3000"
const db: Record<string, Record<string, unknown>[]> = {}
const options = {
  access: { signIn: { provider: "github", callbackURL: "/home" } },
  database: memoryAdapter(db),
  emailAndPassword: { enabled: true },
  secret: "vitehub-sign-in-route-secret-3f9a1c7e5b",
  socialProviders: { github: { clientId: "github-client", clientSecret: "github-secret" } },
}
const definition = defineFixedAuth(options)

afterEach(() => {
  resetAuth()
})

function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return handleAuthRequest(definition, new Request(`${origin}${path}`, { headers: { accept: "text/html", ...headers } }))
}

async function signUp(): Promise<string> {
  Object.assign(db, { account: [], session: [], user: [], verification: [] })
  const response = await handleAuthRequest(definition, new Request(`${origin}/api/auth/sign-up/email`, {
    body: JSON.stringify({ email: "ada@example.com", name: "Ada", password: "passwordpassword" }),
    headers: { "content-type": "application/json", origin },
    method: "POST",
  }))
  expect(response.status).toBe(200)
  return response.headers.getSetCookie().map(cookie => cookie.split(";")[0]).filter(pair => !pair?.endsWith("=")).join("; ")
}

describe("GET <basePath>/sign-in", () => {
  it("starts access.signIn and comes back to ?redirect=", async () => {
    Object.assign(db, { account: [], session: [], user: [], verification: [] })
    const response = await get("/api/auth/sign-in?redirect=%2Fdocs%3Ftab%3Dexamples")

    expect(response.status).toBe(302)
    expect(new URL(response.headers.get("location")!).origin).toBe("https://github.com")
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.getSetCookie().some(cookie => cookie.includes("state"))).toBe(true)
    expect(JSON.stringify(db.verification)).toContain(String.raw`\"callbackURL\":\"/docs?tab=examples\"`)
  })

  it("uses access.signIn.callbackURL without ?redirect=", async () => {
    Object.assign(db, { account: [], session: [], user: [], verification: [] })
    expect((await get("/api/auth/sign-in")).status).toBe(302)
    expect(JSON.stringify(db.verification)).toContain(String.raw`\"callbackURL\":\"/home\"`)
  })

  it("sends a signed-in visitor straight to ?redirect=", async () => {
    const cookie = await signUp()
    const response = await get("/api/auth/sign-in?redirect=/docs", { cookie })

    expect(response.status).toBe(302)
    expect(response.headers.get("location")).toBe("/docs")
    expect(db.verification).toHaveLength(0)
  })

  it.each(["https://evil.example/docs", "//evil.example/docs", "/\\evil.example/docs", "/\tdocs", "docs"])("refuses ?redirect=%s with 400", async (redirect) => {
    const response = await get(`/api/auth/sign-in?redirect=${encodeURIComponent(redirect)}`)

    expect(response.status).toBe(400)
    expect(response.headers.get("location")).toBeNull()
  })
})

describe("GET <basePath>/sign-out", () => {
  it("ends the session and goes to ?redirect=", async () => {
    const cookie = await signUp()
    const response = await get("/api/auth/sign-out?redirect=/bye", { cookie, "sec-fetch-site": "same-origin" })

    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe("/bye")
    expect(response.headers.getSetCookie().some(value => value.includes("session_token=;"))).toBe(true)
    expect(db.session).toHaveLength(0)
  })

  it("goes to / without ?redirect=, also from a typed URL", async () => {
    const cookie = await signUp()
    const response = await get("/api/auth/sign-out", { cookie, "sec-fetch-site": "none" })

    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe("/")
    expect(db.session).toHaveLength(0)
  })

  it.each(["cross-site", "same-site"])("refuses a %s request and keeps the session", async (site) => {
    const cookie = await signUp()
    const response = await get("/api/auth/sign-out?redirect=/bye", { cookie, "sec-fetch-site": site })

    expect(response.status).toBe(403)
    expect(response.headers.getSetCookie()).toEqual([])
    expect(db.session).toHaveLength(1)
  })

  it("refuses an external ?redirect= and keeps the session", async () => {
    const cookie = await signUp()
    const response = await get("/api/auth/sign-out?redirect=//evil.example", { cookie })

    expect(response.status).toBe(400)
    expect(db.session).toHaveLength(1)
  })
})

describe("without access.signIn", () => {
  it("leaves both paths to Better Auth", async () => {
    const plain = defineFixedAuth({ ...options, access: {} })
    const signIn = await handleAuthRequest(plain, new Request(`${origin}/api/auth/sign-in?redirect=/docs`))
    const signOut = await handleAuthRequest(plain, new Request(`${origin}/api/auth/sign-out`, { headers: { "sec-fetch-site": "same-origin" } }))

    expect(signIn.status).toBe(404)
    expect(signOut.status).not.toBe(303)
  })
})
