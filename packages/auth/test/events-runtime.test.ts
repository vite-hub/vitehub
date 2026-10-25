import { afterEach, expect, it, vi } from "vitest"
import { defineAuth, createDatabaseAuthEventStore } from "../src/index.ts"
import { createBetterAuthOptions, getAuthEvents, handleAuthRequest } from "../src/server.ts"
import { readAuthEventConsoleRecords } from "../src/runtime/console.ts"
import { eventDatabase } from "./event-helpers.ts"
import type { AuthEventsConfiguration, AuthEventStore } from "../src/events.ts"

const state = vi.hoisted(() => ({ events: false as false | AuthEventsConfiguration }))
vi.mock("#vitehub/auth/definition", () => ({ default: { options: () => ({ events: state.events }) } }))
afterEach(() => { state.events = false; vi.restoreAllMocks() })

it("exposes the same store through the runtime reader and returns no records when disabled", async () => {
  expect(await readAuthEventConsoleRecords()).toEqual([])
  const { db, sqlite } = eventDatabase()
  try {
    const store = createDatabaseAuthEventStore({ db })
    state.events = { store }
    expect(getAuthEvents()).toBe(store)
    await store.append({ id: "a", time: new Date().toISOString(), type: "user.banned", actor: "user:admin", userId: "user", metadata: {} })
    expect(await readAuthEventConsoleRecords()).toMatchObject([{ id: "a", cells: { type: "user.banned", actor: "user:admin", user: "user" } }])
  }
  finally { sqlite.close() }
})

it("rejects malformed event configuration before an auth operation", () => {
  expect(() => defineAuth({ events: {} as AuthEventsConfiguration })).toThrow("events needs a store")
  const definition = defineAuth(() => ({ events: { store: {} as AuthEventStore } }))
  expect(() => createBetterAuthOptions(definition)).toThrow("events needs a store")
})

it("does not break completed auth when logging fails and does not expose a reader by default", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
  const definition = defineAuth({
    emailAndPassword: { enabled: true }, runtime: { secret: "auth-events-test-secret-12345678901234567890" },
    events: { store: { append: async () => { throw new Error("private provider diagnostic") }, list: async () => ({ events: [] }), aggregate: async () => { throw new Error("unused") } } },
  })
  const response = await handleAuthRequest(definition, new Request("http://localhost:3000/api/auth/sign-up/email", {
    method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify({ name: "User", email: "user@example.com", password: "passwordpassword" }),
  }))
  expect(response.status).toBe(200)
  expect(warning).toHaveBeenCalledWith("[vitehub] AUTH_EVENT_WRITE_FAILED: Could not record an auth event.")
  expect(JSON.stringify(warning.mock.calls)).not.toContain("private provider diagnostic")
  expect((await handleAuthRequest(definition, new Request("http://localhost:3000/api/auth/vitehub/events"))).status).toBe(404)
})
