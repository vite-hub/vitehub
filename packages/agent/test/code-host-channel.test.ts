import { fake } from "forges/fake"
import { fixtureFetch } from "forges/testing"
import { describe, expect, it, vi } from "vitest"
import { github } from "../src/channels.ts"
import { codeHostProvider } from "../src/internal/code-host.ts"
import { codeHostActivityComments, codeHostDeliveryEffects, codeHostIdentity, codeHostPullRequestMetadata, codeHostThreadRef } from "../src/internal/code-host-channel.ts"
import type { CodeHostTarget } from "../src/internal/code-host-channel.ts"
import { messageChannelDeliveredReplyBody } from "../src/internal/message-channel-delivery-body.ts"
import type { AgentChannelDeliveryEffectContext, AgentChannelDeliveryEffectIntent } from "../src/types.ts"

const target: CodeHostTarget = { host: "github", instance: "github.com", repository: "acme/app", number: 42, commentId: 1 }

function effectContext(effect: AgentChannelDeliveryEffectIntent, input = { context: {} }): AgentChannelDeliveryEffectContext {
  // SAFETY: These fixtures supply all callback fields that delivery effects use.
  return { effect, input } as AgentChannelDeliveryEffectContext
}

function fakeProvider() {
  return fake({ kind: "github", instance: "github.com", seed: { threads: [{ repo: "acme/app", kind: "pull_request", number: 42, title: "Fix", comments: [{ body: "old" }] }] } }).create()
}

describe("Code Host Channel core", () => {
  it("delivers replies, updates, reviews and statuses through the shared verbs", async () => {
    const provider = fakeProvider()
    // The fake uses compound ids. This Channel target uses native numeric ids.
    const seeded = await provider.threads.commentsPage(codeHostThreadRef(provider, target))
    seeded.items[0]!.ref.id = "1"
    const effects = codeHostDeliveryEffects({ provider: async () => provider, target: () => target, statusContext: "Agent", reactions: "id" })
    const reply = effectContext({ kind: "reply", payload: "reply" })
    if (typeof effects.reply !== "function" || typeof effects.update !== "function" || typeof effects.review !== "function" || typeof effects.status !== "function") throw new Error("Missing effects.")
    await effects.reply(reply)
    await effects.update(effectContext({ kind: "update", payload: { body: "updated" } }))
    await effects.review(effectContext({ kind: "review", payload: { body: "reviewed", event: "REQUEST_CHANGES" } }))
    await effects.status(effectContext({ kind: "status", payload: { sha: "abc", state: "failure", description: "Failed", target_url: "https://console.test/run" } }))
    const ref = codeHostThreadRef(provider, target)
    expect((await provider.threads.commentsPage(ref)).items.map(comment => comment.body)).toEqual(["updated", "reply"])
    expect((await provider.threads.reviewsPage(ref)).items[0]).toMatchObject({ body: "reviewed", state: "changes_requested" })
    expect((await provider.checks.list(ref.repo, "abc")).items[0]).toMatchObject({ name: "Agent", state: "failure", url: "https://console.test/run" })
    expect(messageChannelDeliveredReplyBody(reply)).toBe("reply")
  })

  it("keeps metadata raw and caps pages at the extra item used for omitted counts", async () => {
    const provider = fake({ kind: "gitlab", instance: "github.com", seed: { threads: [{ repo: "acme/app", kind: "pull_request", number: 42, title: "Fix",
      comments: Array.from({ length: 120 }, (_, id) => ({ body: `comment ${id}` })),
      files: Array.from({ length: 120 }, (_, id) => ({ path: `file-${id}.ts` })),
    }] } }).create()
    const metadata = await codeHostPullRequestMetadata(provider, target, { maxComments: 101, maxFiles: 101 })
    expect(metadata.comments).toHaveLength(102)
    expect(metadata.files).toHaveLength(102)
    expect(metadata).toMatchObject({ omittedComments: 1, omittedFiles: 1 })
    expect(metadata.comments[0]).toEqual({ body: "comment 0" })
    expect(metadata.files[0]).toMatchObject({ path: "file-0.ts" })
    const publicMetadata = await codeHostPullRequestMetadata(provider, target, { maxComments: 0, maxFiles: 0, authenticated: false })
    expect(publicMetadata.comments).toEqual([])
    expect(publicMetadata.files).toEqual([])
  })

  it("keeps every native GitHub file field for the Channel mapper", async () => {
    const file = { filename: "new.ts", previous_filename: "old.ts", status: "renamed", additions: 2, deletions: 1, changes: 3,
      blob_url: "https://github.com/acme/app/blob/abc/new.ts", raw_url: "https://github.com/acme/app/raw/abc/new.ts", contents_url: "https://api.github.com/repos/acme/app/contents/new.ts" }
    const fixture = fixtureFetch([
      { request: { method: "GET", url: "https://api.github.com/repos/acme/app/pulls/42" }, response: { status: 200, body: { title: "Fix", body: "Body" } } },
      { request: { method: "GET", url: "https://api.github.com/repos/acme/app/issues/42/comments?per_page=100" }, response: { status: 200, body: [{ id: 1, body: "first" }, { id: 2, body: "second" }] } },
      { request: { method: "GET", url: "https://api.github.com/repos/acme/app/pulls/42/files?per_page=100" }, response: { status: 200, body: [file, { ...file, filename: "extra.ts" }] } },
    ])
    const provider = await codeHostProvider({ host: "github", token: "token", fetch: fixture.fetch as typeof fetch })
    const metadata = await codeHostPullRequestMetadata(provider, target, { maxComments: 1, maxFiles: 1 })
    expect(metadata.files[0]).toEqual(file)
    expect(metadata.comments[0]).toEqual({ id: 1, body: "first" })
    expect(metadata).toMatchObject({ omittedComments: 1, omittedFiles: 1 })
    expect(fixture.calls).toHaveLength(3)
  })

  it.each([undefined, 9])("removes a GitHub transient reaction by id on target comment %s", async commentId => {
    const path = commentId ? `/repos/acme/app/issues/comments/${commentId}/reactions` : "/repos/acme/app/issues/42/reactions"
    const fixture = fixtureFetch([
      { request: { method: "POST", url: `https://api.github.com${path}` }, response: { status: 201, body: { id: 55 } } },
      { request: { method: "DELETE", url: `https://api.github.com${path}/55` }, response: { status: 204 } },
    ])
    const provider = await codeHostProvider({ host: "github", token: "installation-token", fetch: fixture.fetch as typeof fetch })
    const effects = codeHostDeliveryEffects({ provider: async () => provider, target: () => ({ ...target, commentId }), statusContext: "Agent", reactions: "id" })
    if (typeof effects.reaction !== "function") throw new Error("Missing reaction effect.")
    const input = { context: {} }
    await effects.reaction(effectContext({ kind: "reaction", payload: "eyes", metadata: { transientKey: "running" } }, input))
    expect(input.context).toEqual({ "github.delivery.transientReactions": { running: { id: 55 } } })
    await effects.reaction(effectContext({ kind: "reaction", payload: { action: "remove", content: "eyes" }, metadata: { transientKey: "running" } }, input))
    expect(input.context).toEqual({ "github.delivery.transientReactions": {} })
    expect(fixture.calls.map(call => call.method)).toEqual(["POST", "DELETE"])
    expect(fixture.calls.every(call => call.authorization === "Bearer installation-token")).toBe(true)
  })

  it("writes GitHub commit statuses with token auth, including the native error state", async () => {
    const fixture = fixtureFetch([
      { request: { method: "POST", url: "https://api.github.com/repos/acme/app/statuses/abc" }, response: { status: 201, body: { id: 1, state: "success", context: "Agent" } } },
    ])
    const provider = await codeHostProvider({ host: "github", token: "installation-token", fetch: fixture.fetch as typeof fetch })
    const effects = codeHostDeliveryEffects({ provider: async () => provider, target: () => target, statusContext: "Agent", reactions: "id" })
    if (typeof effects.status !== "function") throw new Error("Missing status effect.")
    await effects.status(effectContext({ kind: "status", payload: { state: "success", sha: "abc" } }))
    await effects.status(effectContext({ kind: "status", payload: { state: "error", sha: "abc" } }))
    expect(fixture.calls).toHaveLength(2)
    expect(fixture.calls.map(call => JSON.parse(call.body!))).toEqual([{ state: "success", context: "Agent" }, { state: "error", context: "Agent" }])
  })

  it("reads the GitHub head SHA with one pull request request", async () => {
    const fixture = fixtureFetch([
      { request: { method: "GET", url: "https://api.github.com/repos/acme/app/pulls/42" }, response: { status: 200, body: { head: { sha: "head-sha" }, base: { sha: "base-sha" } } } },
      { request: { method: "POST", url: "https://api.github.com/repos/acme/app/statuses/head-sha" }, response: { status: 201, body: { id: 1, state: "pending", context: "Agent" } } },
    ])
    const provider = await codeHostProvider({ host: "github", token: "installation-token", fetch: fixture.fetch as typeof fetch })
    const effects = codeHostDeliveryEffects({ provider: async () => provider, target: () => target, statusContext: "Agent", reactions: "id" })
    if (typeof effects.status !== "function") throw new Error("Missing status effect.")
    await effects.status(effectContext({ kind: "status", payload: { state: "pending" } }))
    expect(fixture.calls.map(call => `${call.method} ${new URL(call.url).pathname}`)).toEqual(["GET /repos/acme/app/pulls/42", "POST /repos/acme/app/statuses/head-sha"])
  })

  it("maps delivery failures to the existing diagnostic", async () => {
    const fixture = fixtureFetch([{ request: { method: "POST", url: "https://api.github.com/repos/acme/app/issues/42/comments" }, response: { status: 401, body: {} } }])
    const provider = await codeHostProvider({ host: "github", token: "bad", fetch: fixture.fetch as typeof fetch })
    const effects = codeHostDeliveryEffects({ provider: async () => provider, target: () => target, statusContext: "Agent", reactions: "id" })
    if (typeof effects.reply !== "function") throw new Error("Missing reply effect.")
    await expect(effects.reply(effectContext({ kind: "reply", payload: "reply" }))).rejects.toMatchObject({ code: "AGENT_R0350", message: "[vitehub] GitHub delivery effect failed with 401." })
  })

  it("keeps the newest 500 GitHub activity comments after a restart", async () => {
    const pages: number[] = []
    const fetcher: typeof fetch = async input => {
      const url = new URL(String(input))
      const page = Number(url.searchParams.get("page") || 1)
      pages.push(page)
      return Response.json(Array.from({ length: 100 }, (_, index) => ({ id: (page - 1) * 100 + index + 1, body: "ordinary" })), {
        headers: page === 1 ? { link: '<https://api.github.com/repos/acme/app/issues/42/comments?per_page=100&page=8>; rel="last"' } : {},
      })
    }
    const provider = await codeHostProvider({ host: "github", token: "token", fetch: fetcher })
    const comments = await codeHostActivityComments(provider, target, 500).list()
    expect(comments).toHaveLength(500)
    expect(comments[0]?.ref.id).toBe("800")
    expect(comments[499]?.ref.id).toBe("301")
    expect(pages).toEqual([1, 8, 7, 6, 5, 4])
  })

  it("gets activity comments by id and treats 404 as missing", async () => {
    const fixture = fixtureFetch([
      { request: { method: "GET", url: "https://api.github.com/repos/acme/app/issues/comments/7" }, response: { status: 200, body: { id: 7, body: "activity", user: { login: "bot" } } } },
      { request: { method: "GET", url: "https://api.github.com/repos/acme/app/issues/comments/8" }, response: { status: 404, body: {} } },
    ])
    const provider = await codeHostProvider({ host: "github", token: "token", fetch: fixture.fetch as typeof fetch })
    const comments = codeHostActivityComments(provider, target, 500)
    expect((await comments.get(7))?.raw).toEqual({ id: 7, body: "activity", user: { login: "bot" } })
    expect(await comments.get(8)).toBeUndefined()
    expect(await codeHostIdentity(provider, { kind: "app", login: "bot" })).toEqual({ login: "bot" })
    expect(fixture.calls).toHaveLength(2)
  })

  it("keeps ownership on raw activity comments and supersedes owned duplicates", async () => {
    const writes: { id: number, body: string }[] = []
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input))
      if (url.pathname === "/user") return Response.json({ login: "bot" })
      if (init?.method === "GET") return Response.json([
        { id: 1, body: "<!-- vitehub-agent-activity:e30 -->", user: { login: "bot" } },
        { id: 2, body: "<!-- vitehub-agent-activity:e30 -->", user: { login: "bot" } },
        { id: 3, body: "<!-- vitehub-agent-activity:e30 -->", user: { login: "other" } },
      ])
      const body = JSON.parse(String(init?.body)) as { body: string }
      const id = Number(url.pathname.split("/").at(-1))
      writes.push({ id, body: body.body })
      return Response.json({ id })
    }
    const channel = github({ app: { token: "token", fetch: fetcher }, activity: true })
    // SAFETY: This fixture supplies all fields consumed by the activity callback.
    await channel.activity?.update({ activity: { links: [], runId: "core-ownership", status: "running", tasks: [] }, channel, memo: vi.fn(), run: { runId: "core-ownership" }, runtime: "unknown", target: { repository: "acme/app", issue: 42 }, waitUntil: vi.fn() } as never)
    expect(writes.map(write => write.id)).toEqual([2, 1])
    expect(writes[0]?.body).toMatch(/^<!-- vitehub-agent-activity:/)
    expect(writes[1]?.body).toBe("This Agent activity was superseded by a newer managed comment.")
  })
})
