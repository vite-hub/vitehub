// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest"

import { gitHubRepositoryOf } from "../src/agent-prompt.ts"
import { mountHostedComments } from "../src/embed/tools.ts"
import { api } from "../src/overlay/api.ts"

import type { EmbedFrame } from "../src/embed/protocol.ts"
import type { CommentsSession } from "../src/overlay/api.ts"

vi.mock("@vite-hub/internal/runtime/page-tools-loader", () => ({ loadViteHubPageTools: vi.fn(), stopViteHubPageTools: vi.fn() }))

const consoleSession: CommentsSession = { user: { id: "u1", name: "Ana" }, can: { read: true, comment: true, resolve: false }, realtime: false, content: false }
const frame: Promise<EmbedFrame> = Promise.resolve({
  call: async () => ({ id: 0, ok: true, value: consoleSession, people: [] }),
})

describe("the repository of a Hosted Comments site", () => {
  it("comes from data-vitehub-repo into the session, for Open in T3 Code", async () => {
    await mountHostedComments(frame, { id: "p-1", console: "https://console.example.com", repository: "acme/site" })
    expect(await api.session("/guide")).toEqual([undefined, { ...consoleSession, repository: "acme/site" }])
  })

  it("is not in the session when the script tag has none", async () => {
    await mountHostedComments(frame, { id: "p-2", console: "https://console.example.com" })
    const [, session] = await api.session("/guide")
    expect(session).not.toHaveProperty("repository")
  })

  it("is only a GitHub owner/name", () => {
    expect(gitHubRepositoryOf("acme/site.web")).toBe("acme/site.web")
    for (const value of [undefined, "", "acme", "acme/..", "-acme/site", "acme/site/extra", "https://github.com/acme/site"]) expect(gitHubRepositoryOf(value)).toBeUndefined()
  })
})
