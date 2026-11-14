import { afterEach, describe, expect, it } from "vitest"

import { installViteHubSiteVisitor } from "@vite-hub/internal/runtime/page-tools"

import { defineComments } from "../src/index.ts"
import { resolveCommentsIdentity } from "../src/runtime/session.ts"

const ada = { id: "console-ada", name: "Ada", roles: ["console", "comments-write"] }
const request = () => new Request("https://docs.example.com/guide")

afterEach(() => {
  installViteHubSiteVisitor(async () => undefined)
})

describe("the user of a Comments request", () => {
  it("keeps a visitor that identify returns null for anonymous, even with a Site access cookie", async () => {
    installViteHubSiteVisitor(async () => ada)
    const comments = defineComments({ identify: () => null })
    expect((await resolveCommentsIdentity(comments, request())).user).toBeNull()
  })

  it("reads the Site access person when the app has no identify and no Auth session", async () => {
    installViteHubSiteVisitor(async () => ada)
    const comments = defineComments({})
    expect((await resolveCommentsIdentity(comments, request())).user).toEqual({ id: "console-ada", name: "Ada", role: "console,comments-write" })
  })
})
