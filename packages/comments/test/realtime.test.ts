import { describe, expect, it } from "vitest"

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
  it.each([true, false])("keeps Console guest awareness unbound while enforcing read access (%s)", async (allowed) => {
    const session = commentsConsoleSession({
      authorize: async () => true,
      user: async () => null,
      identify: async () => ({ id: "guest-1234", name: "Guest" }),
    })
    const definition = commentsRealtime(defineComments({ authorize: ({ user }) => allowed && user?.guest === true }), { session })
    // SAFETY: the Console session reader only reads the request headers.
    const request = { req: new Request("http://site.test/api/_vitehub/realtime/comments/pages/x") } as H3Event
    const context = { definition: "comments", event: request, request: request.req }
    const user = await definition.identify!(context)
    expect(user).toBeNull()
    expect(await definition.authorize!({ ...context, documentId: "pages/x", mode: "read", user: null })).toBe(allowed)
    expect(await definition.authorize!({ ...context, documentId: null, mode: "read", user: null })).toBe(allowed)
    expect(await definition.authorize!({ ...context, documentId: "pages/x", mode: "write", user: null })).toBe(false)
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
