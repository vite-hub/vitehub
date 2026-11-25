import { afterEach, describe, expect, it } from "vitest"

import clientRequestPlugin from "@vite-hub/internal/runtime/client-request-plugin"
import { installViteHubSiteVisitor } from "@vite-hub/internal/runtime/page-tools"
import { installRequestStandardContext } from "@vite-hub/runtime/internal/h3"

import { defineComments } from "../src/index.ts"
import { resolveCommentsIdentity, resolveCommentsPage } from "../src/runtime/session.ts"

import type { CommentsRequestEvent } from "../src/types.ts"

const ada = { id: "console-ada", name: "Ada", roles: ["console", "comments-write"] }
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
})

describe("the page of a Comments request", () => {
  it("gives `page` the page origin in a relative request that the server sends to itself", async () => {
    const urls: string[] = []
    const comments = defineComments({ page: ({ url }) => {
      urls.push(url.href)
      return undefined
    } })
    const nitroApp = { fetch: async (_request: Request) => {
      const inProcess = new Request("http://localhost/_vitehub/comments/session")
      installRequestStandardContext(inProcess)
      // SAFETY: The installer adds the Standard Context required by CommentsRequestEvent.
      const event = inProcess as Request & CommentsRequestEvent
      await resolveCommentsPage(comments, event, event, "/pricing")
      return new Response()
    } }
    clientRequestPlugin(nitroApp)
    await nitroApp.fetch(new Request("https://docs.example.com/guide"))
    expect(urls).toEqual(["https://docs.example.com/pricing"])
  })
})
