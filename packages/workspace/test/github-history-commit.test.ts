import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { baseSha, createFakeGitHub, fakeSha, textBytes, textSha } from "./fake-github.ts"
import { normalizeWorkspaceStoreOptions } from "../src/config.ts"
import { createGitHubWorkspaceStore } from "../src/providers/github/store.ts"

import type { GitHubWorkspaceStoreOptions } from "../src/core/types.ts"
import type { FakeGitHub } from "./fake-github.ts"

let fake: FakeGitHub

beforeEach(() => {
  fake = createFakeGitHub()
  vi.stubGlobal("fetch", vi.fn(fake.fetch))
  vi.stubEnv("VITEHUB_GITHUB_TOKEN", "")
  vi.stubEnv("FORGES_GITHUB_TOKEN", "")
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

function history(options: Partial<GitHubWorkspaceStoreOptions> = {}) {
  return createGitHubWorkspaceStore({ provider: "github", repository: "onmax/repo", token: "token", root: "", ...options }, "content").history!
}

const file = (path: string, content: string) => ({ path, content })

const aliases = { published: "main", draft: "vitehub/content" }

describe("GitHub history commit", () => {
  it("rejects a stale ifHead before it writes", async () => {
    fake.commit("main", { "posts/a.md": "a" })
    const stale = fakeSha("stale")
    await expect(history().commit({ ref: "main", ifHead: stale, changes: { put: { "posts/b.md": file("posts/b.md", "b") } } }))
      .rejects.toMatchObject({ code: "WORKSPACE_CONFLICT", details: { ref: "main", expected: stale, actual: fake.head("main") } })
    // A first commit on a branch that exists is stale as well.
    await expect(history().commit({ ref: "main", ifHead: null, changes: { put: { "posts/b.md": file("posts/b.md", "b") } } }))
      .rejects.toMatchObject({ code: "WORKSPACE_CONFLICT", details: { expected: null } })
    expect(fake.writes()).toHaveLength(0)
  })

  it("commits on the head it expects and returns the new revision", async () => {
    const parent = fake.commit("main", { "posts/a.md": "a" })
    const revision = await history().commit({ ref: "main", ifHead: parent, changes: { put: { "posts/b.md": file("posts/b.md", "b") }, delete: ["posts/a.md"] }, message: "Move a to b" })
    expect(revision).toMatchObject({ ref: "main", parentId: parent, message: "Move a to b" })
    expect(fake.head("main")).toBe(revision.id)
    expect(fake.tree("main").map(entry => entry.path)).toEqual(["posts/b.md"])
  })

  it("creates a missing branch from the default branch", async () => {
    const main = fake.commit("main", { "posts/a.md": "a" })
    const revision = await history().commit({ ref: "drafts/one", ifHead: null, changes: { put: { "posts/b.md": file("posts/b.md", "b") } } })
    expect(revision).toMatchObject({ ref: "drafts/one", parentId: main })
    expect(fake.head("drafts/one")).toBe(revision.id)
    expect(fake.tree("drafts/one").map(entry => entry.path).sort()).toEqual(["posts/a.md", "posts/b.md"])
    expect(fake.head("main")).toBe(main)
  })

  it("creates a missing draft from the published branch when refs name it", async () => {
    fake.state.defaultBranch = "trunk"
    fake.setBranch("trunk", "trunk-head", [])
    const published = fake.commit("main", { "posts/a.md": "a" })
    const revision = await history({ refs: aliases }).commit({ ref: "draft", ifHead: null, changes: { put: { "posts/b.md": file("posts/b.md", "b") } } })
    expect(revision).toMatchObject({ ref: "draft", parentId: published })
    expect(fake.tree("vitehub/content").map(entry => entry.path).sort()).toEqual(["posts/a.md", "posts/b.md"])
  })

  it("deletes a published file on a draft that does not exist yet", async () => {
    fake.commit("main", { "posts/a.md": "a", "posts/b.md": "b" })
    await history({ refs: aliases }).commit({ ref: "draft", ifHead: null, changes: { delete: ["posts/a.md"] } })
    expect(fake.tree("vitehub/content").map(entry => entry.path)).toEqual(["posts/b.md"])
  })

  it("does not create a branch without a file change", async () => {
    fake.commit("main", { "posts/a.md": "a" })
    await expect(history().commit({ ref: "drafts/one", ifHead: null, changes: { put: { "posts/a.md": file("posts/a.md", "a") } } }))
      .rejects.toThrow("cannot create ref \"drafts/one\" without a file change")
    expect(fake.head("drafts/one")).toBeUndefined()
  })

  it("checks ifHeads on other refs", async () => {
    const published = fake.commit("main", { "posts/a.md": "a" })
    const draft = fake.commit("vitehub/content", { "posts/a.md": "a2" })
    const target = history({ refs: aliases })
    await expect(target.commit({ ref: "published", ifHead: published, ifHeads: { draft: fakeSha("old-draft") }, changes: { put: { "posts/a.md": file("posts/a.md", "a2") } } }))
      .rejects.toMatchObject({ code: "WORKSPACE_CONFLICT", details: { ref: "draft", expected: fakeSha("old-draft"), actual: draft } })
    await expect(target.commit({ ref: "published", ifHead: published, ifHeads: { draft: null }, changes: { put: { "posts/a.md": file("posts/a.md", "a2") } } }))
      .rejects.toMatchObject({ code: "WORKSPACE_CONFLICT", details: { ref: "draft", expected: null, actual: draft } })
    expect(fake.head("main")).toBe(published)
    const revision = await target.commit({ ref: "published", ifHead: published, ifHeads: { draft }, changes: { put: { "posts/a.md": file("posts/a.md", "a2") } } })
    expect(revision).toMatchObject({ ref: "published", parentId: published })
    expect(fake.head("main")).toBe(revision.id)
  })

  it("keeps commit metadata in the commit message and reads it back", async () => {
    const parent = fake.commit("main", { "posts/a.md": "a" })
    const metadata = { content: { action: "save", documents: [{ collection: "posts", id: "b" }] } }
    const revision = await history().commit({ ref: "main", ifHead: parent, changes: { put: { "posts/b.md": file("posts/b.md", "b") } }, message: "Save posts/b", metadata })
    expect(revision).toMatchObject({ message: "Save posts/b", metadata })
    expect(fake.commits.get(revision.id)!.message).toBe(`Save posts/b\n\nVitehub-Metadata: ${JSON.stringify(metadata)}`)

    // A new history has no cache, so it reads the trailer from the commit.
    const reader = history()
    const [listed] = (await reader.list({ ref: "main", limit: 1 })).revisions
    expect(listed).toMatchObject({ id: revision.id, message: "Save posts/b", metadata })
    expect((await reader.open(revision.id)).revision).toMatchObject({ message: "Save posts/b", metadata })
    expect((await reader.head({ ref: "main" }))).toMatchObject({ message: "Save posts/b", metadata })
  })

  it("leaves a message without a metadata trailer as it is", async () => {
    const parent = fake.commit("main", { "posts/a.md": "a" }, { message: "Plain message\n\nVitehub-Metadata: not json" })
    const [revision] = (await history().list({ ref: "main", limit: 1 })).revisions
    expect(revision).toMatchObject({ id: parent, message: "Plain message\n\nVitehub-Metadata: not json" })
    expect(revision!.metadata).not.toHaveProperty("content")
  })

  it("maps the published and draft refs to branches and back", async () => {
    const published = fake.commit("main", { "posts/a.md": "a" })
    const draft = fake.commit("vitehub/content", { "posts/a.md": "a2" })
    fake.commit("literal", { "posts/a.md": "a3" })
    fake.setBranch("draft", "literal-draft", [])
    const target = history({ refs: aliases })
    await expect(target.head({ ref: "published" })).resolves.toMatchObject({ id: published, ref: "published" })
    await expect(target.head({ ref: "draft" })).resolves.toMatchObject({ id: draft, ref: "draft" })
    await expect(target.list({ ref: "draft" })).resolves.toMatchObject({ revisions: [{ id: draft, ref: "draft" }] })
    await expect(target.list({ ref: "published", limit: 1 })).resolves.toMatchObject({ revisions: [{ id: published, ref: "published" }] })
    await expect(target.open(draft)).resolves.toMatchObject({ revision: { id: draft, ref: "draft" } })
    // A branch named like an alias is hidden, so no ref shows twice.
    const refs = await target.refs()
    expect(refs.map(ref => ref.name)).toEqual(["draft", "literal", "published"])
    expect(refs.find(ref => ref.name === "draft")!.head.id).toBe(draft)
    await expect(target.forksFrom?.("draft")).resolves.toBe("published")
    await expect(target.forksFrom?.("published")).resolves.toBeUndefined()
    await expect(history().forksFrom?.("draft")).resolves.toBeUndefined()
  })

  it("reads and writes at the repository root", async () => {
    const parent = fake.commit("main", { "README.md": "readme", "posts/a.md": "a" })
    const target = history()
    const revision = await target.commit({ ref: "main", ifHead: parent, changes: { put: { "posts/b.md": file("posts/b.md", "b") } } })
    expect(fake.tree("main").map(entry => entry.path).sort()).toEqual(["README.md", "posts/a.md", "posts/b.md"])
    const view = await target.open(revision.id)
    expect((await view.list("", { recursive: true })).filter(entry => entry.type === "file").map(entry => entry.path).sort()).toEqual(["README.md", "posts/a.md", "posts/b.md"])
    await expect(view.readFile("posts/b.md")).resolves.toBe("b")
  })

  it("keeps a root under a folder apart from the rest of the repository", async () => {
    const parent = fake.commit("main", { "README.md": "readme", "site/posts/a.md": "a" })
    const target = history({ root: "site" })
    const revision = await target.commit({ ref: "main", ifHead: parent, changes: { put: { "posts/b.md": file("posts/b.md", "b") } } })
    expect(fake.tree("main").map(entry => entry.path).sort()).toEqual(["README.md", "site/posts/a.md", "site/posts/b.md"])
    expect((await (await target.open(revision.id)).list("", { recursive: true })).map(entry => entry.path)).toEqual(["posts", "posts/a.md", "posts/b.md"])
  })

  it("reports the Git blob sha as the digest of each file", async () => {
    const parent = fake.commit("main", { "posts/a.md": "a" })
    const target = history()
    const view = await target.open(parent)
    expect(await view.list("", { recursive: true })).toContainEqual(expect.objectContaining({ path: "posts/a.md", digest: textSha("a") }))
    await expect(view.stat("posts/a.md")).resolves.toMatchObject({ digest: textSha("a") })
    await expect(target.digest!(textBytes("a"))).resolves.toBe(textSha("a"))
  })

  it("lists only the revisions that changed a path", async () => {
    const first = fake.commit("main", { "posts/a.md": "a" })
    const second = fake.commit("main", { "posts/b.md": "b" })
    const third = fake.commit("main", { "posts/a.md": "a2" })
    const target = history()
    expect((await target.list({ ref: "main" })).revisions.map(revision => revision.id)).toEqual([third, second, first, baseSha])
    expect((await target.list({ ref: "main", path: "posts/a.md" })).revisions.map(revision => revision.id)).toEqual([third, first])
    expect((await target.list({ ref: "main", path: "posts/b.md" })).revisions.map(revision => revision.id)).toEqual([second])
    expect((await target.list({ ref: "main", path: "posts" })).revisions).toHaveLength(3)
    const page = await target.list({ ref: "main", path: "posts/a.md", limit: 1 })
    expect(page.revisions.map(revision => revision.id)).toEqual([third])
    expect((await target.list({ ref: "main", path: "posts/a.md", limit: 1, cursor: page.cursor })).revisions.map(revision => revision.id)).toEqual([first])
  })

  it("lists the revisions after a revision id", async () => {
    const first = fake.commit("main", { "posts/a.md": "a" })
    const second = fake.commit("main", { "posts/a.md": "a2" })
    const third = fake.commit("main", { "posts/a.md": "a3" })
    const target = history()
    const page = await target.list({ ref: "main", cursor: third, limit: 1 })
    expect(page.revisions.map(revision => revision.id)).toEqual([second])
    expect(page.cursor).toBe(second)
    const next = await target.list({ ref: "main", cursor: page.cursor, limit: 2 })
    expect(next.revisions.map(revision => revision.id)).toEqual([first, baseSha])
    expect(next.cursor).toBeUndefined()
  })

  it("keeps a branch head for a short time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const parent = fake.commit("main", { "posts/a.md": "a" })
    const target = history()
    const reads = () => fake.requests.filter(request => request.path.includes("/heads/main")).length
    await target.head({ ref: "main" })
    await target.head({ ref: "main" })
    expect(reads()).toBe(1)
    const moved = fake.commit("main", { "posts/a.md": "a2" })
    await expect(target.head({ ref: "main" })).resolves.toMatchObject({ id: parent })
    vi.advanceTimersByTime(5_001)
    await expect(target.head({ ref: "main" })).resolves.toMatchObject({ id: moved })
    expect(reads()).toBe(2)
    // A commit through this history replaces the head at once.
    const revision = await target.commit({ ref: "main", ifHead: moved, changes: { put: { "posts/c.md": file("posts/c.md", "c") } } })
    await expect(target.head({ ref: "main" })).resolves.toMatchObject({ id: revision.id })
  })

  it("drops a cached head after a conflict", async () => {
    const parent = fake.commit("main", { "posts/a.md": "a" })
    const target = history()
    await target.head({ ref: "main" })
    const moved = fake.commit("main", { "posts/a.md": "a2" })
    await expect(target.commit({ ref: "main", ifHead: parent, changes: { put: { "posts/c.md": file("posts/c.md", "c") } } })).rejects.toMatchObject({ code: "WORKSPACE_CONFLICT" })
    await expect(target.head({ ref: "main" })).resolves.toMatchObject({ id: moved })
  })

  it("is created without a token or repository and fails at the first request", async () => {
    const store = createGitHubWorkspaceStore({ provider: "github" }, "content")
    expect(store.history).toBeDefined()
    await expect(store.history!.head({ ref: "main" })).rejects.toMatchObject({ code: "WORKSPACE_R0072", message: expect.stringContaining("requires a repository") })
    const noToken = createGitHubWorkspaceStore({ provider: "github", repository: "onmax/repo" }, "content")
    await expect(noToken.history!.head({ ref: "main" })).rejects.toMatchObject({ code: "WORKSPACE_R0072", message: expect.stringContaining("requires a token") })
    expect(fake.requests).toHaveLength(0)
  })

  it("carries the database option on the store target", async () => {
    const database = { name: "db" }
    const { resolveWorkspaceStoreTarget } = await import("../src/storage/target.ts")
    const store = createGitHubWorkspaceStore({ provider: "github", repository: "onmax/repo", token: "token", database }, "content")
    await expect(resolveWorkspaceStoreTarget(store)).resolves.toMatchObject({ provider: "github", repository: "onmax/repo", database })
  })

  it("keeps root, refs, and database when it resolves the store options", () => {
    const database = { name: "db" }
    expect(normalizeWorkspaceStoreOptions({ provider: "github", repo: "onmax/repo", root: "", refs: aliases, database }, { env: {} }))
      .toMatchObject({ provider: "github", repository: "onmax/repo", root: "", refs: aliases, database })
    expect(normalizeWorkspaceStoreOptions({ provider: "github", repo: "onmax/repo" }, { env: {} })).toMatchObject({ root: ".vitehub/workspaces/<workspace>" })
    expect(normalizeWorkspaceStoreOptions({ provider: "github", repo: "onmax/repo" }, { env: {} })).not.toHaveProperty("refs")
  })

  it("reads only the last line of a message as metadata and keeps the commit's author", async () => {
    const trailer = `Vitehub-Metadata: ${JSON.stringify({ content: { forged: true }, author: "Eve", authorEmail: "eve@example.com" })}`
    fake.commit("main", { "posts/a.md": "a" }, { message: `Subject\n\n${trailer}\n\nMore text` })
    const [middle] = (await history().list({ ref: "main", limit: 1 })).revisions
    expect(middle!.metadata).not.toHaveProperty("content")
    expect(middle!.message).toBe(`Subject\n\n${trailer}\n\nMore text`)
    fake.commit("main", { "posts/a.md": "a2" }, { message: `Subject\n\n${trailer}` })
    const [last] = (await history().list({ ref: "main", limit: 1 })).revisions
    expect(last).toMatchObject({ message: "Subject", metadata: { content: { forged: true }, author: "Bot", authorEmail: "bot@example.com" } })
  })

  it("refuses a message with a metadata line and metadata that is too large", async () => {
    const parent = fake.commit("main", { "posts/a.md": "a" })
    const target = history()
    const put = { "posts/b.md": file("posts/b.md", "b") }
    await expect(target.commit({ ref: "main", ifHead: parent, changes: { put }, message: "Save\nVitehub-Metadata: {}" })).rejects.toMatchObject({ code: "WORKSPACE_R0073" })
    await expect(target.commit({ ref: "main", ifHead: parent, changes: { put }, message: "x".repeat(16 * 1024 + 1) })).rejects.toMatchObject({ code: "WORKSPACE_R0073" })
    await expect(target.commit({ ref: "main", ifHead: parent, changes: { put }, message: "Save", metadata: { big: "x".repeat(64 * 1024) } })).rejects.toMatchObject({ code: "WORKSPACE_R0073" })
    expect(fake.writes()).toHaveLength(0)
    await expect(target.commit({ ref: "main", ifHead: parent, changes: { put }, message: "Save", metadata: { small: "x".repeat(1000) } })).resolves.toMatchObject({ metadata: { small: "x".repeat(1000) } })
  })

  it("reaches an aliased branch only through its alias", async () => {
    const published = fake.commit("main", { "posts/a.md": "a" })
    fake.commit("vitehub/content", { "posts/a.md": "a2" })
    const target = history({ refs: aliases })
    const put = { "posts/b.md": file("posts/b.md", "b") }
    await expect(target.head({ ref: "main" })).rejects.toMatchObject({ code: "WORKSPACE_R0071", message: expect.stringContaining("Use \"published\"") })
    await expect(target.list({ ref: "vitehub/content" })).rejects.toMatchObject({ code: "WORKSPACE_R0071" })
    await expect(target.commit({ ref: "main", ifHead: published, changes: { put } })).rejects.toMatchObject({ code: "WORKSPACE_R0071" })
    await expect(target.commit({ ref: "published", ifHead: published, ifHeads: { "vitehub/content": null }, changes: { put } })).rejects.toMatchObject({ code: "WORKSPACE_R0071" })
    expect(fake.writes()).toHaveLength(0)
    // A call without ref uses main, which is the published ref here.
    await expect(target.head()).resolves.toMatchObject({ id: published, ref: "published" })
  })

  it("starts a missing branch from the revision that startFrom names", async () => {
    const first = fake.commit("main", { "posts/a.md": "a" })
    const second = fake.commit("main", { "posts/a.md": "a2", "posts/c.md": "c" })
    const revision = await history({ refs: aliases }).commit({ ref: "draft", ifHead: null, startFrom: first, changes: { put: { "posts/b.md": file("posts/b.md", "b") } } })
    expect(revision.parentId).toBe(first)
    expect(fake.tree("vitehub/content").map(entry => [entry.path, entry.sha]).sort()).toEqual([["posts/a.md", textSha("a")], ["posts/b.md", textSha("b")]])
    expect(fake.head("main")).toBe(second)
  })

  it("merges one ref into another and keeps the merge metadata", async () => {
    const published = fake.commit("main", { "posts/a.md": "a" })
    const target = history({ refs: aliases })
    const draft = await target.commit({ ref: "draft", ifHead: null, changes: { put: { "posts/b.md": file("posts/b.md", "b") } } })
    const added = fake.commit("main", { "posts/c.md": "c" })
    const metadata = { content: { action: "sync", from: added } }
    const merged = await target.merge!({ from: "published", into: "draft", message: "Sync", metadata })
    expect(merged).toMatchObject({ ref: "draft", message: "Sync", metadata })
    expect(fake.commits.get(merged!.id)!.parents).toEqual([draft.id, added])
    expect(fake.tree("vitehub/content").map(entry => entry.path).sort()).toEqual(["posts/a.md", "posts/b.md", "posts/c.md"])
    await expect(target.head({ ref: "draft" })).resolves.toMatchObject({ id: merged!.id })
    // Nothing is left to merge.
    await expect(target.merge!({ from: "published", into: "draft" })).resolves.toBeNull()
    expect(fake.head("main")).toBe(added)
    expect(published).not.toBe(added)
  })

  it("maps a merge conflict to WORKSPACE_CONFLICT", async () => {
    fake.commit("main", { "posts/a.md": "a" })
    const target = history({ refs: aliases })
    await target.commit({ ref: "draft", ifHead: null, changes: { put: { "posts/a.md": file("posts/a.md", "draft") } } })
    fake.commit("main", { "posts/a.md": "main" })
    const head = fake.head("vitehub/content")
    await expect(target.merge!({ from: "published", into: "draft" })).rejects.toMatchObject({
      code: "WORKSPACE_CONFLICT",
      message: expect.stringContaining("conflicts"),
      details: { from: "published", into: "draft" },
    })
    expect(fake.head("vitehub/content")).toBe(head)
  })

  it("opens a pull request and lists the open ones by head prefix", async () => {
    const published = fake.commit("main", { "posts/a.md": "a" })
    const target = history({ refs: aliases })
    await target.commit({ ref: "vitehub/publish/abc1234-1", ifHead: null, startFrom: published, changes: { put: { "posts/b.md": file("posts/b.md", "b") } } })
    await target.commit({ ref: "other/branch", ifHead: null, startFrom: published, changes: { put: { "posts/b.md": file("posts/b.md", "b") } } })
    const opened = await target.openPullRequest!({ head: "vitehub/publish/abc1234-1", base: "published", title: "Publish 1 document", body: "Body" })
    expect(opened).toEqual({ number: 1, url: "https://github.com/onmax/repo/pull/1", title: "Publish 1 document", head: "vitehub/publish/abc1234-1", base: "published" })
    expect(fake.pulls[0]).toMatchObject({ base: "main", head: "vitehub/publish/abc1234-1", body: "Body" })
    await target.openPullRequest!({ head: "other/branch", base: "published", title: "Other" })
    vi.useFakeTimers({ toFake: ["Date"] })
    await expect(target.pullRequests!({ headPrefix: "vitehub/publish/" })).resolves.toEqual([{ ...opened, mergeBase: published }])
    fake.mergePullRequest(1)
    vi.advanceTimersByTime(6_000)
    await expect(target.pullRequests!({ headPrefix: "vitehub/publish/" })).resolves.toEqual([])
    await expect(target.pullRequests!({ headPrefix: "other/" })).resolves.toMatchObject([{ head: "other/branch" }])
  })

  it("merges what it can and keeps the receiving ref's version of a file that both sides changed", async () => {
    fake.commit("main", { "posts/a.md": "a", "posts/b.md": "b", "README.md": "r" })
    const target = history({ refs: aliases })
    const draft = await target.commit({ ref: "draft", ifHead: null, changes: { put: { "posts/a.md": file("posts/a.md", "a draft"), "posts/b.md": file("posts/b.md", "b draft") } } })
    const main = fake.commit("main", { "posts/a.md": "a main", "posts/c.md": "c main", "README.md": "r main" })
    await expect(target.merge!({ from: "published", into: "draft" })).rejects.toMatchObject({ code: "WORKSPACE_CONFLICT" })
    const onConflict = vi.fn(() => ({ content: { conflicts: ["posts/a.md"] } }))
    const merged = await target.merge!({ from: "published", into: "draft", metadata: { content: { action: "sync" } }, onConflict })
    expect(onConflict).toHaveBeenCalledWith([{ path: "posts/a.md", ours: textSha("a draft"), theirs: textSha("a main") }])
    expect(fake.commits.get(merged!.id)!.parents).toEqual([draft.id, main])
    const tree = new Map(fake.tree("vitehub/content").map(entry => [entry.path, entry.sha]))
    // The draft keeps its own file, takes what only main changed, and keeps what only it changed.
    expect(Object.fromEntries(tree)).toEqual({
      "README.md": textSha("r main"),
      "posts/a.md": textSha("a draft"),
      "posts/b.md": textSha("b draft"),
      "posts/c.md": textSha("c main"),
    })
    expect(merged).toMatchObject({ ref: "draft", metadata: { content: { conflicts: ["posts/a.md"] } } })
    await expect(target.head({ ref: "draft" })).resolves.toMatchObject({ id: merged!.id })
    // Main is now part of the draft's history.
    await expect(target.merge!({ from: "published", into: "draft" })).resolves.toBeNull()
  })

  it("tries a merge once more when another update of the branch won, and does not call that a conflict", async () => {
    fake.commit("main", { "posts/a.md": "a" })
    const target = history({ refs: aliases })
    await target.commit({ ref: "draft", ifHead: null, changes: { put: { "posts/b.md": file("posts/b.md", "b") } } })
    fake.commit("main", { "posts/c.md": "c" })
    let raced = 0
    fake.respond(request => request.method === "POST" && request.path.endsWith("/merges") && raced++ < 1
      ? Response.json({ message: "Head branch was modified. Review and try the merge again." }, { status: 409 })
      : undefined)
    await expect(target.merge!({ from: "published", into: "draft", onConflict: () => ({}) })).resolves.toMatchObject({ ref: "draft" })
    expect(raced).toBe(2)
    // A second lost race is an error, and not a conflict.
    fake.commit("main", { "posts/d.md": "d" })
    fake.respond(request => request.method === "POST" && request.path.endsWith("/merges")
      ? Response.json({ message: "Head branch was modified. Review and try the merge again." }, { status: 409 })
      : undefined)
    const failed = await target.merge!({ from: "published", into: "draft", onConflict: () => ({}) }).catch((error: unknown) => error)
    expect(failed).toBeInstanceOf(Error)
    expect(failed).not.toMatchObject({ code: "WORKSPACE_CONFLICT" })
  })

  it("deletes the head branch when the pull request cannot be opened", async () => {
    const published = fake.commit("main", { "posts/a.md": "a" })
    const target = history({ refs: aliases })
    await target.commit({ ref: "vitehub/publish/abc1234-1", ifHead: null, startFrom: published, changes: { put: { "posts/b.md": file("posts/b.md", "b") } } })
    fake.respond(request => request.method === "POST" && request.path.endsWith("/pulls") ? Response.json({ message: "Validation Failed: no commits between" }, { status: 422 }) : undefined)
    await expect(target.openPullRequest!({ head: "vitehub/publish/abc1234-1", base: "published", title: "T", deleteHeadOnFailure: true })).rejects.toThrow("422")
    expect(fake.head("vitehub/publish/abc1234-1")).toBeUndefined()
    // Without the option the branch stays.
    await target.commit({ ref: "vitehub/publish/abc1234-2", ifHead: null, startFrom: published, changes: { put: { "posts/b.md": file("posts/b.md", "b") } } })
    await expect(target.openPullRequest!({ head: "vitehub/publish/abc1234-2", base: "published", title: "T" })).rejects.toThrow()
    expect(fake.head("vitehub/publish/abc1234-2")).toBeDefined()
  })

  it("finds the open pull requests of publish branches without reading commit messages", async () => {
    const published = fake.commit("main", { "posts/a.md": "a" })
    const target = history({ refs: aliases })
    for (const name of ["one", "two", "three"]) await target.commit({ ref: `vitehub/publish/${name}`, ifHead: null, startFrom: published, message: "No trailer", changes: { put: { [`posts/${name}.md`]: file(`posts/${name}.md`, name) } } })
    await target.openPullRequest!({ head: "vitehub/publish/one", base: "published", title: "One" })
    await target.openPullRequest!({ head: "vitehub/publish/three", base: "published", title: "Three" })
    const found = await target.pullRequests!({ headPrefix: "vitehub/publish/" })
    expect(found.map(entry => [entry.number, entry.head])).toEqual([[2, "vitehub/publish/three"], [1, "vitehub/publish/one"]])
    expect(fake.requests.some(request => request.path.endsWith("/git/matching-refs/heads/vitehub/publish/"))).toBe(true)
    await expect(target.pullRequests!()).rejects.toThrow("headPrefix")
  })
})
