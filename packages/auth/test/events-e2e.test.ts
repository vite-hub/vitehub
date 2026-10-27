import { afterEach, describe, expect, it, vi } from "vitest"
import { getMigrations } from "better-auth/db/migration"
import { APIError } from "better-auth"
import { createAuthMiddleware } from "better-auth/api"
import { admin, organization, siwe, twoFactor } from "better-auth/plugins"
import { defineAuth, createDatabaseAuthEventStore } from "../src/index.ts"
import { aggregateAuthEvents, createBetterAuthOptions, getAuthForDefinition, handleAuthRequest, listAuthEvents } from "../src/server.ts"
import { hubAuth } from "../src/vite.ts"
import { runViteHubCli } from "../../cli/src/index.ts"
import { eventDatabase } from "./event-helpers.ts"
import type { AuthDefinition, AuthRuntimeOptions } from "../src/types.ts"

const origin = "http://localhost:3000"
const databases: ReturnType<typeof eventDatabase>[] = []
afterEach(() => { databases.splice(0).forEach(db => db.sqlite.close()); vi.restoreAllMocks() })
function cookies(response: Response) { return response.headers.getSetCookie().map(value => value.split(";")[0]).filter(value => !value?.endsWith("=")).join("; ") }
async function setup(overrides: AuthRuntimeOptions = {}) {
  const { sqlite, db } = eventDatabase(); databases.push({ sqlite, db, queries: [] })
  const store = createDatabaseAuthEventStore({ db })
  const userHook = vi.fn()
  let otp = ""
  const definition = defineAuth({
    emailAndPassword: { enabled: true },
    plugins: [admin(), organization(), twoFactor({ skipVerificationOnEnable: true, otpOptions: { sendOTP: async (input) => { otp = input.otp } } })],
    databaseHooks: { user: { create: { after: userHook } } },
    events: { store, authorize: ({ user }) => user.role === "admin" },
    runtime: { database: sqlite, secret: "auth-events-test-secret-12345678901234567890", baseURL: origin, ...overrides },
  })
  await (await getMigrations(createBetterAuthOptions(definition))).runMigrations()
  const request = (path: string, body?: object, cookie?: string) => handleAuthRequest(definition, new Request(`${origin}/api/auth/${path}`, {
    method: body ? "POST" : "GET", body: body ? JSON.stringify(body) : undefined,
    headers: { "content-type": "application/json", origin, "user-agent": "Mozilla/5.0 (iPhone) Mobile", "x-forwarded-for": "192.0.2.42", ...(cookie ? { cookie } : {}) },
  }))
  const signUp = async (name: string) => {
    const response = await request("sign-up/email", { name, email: `${name}@example.com`, password: "passwordpassword" })
    expect(response.status).toBe(200)
    const result = await response.json() as { user: { id: string }, token: string }
    return { id: result.user.id, token: result.token, cookie: cookies(response) }
  }
  return { definition, store, request, signUp, sqlite, userHook, otp: () => otp }
}

describe("auth events with real Better Auth and Node SQLite", () => {
  it("records signup, signin, admin actions, revoke, signout and aggregates through code and CLI", async () => {
    const { definition, store, request, signUp, sqlite, userHook } = await setup()
    const owner = await signUp("owner")
    sqlite.prepare("UPDATE user SET role = 'admin' WHERE id = ?").run(owner.id)
    const user = await signUp("member")
    expect(userHook).toHaveBeenCalledTimes(2)
    const signin = await request("sign-in/email", { email: "member@example.com", password: "passwordpassword" })
    expect(signin.status).toBe(200)
    const signedIn = await signin.json() as { token: string }
    expect((await request("sign-in/email", { email: "missing@example.com", password: "bad-password" })).status).toBe(401)
    expect((await request("admin/update-user", { userId: user.id, data: { name: "New Name" } }, owner.cookie)).status).toBe(200)
    expect((await request("admin/set-role", { userId: user.id, role: "admin" }, owner.cookie)).status).toBe(200)
    expect((await request("admin/set-role", { userId: user.id, role: "user" }, owner.cookie)).status).toBe(200)
    expect((await request("admin/revoke-user-session", { sessionToken: signedIn.token }, owner.cookie)).status).toBe(200)
    expect((await request("admin/ban-user", { userId: user.id, banReason: "private reason" }, owner.cookie)).status).toBe(200)
    expect((await request("admin/unban-user", { userId: user.id }, owner.cookie)).status).toBe(200)
    const newSignIn = await request("sign-in/email", { email: "member@example.com", password: "passwordpassword" })
    expect((await request("sign-out", {}, cookies(newSignIn))).status).toBe(200)
    const page = await listAuthEvents({ limit: 200 }, definition)
    expect(page.events.map(event => event.type)).toEqual(expect.arrayContaining(["user.signed_up", "user.signed_in", "sign_in.failed", "user.updated", "user.role_changed", "session.revoked", "user.banned", "user.unbanned", "user.signed_out"]))
    expect(page.events.find(event => event.type === "user.banned")).toMatchObject({ actor: `user:${owner.id}`, userId: user.id, metadata: {} })
    expect(page.events.find(event => event.type === "user.updated")?.metadata).toEqual({ fields: ["name"] })
    expect(page.events.find(event => event.type === "user.signed_in")?.metadata).toMatchObject({ method: "email-password", device: "mobile" })
    expect(JSON.stringify(page)).not.toMatch(/passwordpassword|private reason|192\.0\.2|Mozilla|New Name/)
    expect(JSON.stringify(page)).not.toContain(user.token)
    expect(page.events.find(event => event.type === "sign_in.failed")).toMatchObject({ userId: null, actor: "system" })
    const window = { from: new Date(Date.now() - 86400_000).toISOString(), to: new Date(Date.now() + 1000).toISOString() }
    expect((await aggregateAuthEvents(window, definition)).totals).toEqual({ signUps: 2, signIns: 4, activeUsers: 2, methods: { "email-password": 4 } })
    expect((await request("vitehub/events")).status).toBe(401)
    expect((await request("vitehub/events?cursor=%25", undefined, owner.cookie)).status).toBe(400)
    const plainUser = await signUp("plain")
    expect((await request("vitehub/events", undefined, plainUser.cookie)).status).toBe(403)
    const output: string[] = []; const errors: string[] = []
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => handleAuthRequest(definition, new Request(String(input), init)))
    const context = { rootDir: ".", spawn: async () => ({ exitCode: 0 }), cwd: ".", env: { VITEHUB_AUTH_COOKIE: owner.cookie }, stdout: { write: (value: string | Uint8Array) => output.push(String(value)) }, stderr: { write: (value: string | Uint8Array) => errors.push(String(value)) } }
    const run = (args: string[]) => runViteHubCli({ ...context, args: ["auth", "events", ...args], loadConfig: async () => ({ root: ".", plugins: [hubAuth()], vitehubConfigResolved: true }) })
    expect(await run(["--url", `${origin}/api/auth`, "--type", "user.banned"])).toBe(0)
    expect(JSON.parse(output[0]!)).toMatchObject({ events: [{ type: "user.banned", userId: user.id }] })
    expect(errors).toEqual([])
    output.length = 0
    expect(await run(["--url", `${origin}/api/auth`, "--aggregate", "--from", window.from, "--to", window.to])).toBe(0)
    expect(JSON.parse(output[0]!).totals).toEqual((await store.aggregate(window)).totals)
  })
  it("records impersonation and organization membership without counting impersonation as a sign-in", async () => {
    const { definition, request, signUp, sqlite, store } = await setup()
    const owner = await signUp("owner"); const user = await signUp("member")
    sqlite.prepare("UPDATE user SET role = 'admin' WHERE id = ?").run(owner.id)
    const response = await request("admin/impersonate-user", { userId: user.id }, owner.cookie)
    expect(response.status).toBe(200)
    expect((await request("admin/stop-impersonating", {}, cookies(response))).status).toBe(200)
    const orgResponse = await request("organization/create", { name: "Team", slug: "team" }, owner.cookie)
    expect(orgResponse.status).toBe(200)
    const org = await orgResponse.json() as { id: string }
    const auth = getAuthForDefinition(definition)
    const member = await auth.api.addMember({ headers: new Headers({ cookie: owner.cookie }), body: { userId: user.id, organizationId: org.id, role: "member" } })
    expect((await request("organization/update-member-role", { memberId: member.id, organizationId: org.id, role: "admin" }, owner.cookie)).status).toBe(200)
    expect((await request("organization/remove-member", { memberIdOrEmail: member.id, organizationId: org.id }, owner.cookie)).status).toBe(200)
    const page = await store.list({ limit: 200 })
    expect(page.events.filter(event => event.type === "user.signed_in")).toHaveLength(2)
    for (const type of ["impersonation.started", "impersonation.stopped", "organization.member_added", "organization.member_removed", "organization.member_role_changed"]) {
      expect(page.events.find(event => event.type === type && event.userId === user.id), type).toMatchObject({ actor: `user:${owner.id}`, userId: user.id })
    }
    expect((await request("admin/remove-user", { userId: user.id }, owner.cookie)).status).toBe(200)
    expect((await store.list({ type: "user.removed" })).events[0]).toMatchObject({ actor: `user:${owner.id}`, userId: user.id })
  })
  it("counts completed two-factor sign-ins and ignores reads and session refresh", async () => {
    const app = await setup()
    const user = await app.signUp("twofactor")
    expect((await app.request("two-factor/enable", { password: "passwordpassword" }, user.cookie)).status).toBe(200)
    const before = (await app.store.list({ type: "user.signed_in" })).events.length
    const challenge = await app.request("sign-in/email", { email: "twofactor@example.com", password: "passwordpassword" })
    expect(await challenge.json()).toMatchObject({ twoFactorRedirect: true })
    expect((await app.store.list({ type: "user.signed_in" })).events).toHaveLength(before)
    const challengeCookie = cookies(challenge)
    expect((await app.request("two-factor/send-otp", {}, challengeCookie)).status).toBe(200)
    expect(app.otp()).not.toBe("")
    expect((await app.request("two-factor/verify-otp", { code: "incorrect" }, challengeCookie)).status).toBe(401)
    expect((await app.store.list({ type: "sign_in.failed" })).events).toHaveLength(1)
    const verified = await app.request("two-factor/verify-otp", { code: app.otp() }, challengeCookie)
    expect(verified.status).toBe(200)
    expect((await app.store.list({ type: "user.signed_in" })).events).toHaveLength(before + 1)
    expect((await app.store.list({ type: "user.signed_in" })).events[0]?.metadata.method).toBe("two-factor")
    expect((await app.request("get-session", undefined, cookies(verified))).status).toBe(200)
    expect((await app.store.list({ type: "user.signed_in" })).events).toHaveLength(before + 1)
  })

  it.each([false, true])("records secondary-storage deletions once (database: %s)", async (storeSessionInDatabase) => {
    const values = new Map<string, string>()
    const app = await setup({
      secondaryStorage: {
        get: async key => values.get(key) ?? null,
        set: async (key, value) => { values.set(key, value) },
        delete: async key => { values.delete(key) },
        getAndDelete: async (key) => {
          const value = values.get(key) ?? null
          values.delete(key)
          return value
        },
        increment: async (key) => {
          const value = Number(values.get(key) ?? 0) + 1
          values.set(key, String(value))
          return value
        },
      },
      session: storeSessionInDatabase ? { storeSessionInDatabase: true } : {},
    })
    const user = await app.signUp("secondary")
    const second = await app.request("sign-in/email", { email: "secondary@example.com", password: "passwordpassword" })
    const token = (await second.json() as { token: string }).token
    expect((await app.request("revoke-session", { token }, user.cookie)).status).toBe(200)
    expect((await app.store.list({ type: "session.revoked" })).events).toHaveLength(1)
    expect((await app.request("sign-out", {}, user.cookie)).status).toBe(200)
    expect((await app.store.list({ type: "user.signed_out" })).events).toHaveLength(1)
    const third = await app.request("sign-in/email", { email: "secondary@example.com", password: "passwordpassword" })
    expect((await app.request("revoke-sessions", {}, cookies(third))).status).toBe(200)
    expect((await app.store.list({ type: "session.revoked" })).events).toHaveLength(2)
    const fourth = await app.request("sign-in/email", { email: "secondary@example.com", password: "passwordpassword" })
    await app.request("sign-in/email", { email: "secondary@example.com", password: "passwordpassword" })
    expect((await app.request("revoke-other-sessions", {}, cookies(fourth))).status).toBe(200)
    expect((await app.store.list({ type: "session.revoked" })).events).toHaveLength(3)
    await (await getAuthForDefinition(app.definition).$context).internalAdapter.updateUser(user.id, { role: "admin" })
    const owner = await app.request("sign-in/email", { email: "secondary@example.com", password: "passwordpassword" })
    const member = await app.signUp("impersonated")
    const impersonation = await app.request("admin/impersonate-user", { userId: member.id }, cookies(owner))
    expect(impersonation.status).toBe(200)
    expect((await app.request("admin/stop-impersonating", {}, cookies(impersonation))).status).toBe(200)
    expect((await app.store.list({ type: "impersonation.stopped" })).events).toHaveLength(1)
  })

  it("atomically records concurrent secondary-storage deletions", async () => {
    const values = new Map<string, string>()
    let deleting = false
    let arrived = 0
    let release!: () => void
    const bothDeleting = new Promise<void>((resolve) => { release = resolve })
    const app = await setup({ secondaryStorage: {
      get: async (key) => {
        const value = values.get(key) ?? null
        if (deleting && key.startsWith("active-sessions-")) {
          if (++arrived === 2) release()
          await bothDeleting
        }
        return value
      },
      set: async (key, value) => { values.set(key, value) },
      delete: async key => { values.delete(key) },
      getAndDelete: async (key) => {
        const value = values.get(key) ?? null
        values.delete(key)
        return value
      },
      increment: async () => 1,
    } })
    const user = await app.signUp("concurrent")
    deleting = true
    await Promise.all([
      app.request("sign-out", {}, user.cookie),
      app.request("sign-out", {}, user.cookie),
    ])
    const events = (await app.store.list()).events.filter(event => event.type === "user.signed_out" || event.type === "session.revoked")
    expect(events).toHaveLength(1)
    expect(values.has(user.token)).toBe(false)
  })

  it.each([false, true])("uses the committed password mutation outcome (failure: %s)", async (failure) => {
    const app = await setup({ hooks: { after: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/admin/set-user-password") return
      return failure ? ctx.json({ replaced: true }) : new APIError("BAD_REQUEST")
    }) } })
    const user = await app.signUp("password-hook")
    await (await getAuthForDefinition(app.definition).$context).internalAdapter.updateUser(user.id, { role: "admin" })
    await app.request("admin/set-user-password", { userId: failure ? "missing-user" : user.id, newPassword: "newpasswordpassword" }, user.cookie)
    expect((await app.store.list({ type: "user.updated" })).events).toHaveLength(failure ? 0 : 1)
  })

  it.each(["list", "aggregate"] as const)("keeps %s store errors as server errors", async (operation) => {
    const database = eventDatabase(); databases.push(database)
    const store = createDatabaseAuthEventStore({ db: database.db })
    store[operation] = async () => { throw new TypeError("Backend unavailable") }
    const app = await setup({ events: { store, authorize: () => true } })
    const user = await app.signUp("store-error")
    const query = operation === "aggregate" ? "?aggregate=true&from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z" : ""
    expect((await app.request(`vitehub/events${query}`, undefined, user.cookie)).status).toBe(500)
    expect((await app.request("vitehub/events?cursor=%25", undefined, user.cookie)).status).toBe(400)
  })

  it.each(["throw", "return", "replace-failure"])("uses the endpoint outcome before an application after-hook: %s", async (mode) => {
    const app = await setup({ hooks: { after: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/sign-in/email") return
      if (mode === "replace-failure") return ctx.json({ replaced: true })
      if (mode === "throw") throw new APIError("BAD_REQUEST")
      return new APIError("BAD_REQUEST")
    }) } })
    await app.signUp("hook")
    await app.request("sign-in/email", { email: "hook@example.com", password: mode === "replace-failure" ? "incorrect-password" : "passwordpassword" })
    expect((await app.store.list({ type: "user.signed_in" })).events).toHaveLength(mode === "replace-failure" ? 1 : 2)
    expect((await app.store.list({ type: "sign_in.failed" })).events).toHaveLength(mode === "replace-failure" ? 1 : 0)
  })

  it("does not classify an invalid enrollment code as a failed sign-in", async () => {
    const app = await setup({ plugins: [twoFactor()] })
    const user = await app.signUp("enrollment")
    expect((await app.request("two-factor/enable", { password: "passwordpassword" }, user.cookie)).status).toBe(200)
    expect((await app.request("two-factor/verify-totp", { code: "invalid" }, user.cookie)).status).toBe(401)
    expect((await app.store.list({ type: "sign_in.failed" })).events).toHaveLength(0)
  })

  it("preserves custom authorization responses", async () => {
    const database = eventDatabase(); databases.push(database)
    const app = await setup({ events: { store: createDatabaseAuthEventStore({ db: database.db }), authorize: () => new Response("Try later", { status: 429, headers: { "retry-after": "60" } }) } })
    const user = await app.signUp("rejected")
    const response = await app.request("vitehub/events", undefined, user.cookie)
    expect(response.status).toBe(429)
    expect(response.headers.get("retry-after")).toBe("60")
    expect(await response.text()).toBe("Try later")
  })

  it("records failed SIWE nonce and signature verification", async () => {
    const verifyMessage = vi.fn(async () => false)
    const nonce = "authEventsNonce123"
    const app = await setup({ plugins: [siwe({ domain: "localhost:3000", getNonce: async () => nonce, verifyMessage })] })
    const message = [
      "localhost:3000 wants you to sign in with your Ethereum account:",
      "0x0000000000000000000000000000000000000001", "", "Sign in", "",
      `URI: ${origin}`, "Version: 1", "Chain ID: 1", `Nonce: ${nonce}`, `Issued At: ${new Date().toISOString()}`,
    ].join("\n")
    const verify = () => app.request("siwe/verify", { message, signature: "invalid-signature" })
    expect((await verify()).status).toBe(401)
    expect(verifyMessage).not.toHaveBeenCalled()
    expect((await app.request("siwe/nonce", {})).status).toBe(200)
    expect((await verify()).status).toBe(401)
    expect(verifyMessage).toHaveBeenCalledTimes(1)
    const failures = (await app.store.list({ type: "sign_in.failed" })).events
    expect(failures).toHaveLength(2)
    expect(failures.every(event => event.metadata.method === "siwe" && event.userId === null)).toBe(true)
    expect((await app.store.list({ type: "user.signed_in" })).events).toEqual([])
  })

  it("keeps database-free auth and existing hooks usable when events are disabled", async () => {
    const definition: AuthDefinition = defineAuth({ events: false, emailAndPassword: { enabled: true }, runtime: { secret: "auth-events-test-secret-12345678901234567890" } })
    const response = await handleAuthRequest(definition, new Request(`${origin}/api/auth/sign-up/email`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ name: "Memory", email: "memory@example.com", password: "passwordpassword" }) }))
    expect(response.status).toBe(200)
    await expect(listAuthEvents({}, definition)).rejects.toThrow("disabled")
  })
})
