import { memoryAdapter } from "better-auth/adapters/memory"
import { describe, expect, it, vi } from "vitest"
import { defineAuth } from "../src/index.ts"
import { createAuth, handleAuthRequest, withAuth } from "../src/server.ts"

import type { AuthDefinition, AuthSessionRefresh } from "../src/index.ts"

const origin = "http://localhost:3000"
const secret = "vitehub-session-refresh-test-secret-2f8a9c1e7b"
const day = 24 * 60 * 60 * 1000

interface MemoryRow { [key: string]: unknown }

function createStoredAuth(onRefresh: AuthSessionRefresh, updateAge = 0) {
  const db: Record<string, MemoryRow[]> = { account: [], session: [], user: [], verification: [] }
  const definition = defineAuth({
    emailAndPassword: { enabled: true },
    runtime: { database: memoryAdapter(db), secret },
    session: {
      additionalFields: { plan: { required: false, type: "string" } },
      // 0 refreshes on every read, so one request reaches the refresh path.
      updateAge,
      onRefresh,
    },
  })
  return { db, definition }
}

function cookieHeader(response: Response): string {
  return response.headers.getSetCookie()
    .map(cookie => cookie.split(";")[0])
    .filter(pair => !pair?.endsWith("="))
    .join("; ")
}

async function signUp(definition: AuthDefinition): Promise<string> {
  const response = await handleAuthRequest(definition, new Request(`${origin}/api/auth/sign-up/email`, {
    body: JSON.stringify({ email: "ada@example.com", name: "Ada", password: "passwordpassword" }),
    headers: { "content-type": "application/json", origin },
    method: "POST",
  }))
  expect(response.status).toBe(200)
  return cookieHeader(response)
}

function request(definition: AuthDefinition, path: string, cookie: string): Promise<Response> {
  return handleAuthRequest(definition, new Request(`${origin}/api/auth/${path}`, { headers: { cookie } }))
}

function getSession(definition: AuthDefinition, cookie: string): Promise<Response> {
  return request(definition, "get-session", cookie)
}

/** Moves the stored expiry close, so a slide is visible. */
function expireSoon(db: Record<string, MemoryRow[]>): Date {
  const expiresAt = new Date(Date.now() + 60_000)
  db.session![0]!.expiresAt = expiresAt
  return expiresAt
}

describe("session.onRefresh with a database", () => {
  it("extends the session on refresh()", async () => {
    const onRefresh = vi.fn<AuthSessionRefresh>(({ refresh }) => refresh())
    const { definition, db } = createStoredAuth(onRefresh)
    const cookie = await signUp(definition)
    const before = expireSoon(db)

    const response = await getSession(definition, cookie)

    expect(response.status).toBe(200)
    expect(onRefresh).toHaveBeenCalledOnce()
    expect(onRefresh.mock.calls[0]![0]).toMatchObject({
      session: { expiresAt: before, userId: expect.any(String) },
      user: { email: "ada@example.com" },
    })
    const expiresAt = new Date(db.session![0]!.expiresAt as Date).getTime()
    expect(expiresAt).toBeGreaterThan(before.getTime() + 6 * day)
  })

  it("writes session fields on refresh(fields)", async () => {
    const { definition, db } = createStoredAuth(({ refresh }) => refresh({ plan: "pro" }))
    const cookie = await signUp(definition)
    const before = expireSoon(db)

    const response = await getSession(definition, cookie)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ session: { plan: "pro" } })
    expect(db.session![0]).toMatchObject({ plan: "pro" })
    expect(new Date(db.session![0]!.expiresAt as Date).getTime()).toBeGreaterThan(before.getTime() + 6 * day)
  })

  it("keeps the current expiry when the hook calls neither", async () => {
    const onRefresh = vi.fn<AuthSessionRefresh>()
    const { definition, db } = createStoredAuth(onRefresh)
    const cookie = await signUp(definition)
    const before = expireSoon(db)

    const response = await getSession(definition, cookie)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ user: { email: "ada@example.com" } })
    expect(onRefresh).toHaveBeenCalledOnce()
    expect(new Date(db.session![0]!.expiresAt as Date).getTime()).toBe(before.getTime())
  })

  it("ends the session on clear()", async () => {
    const { definition, db } = createStoredAuth(({ clear, refresh }) => {
      clear()
      refresh()
    })
    const cookie = await signUp(definition)

    const response = await getSession(definition, cookie)

    expect(response.status).toBe(401)
    expect(response.headers.getSetCookie().some(value => /^better-auth\.session_token=;.*Max-Age=0/i.test(value))).toBe(true)
    expect(db.session).toHaveLength(0)
    expect(await (await getSession(definition, cookie)).json()).toBeNull()
  })

  it("answers 401 from withAuth() after clear()", async () => {
    const { definition, db } = createStoredAuth(({ clear }) => clear())
    const cookie = await signUp(definition)
    const handler = vi.fn(() => new Response("ok"))

    const response = await withAuth(handler, definition)(new Request(`${origin}/private`, { headers: { accept: "application/json", cookie } }))

    expect(response.status).toBe(401)
    expect(handler).not.toHaveBeenCalled()
    expect(db.session).toHaveLength(0)
  })

  it("runs on refreshes from other session endpoints", async () => {
    const onRefresh = vi.fn<AuthSessionRefresh>(({ refresh }) => refresh())
    const { definition } = createStoredAuth(onRefresh)
    const cookie = await signUp(definition)

    const response = await request(definition, "list-sessions", cookie)

    expect(response.status).toBe(200)
    expect(onRefresh).toHaveBeenCalledOnce()
  })

  it("does not run for session updates that are not a refresh", async () => {
    const onRefresh = vi.fn<AuthSessionRefresh>(({ refresh }) => refresh())
    // A day of updateAge keeps the session middleware of /update-session from refreshing first.
    const { definition, db } = createStoredAuth(onRefresh, 24 * 60 * 60)
    const cookie = await signUp(definition)
    const response = await handleAuthRequest(definition, new Request(`${origin}/api/auth/update-session`, {
      body: JSON.stringify({ plan: "team" }),
      headers: { "content-type": "application/json", cookie, origin },
      method: "POST",
    }))

    expect(response.status).toBe(200)

    expect(db.session![0]).toMatchObject({ plan: "team" })
    expect(onRefresh).not.toHaveBeenCalled()
  })
})

describe("session.onRefresh without a database", () => {
  it("fails configuration, because Better Auth has no stateless refresh hook", () => {
    const definition = defineAuth({ session: { onRefresh: ({ refresh }) => refresh() } })

    expect(() => createAuth(definition, { secret })).toThrow(expect.objectContaining({ code: "AUTH_C0042" }))
  })

  it("rejects a value that is not a function", () => {
    // @ts-expect-error onRefresh must be a function.
    expect(() => defineAuth({ session: { onRefresh: true } })).toThrow(expect.objectContaining({ code: "AUTH_C0041" }))
  })

  // Pins the Better Auth gap: a stateless cookie cache refresh calls no database hook.
  // When this fails, Better Auth exposes a hook and ViteHub can support stateless sessions.
  it("Better Auth re-issues a stateless cookie cache without a session update hook", async () => {
    const before = vi.fn(async () => {})
    const definition = defineAuth({
      databaseHooks: { session: { update: { before } } },
      emailAndPassword: { enabled: true },
      runtime: { secret },
      session: { cookieCache: { enabled: true, maxAge: 300, refreshCache: { updateAge: 300 }, strategy: "jwe" } },
    })
    const cookie = await signUp(definition)

    const response = await getSession(definition, cookie)

    expect(response.status).toBe(200)
    expect(response.headers.getSetCookie().some(value => value.startsWith("better-auth.session_data="))).toBe(true)
    expect(before).not.toHaveBeenCalled()
  })
})
