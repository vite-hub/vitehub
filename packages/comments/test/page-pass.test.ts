import { afterEach, describe, expect, it } from "vitest"

import { registerViteHubPagePassReader } from "@vite-hub/internal/runtime/page-tools"
import { installRequestStandardContext } from "@vite-hub/runtime"

import { defineComments } from "../src/index.ts"
import { passAllows } from "../src/operations-core/define.ts"
import { resolveCommentsIdentity } from "../src/runtime/session.ts"

import type { ViteHubPagePass } from "@vite-hub/internal/runtime/page-tools"
import type { CommentsRequestEvent } from "../src/types.ts"

const passes: Record<string, ViteHubPagePass> = {
  guest: { id: "p1", kind: "guest", person: { id: "pass:invite-1", name: "Ana from design" }, grants: ["comments.write"] },
  member: { id: "p2", kind: "member", person: { id: "console-ada", name: "Ada", image: "https://example.com/ada.png" }, grants: ["console", "comments.read", "comments.write", "comments.resolve", "comments.delete"] },
}

function page(cookie?: string): Request & CommentsRequestEvent {
  const request = new Request("https://app.example.com/runs/42", { headers: cookie ? { cookie } : {} })
  installRequestStandardContext(request)
  // SAFETY: installRequestStandardContext() put the Standard Context of the request on it, as Nitro does.
  return request as Request & CommentsRequestEvent
}

afterEach(() => registerViteHubPagePassReader(undefined))

describe("page passes", () => {
  it("names a guest with the name a member gave them, and lets the grants decide over authorize", async () => {
    registerViteHubPagePassReader(async request => passes[request.headers.get("cookie") ?? ""])
    const comments = defineComments({ authorize: () => false })
    const { user, gate } = await resolveCommentsIdentity(comments, page("guest"), { session: async () => null })
    expect(user).toEqual({ id: "pass:invite-1", name: "Ana from design" })
    expect(gate).toEqual({ pass: { grants: ["comments.write"] } })
    const can = (action: "read" | "write" | "resolve" | "delete") => comments.can({ user, action }, gate)
    expect([await can("read"), await can("write"), await can("resolve"), await can("delete")]).toEqual([true, true, false, false])
  })

  it("names a member with their Console name and picture", async () => {
    registerViteHubPagePassReader(async request => passes[request.headers.get("cookie") ?? ""])
    const comments = defineComments()
    const { user, gate } = await resolveCommentsIdentity(comments, page("member"), { session: async () => null })
    expect(user).toEqual({ id: "console-ada", name: "Ada", image: "https://example.com/ada.png" })
    expect(await comments.can({ user, action: "delete" }, gate)).toBe(true)
  })

  it("comes after the app session: a signed-in person keeps the app's own policy", async () => {
    registerViteHubPagePassReader(async request => passes[request.headers.get("cookie") ?? ""])
    const comments = defineComments({ authorize: () => false })
    const identity = await resolveCommentsIdentity(comments, page("guest"), { session: async () => ({ id: "app-user", name: "Grace" }) })
    expect(identity).toEqual({ user: { id: "app-user", name: "Grace" }, gate: {} })
    expect(await comments.can({ user: identity.user, action: "read" }, identity.gate)).toBe(false)
  })

  it("is nobody without a pass", async () => {
    registerViteHubPagePassReader(async () => undefined)
    expect(await resolveCommentsIdentity(defineComments(), page(), {})).toEqual({ user: null, gate: {} })
  })

  it("reads comments with any Comments grant, and does nothing else without its grant", () => {
    expect(passAllows(["comments.resolve"], "read")).toBe(true)
    expect(passAllows(["comments.resolve"], "write")).toBe(false)
    expect(passAllows(["console"], "read")).toBe(false)
    expect(passAllows([], "read")).toBe(false)
  })
})
