import { describe, expect, it, vi } from "vitest"

import { defineComments } from "../src/index.ts"
import { commentsRealtime } from "../src/realtime.ts"
import { commentsConsoleSession } from "../src/runtime/console-session.ts"

import type { H3Event } from "h3"
import type { RealtimeAuthorizeContext } from "@vite-hub/realtime"

function event(): H3Event {
  // SAFETY: The definition only uses the event as a key and passes it to `identify`.
  return {} as H3Event
}

describe("commentsRealtime", () => {
  it.each([{ id: "custom", name: "Custom" }, null])("skips the Auth session when custom identify returns %j", async (person) => {
    const session = vi.fn(async () => { throw new Error("Auth unavailable") })
    const identify = vi.fn(() => person)
    const definition = commentsRealtime(defineComments({ identify, authorize: () => true }), { session })
    const context = { definition: "comments", event: event(), request: new Request("http://site.test") }
    const user = await definition.identify!(context)
    expect(user).toEqual(person)
    expect(await definition.authorize!({ ...context, documentId: "pages/x", mode: "read", user: user ?? null })).toBe(true)
    expect(identify).toHaveBeenCalled()
    expect(session).not.toHaveBeenCalled()
  })

  it.each(["authorize", "user", "identify"] as const)("denies Console session failures in %s before Comments identity or policy", async (source) => {
    for (const customIdentity of [false, true]) {
      const identify = vi.fn(() => ({ id: "custom", name: "Custom" }))
      const authorize = vi.fn(() => true)
      const fail = async () => { throw new Error("Console session unavailable") }
      const session = commentsConsoleSession({
        authorize: source === "authorize" ? fail : async () => true,
        user: source === "user" ? fail : async () => null,
        identify: source === "identify" ? fail : async () => null,
      })
      const definition = commentsRealtime(defineComments({ identify: customIdentity ? identify : undefined, authorize }), { consoleSession: session })
      const context = { definition: "comments", event: event(), request: new Request("http://site.test") }
      const user = await definition.identify!(context)
      expect(user).toBeNull()
      expect(await definition.authorize!({ ...context, documentId: "pages/x", mode: "read", user: user ?? null })).toBe(false)
      expect(identify).not.toHaveBeenCalled()
      expect(authorize).not.toHaveBeenCalled()
    }
  })

  it("preserves Console denial even when the Comments guest policy allows reading", async () => {
    const session = commentsConsoleSession({ authorize: async () => false, user: async () => null, identify: async () => null })
    const definition = commentsRealtime(defineComments({ authorize: () => true }), { consoleSession: session })
    const request = event()
    const context = { definition: "comments", event: request, request: new Request("http://site.test") }
    const user = await definition.identify!(context)
    expect(await definition.authorize!({ ...context, documentId: "pages/x", mode: "read", user: user ?? null })).toBe(false)
  })

  it("binds presence to a server-identified guest", async () => {
    const definition = commentsRealtime(defineComments({
      identify: () => ({ id: "external-guest", name: "Invited reviewer", guest: true }),
      authorize: ({ user }) => user?.id === "external-guest",
    }))
    const request = event()
    const context = { definition: "comments", event: request, request: new Request("http://site.test") }
    const user = await definition.identify!(context)
    expect(user).toEqual({ id: "external-guest", name: "Invited reviewer" })
    expect(await definition.authorize!({ ...context, documentId: "pages/x", mode: "read", user: user ?? null })).toBe(true)
  })

  it.each([true, false])("keeps Console guest awareness unbound while enforcing read access (%s)", async (allowed) => {
    const session = commentsConsoleSession({
      authorize: async () => true,
      user: async () => null,
      identify: async () => ({ id: "guest-12345678-1234-4123-8123-123456789abc", name: "Guest" }),
    })
    const definition = commentsRealtime(defineComments({ authorize: ({ user }) => allowed && user === null }), { consoleSession: session })
    // SAFETY: the Console session reader only reads the request headers.
    const request = { req: new Request("http://site.test/api/_vitehub/realtime/comments/pages/x") } as H3Event
    const context = { definition: "comments", event: request, request: request.req }
    const user = await definition.identify!(context)
    expect(user).toBeNull()
    expect(await definition.authorize!({ ...context, documentId: "pages/x", mode: "read", user: null })).toBe(allowed)
    expect(await definition.authorize!({ ...context, documentId: null, mode: "read", user: null })).toBe(allowed)
    expect(await definition.authorize!({ ...context, documentId: "pages/x", mode: "write", user: null })).toBe(false)
  })

  it("lets read-only Console users join presence with their policy fields", async () => {
    const session = commentsConsoleSession({
      authorize: async ({ kind }) => kind !== "write",
      user: async () => ({ id: "ada", name: "Ada", role: "editor" }),
      identify: async () => null,
    })
    const definition = commentsRealtime(defineComments({ authorize: ({ user }) => user?.role === "editor" }), { consoleSession: session })
    const request = event()
    const context = { definition: "comments", event: request, request: new Request("http://site.test") }
    const user = await definition.identify!(context)
    expect(user).toEqual({ id: "ada", name: "Ada" })
    expect(await definition.authorize!({ ...context, documentId: "pages/x", mode: "read", user: user ?? null })).toBe(true)
    expect(await definition.authorize!({ ...context, documentId: "pages/x", mode: "write", user: user ?? null })).toBe(false)
    await expect(session(request, "comment")).resolves.toBe(false)
  })

  it("binds verified Cloudflare guest-prefixed emails and authorizes with that identity", async () => {
    const person = { id: "guest-reviewer@example.com", email: "guest-reviewer@example.com", name: "guest-reviewer@example.com" }
    const session = commentsConsoleSession({
      authorize: async () => true,
      user: async () => null,
      identify: async () => person,
    })
    const definition = commentsRealtime(defineComments({ authorize: ({ user }) => user?.email === person.email }), { consoleSession: session })
    // SAFETY: the Console session reader only reads the request headers.
    const request = { req: new Request("http://site.test/api/_vitehub/realtime/comments/pages/x") } as H3Event
    const context = { definition: "comments", event: request, request: request.req }
    const user = await definition.identify!(context)
    expect(user).toEqual(person)
    expect(await definition.authorize!({ ...context, documentId: "pages/x", mode: "read", user: user ?? null })).toBe(true)
  })

  it("decides access with the whole user, so policies can read fields Realtime drops", async () => {
    const definition = commentsRealtime(defineComments({
      identify: () => ({ id: "ada", name: "Ada", email: "ada@site.test", role: "editor" }),
      authorize: ({ user }) => user?.role === "editor",
    }))
    const request = event()
    const user = await definition.identify!({ definition: "comments", event: request, request: new Request("http://site.test") })
    expect(user).toEqual({ id: "ada", name: "Ada", email: "ada@site.test" })
    const context = (mode: "read" | "write"): RealtimeAuthorizeContext => ({ definition: "comments", documentId: "pages/x", event: request, mode, request: new Request("http://site.test"), user: user! })
    expect(await definition.authorize!(context("read"))).toBe(true)
    expect(await definition.authorize!(context("write"))).toBe(false)
  })

  it("denies the room to users the policy rejects, and to requests it never identified", async () => {
    const definition = commentsRealtime(defineComments({ identify: () => ({ id: "w", role: "writer" }), authorize: ({ user }) => user?.role === "editor" }))
    const request = event()
    await definition.identify!({ definition: "comments", event: request, request: new Request("http://site.test") })
    const context = (target: H3Event): RealtimeAuthorizeContext => ({ definition: "comments", documentId: null, event: target, mode: "read", request: new Request("http://site.test"), user: null })
    expect(await definition.authorize!(context(request))).toBe(false)
    expect(await definition.authorize!(context(event()))).toBe(false)
  })
})
