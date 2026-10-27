import { describe, expect, it } from "vitest"

import { commentsConsoleSession } from "../src/runtime/console-session.ts"

import type { CommentsConsoleAccess } from "../src/runtime/console-session.ts"
import type { H3Event } from "h3"

function event(headers: Record<string, string> = {}): H3Event {
  // SAFETY: the session reader only reads the request headers.
  return { req: new Request("http://site.test/api/_vitehub/comments/session", { headers }) } as H3Event
}

function access(input: { allowed: boolean, user?: Record<string, unknown> | null, person?: { id: string, name?: string, email?: string } | null }): CommentsConsoleAccess {
  return {
    authorize: async () => input.allowed,
    user: async () => input.user ?? null,
    identify: async () => input.person ?? null,
  }
}

describe("commentsConsoleSession", () => {
  it("gives null to people that the Console does not let use the comments section", async () => {
    const session = commentsConsoleSession(access({ allowed: false, user: { id: "u1", name: "Ada" } }))
    await expect(session(event())).resolves.toBeNull()
  })

  it("gives the Console user with every field, so authorize policies can read a role", async () => {
    const session = commentsConsoleSession(access({ allowed: true, user: { id: "u1", name: "Ada", role: "editor" } }))
    await expect(session(event())).resolves.toEqual({ id: "u1", name: "Ada", role: "editor" })
  })

  it("names a Cloudflare Access person by email", async () => {
    const session = commentsConsoleSession(access({ allowed: true, person: { id: "ada@vitehub.dev", email: "ada@vitehub.dev", name: "ada@vitehub.dev" } }))
    await expect(session(event())).resolves.toEqual({ id: "ada@vitehub.dev", email: "ada@vitehub.dev", name: "ada@vitehub.dev" })
  })

  it("preserves a verified Cloudflare email starting with guest- even with browser guest headers", async () => {
    const person = { id: "guest-reviewer@example.com", email: "guest-reviewer@example.com", name: "guest-reviewer@example.com" }
    const session = commentsConsoleSession(access({ allowed: true, person }))
    await expect(session(event())).resolves.toEqual(person)
    await expect(session(event({ "x-vitehub-comments-guest-id": "g1", "x-vitehub-comments-guest-name": "Ben" }))).resolves.toEqual(person)
  })

  it("gives a guest for a Console without accounts, and the name the guest chose", async () => {
    const session = commentsConsoleSession(access({ allowed: true, person: { id: "guest-12345678-1234-4123-8123-123456789abc", name: "Guest" } }))
    await expect(session(event())).resolves.toEqual({ id: "guest:console", name: "Guest", guest: true })
    await expect(session(event({ "x-vitehub-comments-guest-id": "g1", "x-vitehub-comments-guest-name": "Ben%20K" }))).resolves.toEqual({ id: "guest:g1", name: "Ben K", guest: true })
  })
})
