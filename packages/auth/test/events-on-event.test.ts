import { afterEach, expect, it, vi } from "vitest"
import { getMigrations } from "better-auth/db/migration"
import { admin } from "better-auth/plugins"
import { createDatabaseAuthEventStore, defineAuth } from "../src/index.ts"
import { createBetterAuthOptions, handleAuthRequest } from "../src/internal/server.ts"
import { eventDatabase } from "./event-helpers.ts"
import { defineFixedAuth } from "./fixed-auth.ts"
import { requestEvent } from "./request-event.ts"
import type { AuthEvent, AuthEventsConfiguration } from "../src/events.ts"

const origin = "http://localhost:3000"
const databases: ReturnType<typeof eventDatabase>[] = []
afterEach(() => { databases.splice(0).forEach(db => db.sqlite.close()); vi.restoreAllMocks() })
function cookies(response: Response) { return response.headers.getSetCookie().map(value => value.split(";")[0]).filter(value => !value?.endsWith("=")).join("; ") }

async function setup(onEvent: NonNullable<AuthEventsConfiguration["onEvent"]>) {
  const database = eventDatabase(); databases.push(database)
  const store = createDatabaseAuthEventStore({ db: database.db })
  const definition = defineFixedAuth({
    emailAndPassword: { enabled: true },
    plugins: [admin()],
    events: { store, onEvent },
    database: database.sqlite,
    secret: "auth-events-test-secret-12345678901234567890",
    baseURL: origin,
  })
  await (await getMigrations(createBetterAuthOptions(definition))).runMigrations()
  const request = (path: string, body?: object, cookie?: string) => new Request(`${origin}/api/auth/${path}`, {
    method: body ? "POST" : "GET", body: body ? JSON.stringify(body) : undefined,
    headers: { "content-type": "application/json", origin, "user-agent": "Mozilla/5.0 (Macintosh)", ...(cookie ? { cookie } : {}) },
  })
  const send = (path: string, body?: object, cookie?: string) => handleAuthRequest(definition, request(path, body, cookie))
  const signUp = async (name: string) => {
    const response = await send("sign-up/email", { name, email: `${name}@example.com`, password: "passwordpassword" })
    expect(response.status).toBe(200)
    const { user } = await response.json() as { user: { id: string } }
    return { id: user.id, cookie: cookies(response) }
  }
  return { definition, store, request, send, signUp, sqlite: database.sqlite }
}

it("gives onEvent each stored event for sign-up, sign-in, sign-out, and a role change", async () => {
  const seen: AuthEvent[] = []
  const app = await setup((event) => { seen.push(event) })
  const owner = await app.signUp("owner")
  app.sqlite.prepare("UPDATE user SET role = 'admin' WHERE id = ?").run(owner.id)
  const member = await app.signUp("member")
  const signIn = await app.send("sign-in/email", { email: "member@example.com", password: "passwordpassword" })
  expect(signIn.status).toBe(200)
  expect((await app.send("admin/set-role", { userId: member.id, role: "admin" }, owner.cookie)).status).toBe(200)
  expect((await app.send("sign-out", {}, cookies(signIn))).status).toBe(200)

  const ofMember = seen.filter(event => event.userId === member.id)
  expect(ofMember.map(event => event.type)).toEqual(["user.signed_up", "user.signed_in", "user.signed_in", "user.role_changed", "user.signed_out"])
  expect(ofMember[0]).toMatchObject({ actor: `user:${member.id}`, metadata: { method: "email-password" } })
  expect(ofMember[2]).toMatchObject({ actor: `user:${member.id}`, metadata: { method: "email-password", device: "desktop", sessionId: expect.any(String) } })
  expect(ofMember[3]).toMatchObject({ actor: `user:${owner.id}`, metadata: { role: "admin" } })
  expect(ofMember[4]).toMatchObject({ actor: `user:${member.id}`, metadata: { sessionId: ofMember[2]!.metadata.sessionId } })
  // The callback gets the same events that the log keeps.
  const stored = (await app.store.list({ limit: 200 })).events
  expect([...seen].sort((a, b) => a.id.localeCompare(b.id))).toEqual([...stored].sort((a, b) => a.id.localeCompare(b.id)))
})

it("logs a failing onEvent with a code and keeps the request and the stored event", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {})
  const app = await setup(() => { throw new Error("webhook down") })
  const user = await app.signUp("user")
  expect(user.id).toMatch(/\S/)
  expect((await app.store.list({ type: "user.signed_up" })).events).toHaveLength(1)
  expect(error).toHaveBeenCalledWith(expect.objectContaining({ code: "AUTH_EVENT_CALLBACK_FAILED", cause: expect.objectContaining({ message: "webhook down" }) }))
})

it("hands onEvent to the host waitUntil, so it does not delay the response", async () => {
  let release!: () => void
  const blocked = new Promise<void>((resolve) => { release = resolve })
  const seen: string[] = []
  const app = await setup(async (event) => { await blocked; seen.push(event.type) })
  const tasks: Promise<unknown>[] = []
  const event = requestEvent(app.request("sign-up/email", { name: "late", email: "late@example.com", password: "passwordpassword" }))
  Object.defineProperty(event["~standard"], "waitUntil", { value: (task: Promise<unknown>) => { tasks.push(task) } })
  const response = await handleAuthRequest(app.definition, event)
  expect(response.status).toBe(200)
  expect(seen).toEqual([])
  expect(tasks.length).toBeGreaterThan(0)
  release()
  await Promise.all(tasks)
  expect(seen).toEqual(expect.arrayContaining(["user.signed_up", "user.signed_in"]))
})

it("rejects an onEvent that is not a function", () => {
  const store = createDatabaseAuthEventStore({ db: eventDatabase().db })
  expect(() => defineAuth({ events: { store, onEvent: "https://example.com" } as unknown as AuthEventsConfiguration })).toThrow("events.onEvent must be")
})
