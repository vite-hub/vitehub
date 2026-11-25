import { afterEach, describe, expect, it } from "vitest"

import { installViteHubSiteVisitor } from "@vite-hub/internal/runtime/page-tools"
import { installRequestStandardContext } from "@vite-hub/runtime/internal/h3"

import { defineComments } from "../src/index.ts"
import { resolveCommentsIdentity } from "../src/runtime/session.ts"

import type { CommentsRequestEvent } from "../src/types.ts"

const ada = { id: "console-ada", name: "Ada", roles: ["console", "comments-write"], kind: "member" as const }
const request = () => {
  const req = new Request("https://docs.example.com/guide")
  installRequestStandardContext(req)
  // SAFETY: The installer adds the Standard Context required by CommentsRequestEvent.
  return req as Request & CommentsRequestEvent
}

afterEach(() => {
  installViteHubSiteVisitor(async () => undefined)
})

describe("the user of a Comments request", () => {
  it.each([null, undefined])("keeps a visitor that identify returns %s for anonymous, even with a Site access cookie", async (identity) => {
    installViteHubSiteVisitor(async () => ada)
    const comments = defineComments({ identify: () => identity })
    expect((await resolveCommentsIdentity(comments, request())).user).toBeNull()
  })

  it("reads the Site access person when the app has no identify and no Auth session", async () => {
    installViteHubSiteVisitor(async () => ada)
    const comments = defineComments({})
    expect((await resolveCommentsIdentity(comments, request())).user).toEqual({ id: "console-ada", name: "Ada", role: "console,comments-write" })
  })

  it("prefers the Site access person to the Auth user of the app", async () => {
    installViteHubSiteVisitor(async () => ada)
    const comments = defineComments({})
    const user = await resolveCommentsIdentity(comments, request(), { session: async () => ({ id: "auth-bob", name: "Bob" }) })
    expect(user.user).toEqual({ id: "console-ada", name: "Ada", role: "console,comments-write" })
  })

  it("reads the Auth user when the browser has no Site access cookie", async () => {
    const comments = defineComments({})
    const user = await resolveCommentsIdentity(comments, request(), { session: async () => ({ id: "auth-bob", name: "Bob" }) })
    expect(user.user).toEqual({ id: "auth-bob", name: "Bob" })
  })
})
