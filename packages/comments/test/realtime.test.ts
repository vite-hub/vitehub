import { describe, expect, it, vi } from "vitest"

import { defineComments } from "../src/index.ts"
import { commentsRealtime } from "../src/realtime.ts"
import { commentRoom } from "../src/page.ts"

import { H3Event } from "h3"
import type { RealtimeAuthorizeContext } from "@vite-hub/realtime"

function event(): H3Event {
  return new H3Event(new Request("http://site.test/"))
}

describe("commentsRealtime", () => {
  it("denies the shared events room even when the claimed page is readable", async () => {
    const definition = commentsRealtime(defineComments({ authorize: ({ subject }) => subject?.id === "/public" }))
    const context = { definition: "comments", event: event(), request: new Request("http://site.test/@workspace?workspace=events&page=%2Fpublic") }
    await definition.identify!(context)
    expect(await definition.authorize!({ ...context, documentId: null, mode: "read", user: null })).toBe(false)
  })

  it.each([
    { page: "/public", room: "/public", allowed: true },
    { page: "/public/", room: "/public", allowed: true },
    { page: "/private", room: "/private", allowed: false },
    { page: "/public", room: "/private", allowed: false },
    { page: undefined, room: "/private", allowed: false },
  ])("checks the requested page and binds it to its room: %j", async ({ page, room, allowed }) => {
    const definition = commentsRealtime(defineComments({
      identify: () => ({ id: "ada", role: "editor" }),
      authorize: ({ user, subject }) => user?.role === "editor" && subject?.id !== "/private",
    }))
    const context = { definition: "comments", event: event(), request: new Request(`http://site.test${page ? `?page=${encodeURIComponent(page)}` : ""}`) }
    const user = await definition.identify!(context)
    expect(await definition.authorize!({ ...context, documentId: commentRoom(room), mode: "read", user: user ?? null })).toBe(allowed)
  })

  it("checks the subject that `page` maps the page to, and keeps the room of the page path", async () => {
    const definition = commentsRealtime(defineComments({
      page: ({ url }) => url.pathname.startsWith("/d/") ? { kind: "drop", id: url.pathname.slice(3) } : undefined,
      authorize: ({ subject }) => subject?.kind === "drop" && subject.id === "abc",
    }))
    const join = async (page: string, room: string) => {
      const context = { definition: "comments", event: event(), request: new Request(`http://site.test?page=${encodeURIComponent(page)}`) }
      await definition.identify!(context)
      return await definition.authorize!({ ...context, documentId: commentRoom(room), mode: "read", user: null })
    }
    expect(await join("/d/abc", "/d/abc")).toBe(true)
    expect(await join("/d/xyz", "/d/xyz")).toBe(false)
    expect(await join("/d/abc", "/d/xyz")).toBe(false)
  })

  it("allows a page-only policy without needing a context-free read", async () => {
    const definition = commentsRealtime(defineComments({ authorize: ({ subject }) => subject?.id === "/public" }))
    const context = { definition: "comments", event: event(), request: new Request("http://site.test?page=%2Fpublic") }
    await definition.identify!(context)
    expect(await definition.authorize!({ ...context, documentId: commentRoom("/public"), mode: "read", user: null })).toBe(true)
  })

  it.each([{ id: "custom", name: "Custom" }, null])("skips the Auth session when custom identify returns %j", async (person) => {
    const session = vi.fn(async () => { throw new Error("Auth unavailable") })
    const identify = vi.fn(() => person)
    const definition = commentsRealtime(defineComments({ identify, authorize: () => true }), { session })
    const context = { definition: "comments", event: event(), request: new Request("http://site.test?page=%2F") }
    const user = await definition.identify!(context)
    expect(user).toEqual(person)
    expect(await definition.authorize!({ ...context, documentId: commentRoom("/"), mode: "read", user: user ?? null })).toBe(true)
    expect(identify).toHaveBeenCalled()
    expect(session).not.toHaveBeenCalled()
  })

  it("requires a policy for custom identities in production", async () => {
    const definition = commentsRealtime(defineComments({ identify: () => ({ id: "custom" }) }))
    const context = { definition: "comments", event: event(), request: new Request("http://site.test?page=%2F") }
    const user = await definition.identify!(context)
    expect(await definition.authorize!({ ...context, documentId: commentRoom("/"), mode: "read", user: user ?? null })).toBe(false)
  })

  it("binds presence to a server-identified guest", async () => {
    const definition = commentsRealtime(defineComments({
      identify: () => ({ id: "external-guest", name: "Invited reviewer", guest: true }),
      authorize: ({ user }) => user?.id === "external-guest",
    }))
    const request = event()
    const context = { definition: "comments", event: request, request: new Request("http://site.test?page=%2F") }
    const user = await definition.identify!(context)
    expect(user).toEqual({ id: "external-guest", name: "Invited reviewer" })
    expect(await definition.authorize!({ ...context, documentId: commentRoom("/"), mode: "read", user: user ?? null })).toBe(true)
  })

  it.each([true, false])("keeps anonymous awareness unbound while enforcing read access (%s)", async (allowed) => {
    const definition = commentsRealtime(defineComments({ authorize: ({ user }) => allowed && user === null }), { session: async () => null })
    // SAFETY: the session reader only reads the request headers.
    const request = { req: new Request("http://site.test/api/_vitehub/realtime/comments/" + commentRoom("/") + "?page=%2F") } as H3Event
    const context = { definition: "comments", event: request, request: request.req }
    const user = await definition.identify!(context)
    expect(user).toBeNull()
    expect(await definition.authorize!({ ...context, documentId: commentRoom("/"), mode: "read", user: null })).toBe(allowed)
    expect(await definition.authorize!({ ...context, documentId: null, mode: "read", user: null })).toBe(false)
    expect(await definition.authorize!({ ...context, documentId: commentRoom("/"), mode: "write", user: null })).toBe(false)
  })

  it("lets Auth users join presence with their policy fields, for reading only", async () => {
    const session = async () => ({ id: "ada", name: "Ada", role: "editor" })
    const definition = commentsRealtime(defineComments({ authorize: ({ user }) => user?.role === "editor" }), { session })
    const request = event()
    const context = { definition: "comments", event: request, request: new Request("http://site.test?page=%2F") }
    const user = await definition.identify!(context)
    expect(user).toEqual({ id: "ada", name: "Ada" })
    expect(await definition.authorize!({ ...context, documentId: commentRoom("/"), mode: "read", user: user ?? null })).toBe(true)
    expect(await definition.authorize!({ ...context, documentId: commentRoom("/"), mode: "write", user: user ?? null })).toBe(false)
  })

  it("binds session users with guest-prefixed emails and authorizes with that identity", async () => {
    const person = { id: "guest-reviewer@example.com", email: "guest-reviewer@example.com", name: "guest-reviewer@example.com" }
    const definition = commentsRealtime(defineComments({ authorize: ({ user }) => user?.email === person.email }), { session: async () => person })
    // SAFETY: the session reader only reads the request headers.
    const request = { req: new Request("http://site.test/api/_vitehub/realtime/comments/" + commentRoom("/") + "?page=%2F") } as H3Event
    const context = { definition: "comments", event: request, request: request.req }
    const user = await definition.identify!(context)
    expect(user).toEqual(person)
    expect(await definition.authorize!({ ...context, documentId: commentRoom("/"), mode: "read", user: user ?? null })).toBe(true)
  })

  it("decides access with the whole user, so policies can read fields Realtime drops", async () => {
    const definition = commentsRealtime(defineComments({
      identify: () => ({ id: "ada", name: "Ada", email: "ada@site.test", role: "editor" }),
      authorize: ({ user }) => user?.role === "editor",
    }))
    const request = event()
    const user = await definition.identify!({ definition: "comments", event: request, request: new Request("http://site.test?page=%2F") })
    expect(user).toEqual({ id: "ada", name: "Ada", email: "ada@site.test" })
    const context = (mode: "read" | "write"): RealtimeAuthorizeContext => ({ definition: "comments", documentId: commentRoom("/"), event: request, mode, request: new Request("http://site.test?page=%2F"), user: user! })
    expect(await definition.authorize!(context("read"))).toBe(true)
    expect(await definition.authorize!(context("write"))).toBe(false)
  })

  it("denies the room to users the policy rejects, and to requests it never identified", async () => {
    const definition = commentsRealtime(defineComments({ identify: () => ({ id: "w", role: "writer" }), authorize: ({ user }) => user?.role === "editor" }))
    const request = event()
    await definition.identify!({ definition: "comments", event: request, request: new Request("http://site.test?page=%2F") })
    const context = (target: H3Event): RealtimeAuthorizeContext => ({ definition: "comments", documentId: null, event: target, mode: "read", request: new Request("http://site.test?page=%2F"), user: null })
    expect(await definition.authorize!(context(request))).toBe(false)
    expect(await definition.authorize!(context(event()))).toBe(false)
  })
})
