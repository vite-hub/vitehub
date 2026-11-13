import { describe, expect, it } from "vitest"

import { commentsRoleAllows, defineComments } from "../src/index.ts"

import type { CommentAction } from "../src/operations-core/define.ts"

const actions: CommentAction[] = ["read", "write", "resolve", "delete"]

describe("Comments roles from Site access", () => {
  it("lets the roles of a user decide when the app has no authorize", async () => {
    const comments = defineComments()
    const guest = { id: "guest-1", name: "Ana", role: "guest,comments-read,comments-write" }
    expect(await Promise.all(actions.map(action => comments.can({ user: guest, action })))).toEqual([true, true, false, false])
  })

  it("reads with any Comments role, and gives nothing for other roles", () => {
    expect(commentsRoleAllows({ id: "a", role: "comments-resolve" }, "read")).toBe(true)
    expect(commentsRoleAllows({ id: "a", role: "comments-resolve" }, "write")).toBe(false)
    expect(commentsRoleAllows({ id: "a", role: "user,console" }, "read")).toBe(false)
    expect(commentsRoleAllows({ id: "a" }, "read")).toBe(false)
    expect(commentsRoleAllows(null, "read")).toBe(false)
  })

  it("leaves the decision to authorize, which can check the roles itself", async () => {
    const guest = { id: "guest-1", name: "Ana", role: "guest,comments-read" }
    expect(await defineComments({ authorize: () => false }).can({ user: guest, action: "read" })).toBe(false)
    const comments = defineComments({ authorize: ({ user, action }) => commentsRoleAllows(user, action) })
    expect(await comments.can({ user: guest, action: "read" })).toBe(true)
    expect(await comments.can({ user: guest, action: "write" })).toBe(false)
  })
})
