import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createClient } from "@libsql/client"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/libsql"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

import { useWorkspace } from "@vite-hub/workspace"
import { registerWorkspace } from "@vite-hub/workspace/test"

import { createFakeGitHub, textSha } from "../../workspace/test/fake-github.ts"
import { contentSessionsSchema } from "../src/database.ts"
import { documents } from "../src/collections.ts"
import { defineContent } from "../src/index.ts"
import { createContentConsoleActions } from "../src/runtime/console.ts"
import cms from "../src/presets/cms.ts"

import type { FakeGitHub } from "../../workspace/test/fake-github.ts"

const sessionsTable = await readFile(new URL("./fixtures/sessions.sql", import.meta.url), "utf8")
const cleanup: Array<() => Promise<void> | void> = []
let fake: FakeGitHub
let workspaces = 0

const page = (title: string, body = "Body\n") => `---\ntitle: ${title}\n---\n${body}`

beforeEach(() => {
  fake = createFakeGitHub()
  vi.stubGlobal("fetch", vi.fn(fake.fetch))
  vi.stubEnv("VITEHUB_GITHUB_TOKEN", "")
  vi.stubEnv("FORGES_GITHUB_TOKEN", "")
})

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

async function setup(options: { database?: boolean, publish?: "commit" | "pr", root?: string, seed?: boolean } = {}) {
  if (options.seed !== false) fake.commit("main", {
    "README.md": "# Docs\n",
    "package.json": "{}\n",
    "content/posts/a.md": page("A"),
  })
  let database: ReturnType<typeof drizzle> | undefined
  if (options.database !== false) {
    const root = await mkdtemp(join(tmpdir(), "vitehub-content-github-"))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const client = createClient({ url: `file:${join(root, "sessions.sqlite")}` })
    cleanup.push(() => client.close())
    database = drizzle(client, { schema: contentSessionsSchema })
    for (const statement of sessionsTable.split(";").filter(statement => statement.trim())) await database.run(sql.raw(statement))
  }
  const workspace = `github-${process.pid}-${++workspaces}`
  registerWorkspace(workspace, {
    store: {
      provider: "github",
      repository: "onmax/repo",
      token: "token",
      branch: "main",
      root: options.root ?? "",
      refs: { published: "main", draft: "vitehub/content" },
      ...(database ? { database } : {}),
    },
    rules: { "**": { write: false } },
  })
  const content = defineContent({
    ...(options.publish ? { extends: [cms, { store: "github", publish: options.publish, workspace }] as const } : { workspace }),
    collections: { posts: documents({ path: "content/posts/**/*.md", fields: { title: z.string() } }) },
    logger: false,
  })
  cleanup.push(() => content.dispose())
  return { content, posts: content.collection("posts"), workspace }
}

describe("Content on the GitHub store", () => {
  it("reads published documents from the main branch", async () => {
    const { posts } = await setup()
    expect(await posts.get("a")).toMatchObject({ data: { title: "A" }, body: "Body\n" })
    expect((await posts.list()).items.map(item => item.id)).toEqual(["a"])
    expect(await posts.status("a")).toMatchObject({ state: "published" })
  })

  it("creates the draft branch with the first save, without a seed commit", async () => {
    const { posts } = await setup()
    const main = fake.head("main")
    const saved = await posts.save("b", { data: { title: "B" }, body: "New\n" })
    const draft = fake.head("vitehub/content")!
    expect(draft).toBe(saved.revision)
    expect(fake.commits.get(draft)!.parents).toEqual([main])
    expect(fake.commits.get(draft)!.message.split("\n")[0]).toBe("Save posts/b")
    expect(fake.tree("vitehub/content").map(entry => entry.path).sort()).toEqual(["README.md", "content/posts/a.md", "content/posts/b.md", "package.json"])
    expect(fake.head("main")).toBe(main)
    expect(await posts.status("b")).toMatchObject({ state: "draft" })
    expect(await posts.status("a")).toMatchObject({ state: "published" })
    expect((await posts.list({ ref: "draft" })).items.map(item => item.id)).toEqual(["a", "b"])
  })

  it("compares digests as Git blob shas", async () => {
    const { posts } = await setup()
    const saved = await posts.save("b", { data: { title: "B" }, body: "New\n" }, { ifDigest: null })
    const raw = (await posts.raw("b", { ref: "draft" }))!
    expect(saved.digest).toBe(textSha(raw.text))
    expect(saved.digest).toBe(fake.tree("vitehub/content").find(entry => entry.path === "content/posts/b.md")!.sha)
    expect(raw.digest).toBe(saved.digest)
    await expect(posts.save("b", { data: { title: "B2" }, body: "" }, { ifDigest: textSha("old") })).rejects.toMatchObject({ code: "WORKSPACE_CONFLICT" })
    const again = await posts.save("b", { data: { title: "B2" }, body: "" }, { ifDigest: saved.digest })
    expect(again.digest).toBe(textSha((await posts.raw("b", { ref: "draft" }))!.text))
    // The same content keeps the draft revision.
    const head = fake.head("vitehub/content")
    await posts.save("b", { data: { title: "B2" }, body: "" })
    expect(fake.head("vitehub/content")).toBe(head)
  })

  it("keeps the content metadata of a save in the commit and reads it back", async () => {
    const { posts, content } = await setup()
    await posts.save("b", { data: { title: "B" }, body: "" })
    const { revisions } = await content.revisions("posts", "b")
    expect(revisions[0]).toMatchObject({ ref: "draft", message: "Save posts/b", metadata: { content: { action: "save", documents: [{ collection: "posts", id: "b" }] } } })
  })

  it("deletes a published document from a draft that does not exist yet", async () => {
    const { posts } = await setup()
    await posts.remove("a")
    expect(fake.tree("vitehub/content").map(entry => entry.path).sort()).toEqual(["README.md", "package.json"])
    expect(await posts.get("a", { ref: "published" })).toMatchObject({ id: "a" })
  })

  it("publishes the draft to the main branch and leaves the other files alone", async () => {
    const { posts, content } = await setup()
    await posts.save("b", { data: { title: "B" }, body: "New\n" })
    const result = await content.publish()
    expect(result.documents).toEqual([{ collection: "posts", id: "b", change: "add" }])
    expect(fake.head("main")).toBe(result.revision!.id)
    expect(fake.tree("main").map(entry => entry.path).sort()).toEqual(["README.md", "content/posts/a.md", "content/posts/b.md", "package.json"])
    expect(await posts.get("b")).toMatchObject({ data: { title: "B" } })
    expect(await posts.status("b")).toMatchObject({ state: "published" })
  })

  it("denies writes outside the collections at the repository root", async () => {
    const { workspace, posts } = await setup()
    await posts.save("b", { data: { title: "B" }, body: "" })
    const history = useWorkspace(workspace as never, { mode: "write" }).history
    const head = (await history.head({ ref: "draft" }))!.id
    await expect(history.commit({ ref: "draft", ifHead: head, changes: { put: { "package.json": { content: "{\"name\":\"x\"}" } } } }))
      .rejects.toThrow("does not allow writeFile for package.json")
    await expect(history.commit({ ref: "draft", ifHead: head, changes: { put: { "content/notes.md": { content: "x" } } } }))
      .rejects.toThrow("does not allow writeFile for content/notes.md")
    await expect(history.commit({ ref: "draft", ifHead: head, changes: { delete: ["README.md"] } }))
      .rejects.toThrow("does not allow rm for README.md")
    expect(fake.head("vitehub/content")).toBe(head)
  })

  it("keeps sessions in the Database that the store carries", async () => {
    const { content } = await setup()
    const session = "session-one"
    const result = await content.sessions.acquire("posts", "a", { session, user: { id: "user-1", name: "Ada" } })
    expect(result).toMatchObject({ editing: true, sessions: [{ session, user: { id: "user-1" } }] })
  })

  it("explains a missing Database for sessions", async () => {
    const { content } = await setup({ database: false })
    await expect(content.sessions.list("posts")).rejects.toThrow("uses the \"github\" Store, which has none")
  })

  it("refuses to schedule a publish", async () => {
    const { posts, content } = await setup()
    const saved = await posts.save("b", { data: { title: "B" }, body: "" })
    await expect(content.schedule({ at: new Date(Date.now() + 60_000), expect: [{ collection: "posts", id: "b", digest: saved.digest }] }))
      .rejects.toMatchObject({ code: "CONTENT_R0016", message: expect.stringContaining("needs the Blob + Database store") })
  })

  it("keeps working in a folder of the repository", async () => {
    fake.commit("main", { "site/content/posts/a.md": page("A") })
    const { posts } = await setup({ root: "site" })
    // The collection path is relative to the folder.
    expect((await posts.list()).items.map(item => item.id)).toEqual(["a"])
    await posts.save("c", { data: { title: "C" }, body: "" })
    expect(fake.tree("vitehub/content").map(entry => entry.path)).toContain("site/content/posts/c.md")
  })

  describe("with changes made directly on the published branch", () => {
    /** A commit by someone else on `main`. The Store keeps a branch head for 5 seconds, so time passes too. */
    function onMain(changes: Record<string, string>) {
      fake.commit("main", changes)
      vi.advanceTimersByTime(6_000)
    }

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] })
    })

    it("publishes only what the draft changed and leaves edits made on main alone", async () => {
      const { posts, content } = await setup()
      await posts.save("b", { data: { title: "B" }, body: "New\n" })
      onMain({ "content/posts/a.md": page("A2"), "content/posts/c.md": page("C") })
      expect(await posts.status("a")).toMatchObject({ state: "published" })
      expect(await posts.status("c")).toMatchObject({ state: "published" })
      expect(await posts.status("b")).toMatchObject({ state: "draft" })
      const result = await content.publish()
      expect(result.documents).toEqual([{ collection: "posts", id: "b", change: "add" }])
      const tree = new Map(fake.tree("main").map(entry => [entry.path, entry.sha]))
      expect(tree.get("content/posts/a.md")).toBe(textSha(page("A2")))
      expect(tree.get("content/posts/c.md")).toBe(textSha(page("C")))
      expect(tree.has("content/posts/b.md")).toBe(true)
      expect(fake.head("main")).toBe(result.revision!.id)
    })

    it("refuses the whole publish when a document changed on both branches", async () => {
      const { posts, content } = await setup()
      const a = (await posts.raw("a"))!
      await posts.save("a", { data: { title: "A draft" }, body: "" }, { ifDigest: a.digest })
      await posts.save("b", { data: { title: "B" }, body: "" })
      onMain({ "content/posts/a.md": page("A main") })
      const main = fake.head("main")
      await expect(content.publish()).rejects.toMatchObject({
        code: "WORKSPACE_CONFLICT",
        message: expect.stringContaining("ifPublishedDigest"),
        details: { ref: "published", documents: [{ collection: "posts", id: "a", expected: a.digest, actual: textSha(page("A main")) }] },
      })
      expect(fake.head("main")).toBe(main)
      expect(fake.tree("main").some(entry => entry.path === "content/posts/b.md")).toBe(false)
    })

    it("acknowledges published drafts across later main edits and partial publishes", async () => {
      const { posts, content } = await setup()
      await posts.save("a", { data: { title: "A draft" }, body: "" })
      await posts.save("b", { data: { title: "B draft" }, body: "" })
      await content.publish({ collection: "posts", ids: ["a"] })
      onMain({ "content/posts/a.md": page("A main") })
      fake.commit("vitehub/content", { "README.md": "Other edit" })
      vi.advanceTimersByTime(6_000)
      expect(await posts.status("a")).toMatchObject({ state: "published" })
      expect((await content.publish()).documents).toEqual([{ collection: "posts", id: "b", change: "add" }])
      expect((await posts.get("a"))?.data.title).toBe("A main")
      onMain({ "content/posts/b.md": page("B main") })
      await posts.save("c", { data: { title: "C" }, body: "" })
      expect((await content.publish()).documents).toEqual([{ collection: "posts", id: "c", change: "add" }])
      // A fresh edit after publication remains protected from concurrent main edits.
      const reviewed = (await posts.raw("a", { ref: "published" }))!
      await posts.save("a", { data: { title: "A again" }, body: "" }, { ifPublishedDigest: reviewed.digest })
      onMain({ "content/posts/a.md": page("A newer main") })
      await expect(content.publish()).rejects.toMatchObject({ code: "WORKSPACE_CONFLICT" })
    })

    it.each(["git", "workspace"])("keeps publish protection after a %s commit without Content metadata", async (writer) => {
      const { posts, content, workspace } = await setup()
      await posts.save("b", { data: { title: "B" }, body: "" })
      onMain({ "content/posts/a.md": page("A2"), "content/posts/c.md": page("C") })
      if (writer === "git") {
        fake.commit("vitehub/content", { "content/posts/d.md": page("D") })
        vi.advanceTimersByTime(6_000)
      }
      else {
        const history = useWorkspace(workspace as never, { mode: "write" }).history
        await history.commit({ ref: "draft", ifHead: fake.head("vitehub/content")!, changes: { put: { "content/posts/d.md": page("D") } } })
      }
      expect(await posts.status("a")).toMatchObject({ state: "published" })
      // Check both direct publication and carrying recovered tracking into a subsequent Content save.
      if (writer === "workspace") await posts.save("e", { data: { title: "E" }, body: "" })
      expect((await content.publish()).documents.map(document => document.id)).toEqual(writer === "workspace" ? ["b", "d", "e"] : ["b", "d"])
      expect((await posts.get("a"))?.data.title).toBe("A2")
      expect((await posts.get("c"))?.data.title).toBe("C")
    })

    it("keeps the original conflict after a metadata-free draft commit", async () => {
      const { posts, content, workspace } = await setup()
      await posts.save("a", { data: { title: "A draft" }, body: "" })
      onMain({ "content/posts/a.md": page("A main") })
      const history = useWorkspace(workspace as never, { mode: "write" }).history
      await history.commit({ ref: "draft", ifHead: fake.head("vitehub/content")!, changes: { put: { "content/posts/b.md": page("B") } } })
      const main = fake.head("main")
      await expect(content.publish()).rejects.toMatchObject({ code: "WORKSPACE_CONFLICT", details: { ref: "published", documents: [{ id: "a" }] } })
      expect(fake.head("main")).toBe(main)
    })

    it("refuses to publish a draft whose base cannot be established", async () => {
      const { content } = await setup()
      // An unrelated draft has no Content metadata or shared published revision.
      fake.commit("vitehub/content", { "content/posts/b.md": page("B") })
      const main = fake.head("main")
      await expect(content.publish()).rejects.toMatchObject({ code: "WORKSPACE_CONFLICT", message: expect.stringContaining("cannot establish") })
      expect(fake.head("main")).toBe(main)
    })

    it.each([true, false])("recovers with one save of the reviewed published version (previous draft edit: %s)", async (edited) => {
      const { posts, content } = await setup()
      await posts.save("b", { data: { title: "B" }, body: "" })
      if (edited) await posts.save("a", { data: { title: "A draft" }, body: "" })
      onMain({ "content/posts/a.md": page("A main", "Main body\n") })
      // An existing draft edit stays conflicting. An untouched document first syncs the published edit.
      const blind = await posts.save("a", { data: { title: "A blind" }, body: "" })
      if (edited) await expect(content.publish()).rejects.toMatchObject({ code: "WORKSPACE_CONFLICT" })
      const published = (await posts.get("a", { ref: "published" }))!
      await posts.save("a", { data: { title: "A reviewed" }, body: published.body }, {
        ifDigest: blind.digest,
        ifPublishedDigest: published.digest,
      })
      await content.publish()
      expect(await posts.get("a")).toMatchObject({ data: { title: "A reviewed" }, body: "Main body\n" })
    })

    it("records a reviewed base even when the saved draft bytes are unchanged", async () => {
      const { posts, content } = await setup()
      const input = { data: { title: "A draft" }, body: "" }
      const draft = await posts.save("a", input)
      onMain({ "content/posts/a.md": page("A main") })
      const published = (await posts.raw("a", { ref: "published" }))!
      const rebased = await posts.save("a", input, { ifDigest: draft.digest, ifPublishedDigest: published.digest })
      expect(rebased.revision).not.toBe(draft.revision)
      await content.publish()
      expect((await posts.get("a"))?.data.title).toBe("A draft")
    })

    it("rejects recovery when the reviewed published document moved", async () => {
      const { posts } = await setup()
      const published = (await posts.raw("a"))!
      await posts.save("a", { data: { title: "A draft" }, body: "" })
      onMain({ "content/posts/a.md": page("A main") })
      const draft = fake.head("vitehub/content")
      await expect(posts.save("a", { data: { title: "A reviewed" }, body: "" }, { ifPublishedDigest: published.digest }))
        .rejects.toMatchObject({ code: "WORKSPACE_CONFLICT", details: { ref: "published", expected: published.digest, actual: textSha(page("A main")) } })
      expect(fake.head("vitehub/content")).toBe(draft)
    })

    it("checks the live published head before recording a reviewed base", async () => {
      const { posts } = await setup()
      const input = { data: { title: "A draft" }, body: "" }
      const draft = await posts.save("a", input)
      const published = (await posts.raw("a", { ref: "published" }))!
      // The read cache still holds the reviewed revision; the commit must check the live branch.
      fake.commit("main", { "content/posts/a.md": page("A main") })
      await expect(posts.save("a", input, { ifDigest: draft.digest, ifPublishedDigest: published.digest }))
        .rejects.toMatchObject({ code: "WORKSPACE_CONFLICT", details: { ref: "published" } })
      expect(fake.head("vitehub/content")).toBe(draft.revision)
    })

    it("can acknowledge a published deletion and recreate the document", async () => {
      const { posts, content } = await setup()
      const input = { data: { title: "A draft" }, body: "" }
      const draft = await posts.save("a", input)
      fake.commit("main", { "content/posts/a.md": null })
      vi.advanceTimersByTime(6_000)
      await expect(content.publish()).rejects.toMatchObject({ code: "WORKSPACE_CONFLICT" })
      expect(await posts.get("a", { ref: "published" })).toBeNull()
      await posts.save("a", input, { ifDigest: draft.digest, ifPublishedDigest: null })
      expect((await content.publish()).documents).toEqual([{ collection: "posts", id: "a", change: "add" }])
    })

    it("refuses to delete a document that was deleted or changed on main", async () => {
      const { posts, content } = await setup()
      await posts.remove("a")
      onMain({ "content/posts/a.md": page("A main") })
      await expect(content.publish()).rejects.toMatchObject({ code: "WORKSPACE_CONFLICT", details: { ref: "published", documents: [{ id: "a" }] } })
      expect(fake.tree("main").some(entry => entry.path === "content/posts/a.md")).toBe(true)
    })

    it("starts the draft from the revision that ifDigest was checked against", async () => {
      const { posts } = await setup()
      const first = (await posts.raw("a"))!
      fake.commit("main", { "content/posts/a.md": page("A2") })
      // The Store still reports the earlier head for a few seconds, and the draft starts from exactly that one.
      await posts.save("b", { data: { title: "B" }, body: "" }, { ifDigest: null })
      const draft = fake.commits.get(fake.head("vitehub/content")!)!
      expect(draft.parents).toEqual([first.revision])
      expect(draft.tree.find(entry => entry.path === "content/posts/a.md")!.sha).toBe(first.digest)
    })

    it("publishes a document again after it was published and edited", async () => {
      const { posts, content } = await setup()
      await posts.save("b", { data: { title: "B" }, body: "" })
      await content.publish()
      await posts.save("b", { data: { title: "B2" }, body: "" })
      expect((await content.publish()).documents).toEqual([{ collection: "posts", id: "b", change: "update" }])
      expect((await posts.get("b"))?.data).toMatchObject({ title: "B2" })
    })
  })

  describe("with publish: pr", () => {
    const merges = () => fake.requests.filter(request => request.method === "POST" && request.path.endsWith("/merges"))

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] })
    })

    it("opens a pull request instead of committing to the published branch", async () => {
      const { posts, content } = await setup({ publish: "pr" })
      await posts.save("b", { data: { title: "B" }, body: "New\n" })
      const main = fake.head("main")
      const result = await content.publish()
      expect(result).toMatchObject({ pending: true, pullRequest: { number: 1, url: "https://github.com/onmax/repo/pull/1" }, documents: [{ collection: "posts", id: "b", change: "add" }] })
      expect(fake.head("main")).toBe(main)
      expect(fake.pulls).toHaveLength(1)
      expect(fake.pulls[0]).toMatchObject({ base: "main", draft: false })
      expect(fake.pulls[0]!.head).toMatch(/^vitehub\/publish\/[0-9a-f]{7}-\d{14}-[0-9a-f-]{36}$/)
      expect(fake.pulls[0]!.body).toContain("- `posts/b` (add)")
      const branch = fake.commits.get(fake.head(fake.pulls[0]!.head)!)!
      expect(branch.parents).toEqual([main])
      expect(branch.tree.some(entry => entry.path === "content/posts/b.md")).toBe(true)
      expect(result.revision!.id).toBe(fake.head(fake.pulls[0]!.head))
    })

    it("retries a failed publish after an abandoned reservation expires", async () => {
      const { posts, content } = await setup({ publish: "pr", database: false })
      await posts.save("b", { data: { title: "B" }, body: "" })
      vi.useFakeTimers({ toFake: ["Date"] })
      let openingFails = true
      let cleanupFails = true
      fake.respond(request => (openingFails && request.method === "POST" && request.path.endsWith("/pulls"))
        || (cleanupFails && request.operation === "UpdateRefs")
        ? Response.json({ message: "Unavailable" }, { status: 503 }) : undefined)
      await expect(content.publish({ collection: "posts", ids: ["b"] })).rejects.toThrow()
      expect(fake.branchNames().filter(name => name.startsWith("vitehub/reservations/"))).toHaveLength(1)
      openingFails = false
      await expect(content.publish({ collection: "posts", ids: ["b"] })).rejects.toMatchObject({ code: "CONTENT_R0017" })
      vi.advanceTimersByTime(5 * 60_000 + 1)
      cleanupFails = false
      const result = await content.publish({ collection: "posts", ids: ["b"] })
      expect(result.pullRequest?.number).toBe(1)
      expect(fake.branchNames().filter(name => name.startsWith("vitehub/reservations/"))).toEqual([])
    })

    it.each(["staging", "published"])("stops treating a retargeted pull request as a pending publish (base: %s)", async (base) => {
      const { posts, content } = await setup({ publish: "pr", database: false })
      await posts.save("b", { data: { title: "B" }, body: "" })
      await content.publish({ collection: "posts", ids: ["b"] })
      fake.setBranch(base, fake.head("main")!, fake.tree("main"))
      fake.pulls[0]!.base = base
      const fresh = await setup({ publish: "pr", database: false, seed: false })
      expect((await fresh.posts.status()).find(document => document.id === "b")?.pullRequest).toBeUndefined()
      const result = await fresh.content.publish({ collection: "posts", ids: ["b"] })
      expect(result.pullRequest?.number).toBe(2)
      expect(fake.pulls[1]?.base).toBe("main")
    })

    it.each([false, true])("publishes disjoint documents from one draft in the same second (concurrent: %s)", async (concurrent) => {
      const { posts, content } = await setup({ publish: "pr" })
      await posts.save("b", { data: { title: "B" }, body: "" })
      await posts.save("c", { data: { title: "C" }, body: "" })
      const publish = (id: string) => content.publish({ collection: "posts", ids: [id] })
      const results = concurrent ? await Promise.all([publish("b"), publish("c")]) : [await publish("b"), await publish("c")]
      expect(results.map(result => result.pullRequest?.number)).toEqual([1, 2])
      expect(new Set(fake.pulls.map(pull => pull.head)).size).toBe(2)
    })

    it.each(["same", "partial", "none"])("coordinates separate runtimes (overlap: %s)", async (overlap) => {
      const first = await setup({ publish: "pr", database: false })
      await first.posts.save("b", { data: { title: "B" }, body: "" })
      await first.posts.save("c", { data: { title: "C" }, body: "" })
      await first.posts.save("d", { data: { title: "D" }, body: "" })
      const second = await setup({ publish: "pr", database: false, seed: false })
      // Prime independent Store caches before either instance opens a PR.
      await Promise.all([first.posts.status(), second.posts.status()])
      const results = await Promise.allSettled([
        first.content.publish({ collection: "posts", ids: overlap === "partial" ? ["b", "c"] : ["b"] }),
        second.content.publish({ collection: "posts", ids: overlap === "partial" ? ["c", "d"] : [overlap === "same" ? "b" : "c"] }),
      ])
      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(overlap === "none" ? 2 : 1)
      expect(fake.pulls).toHaveLength(overlap === "none" ? 2 : 1)
      expect(fake.branchNames().filter(name => name.startsWith("vitehub/reservations/"))).toEqual([])
      if (overlap !== "none") {
        // The losing instance still has its stale preflight cache, so it must recheck under the shared reservation.
        const loser = results[0]!.status === "fulfilled" ? second : first
        await expect(loser.content.publish({ collection: "posts", ids: [overlap === "partial" ? "c" : "b"] })).rejects.toMatchObject({ code: "CONTENT_R0017" })
        expect(fake.pulls).toHaveLength(1)
      }
    })

    it("checks Content validation before a direct history merge publishes a draft", async () => {
      const { posts, workspace } = await setup({ publish: "pr" })
      // SAFETY: Deliberately invalid runtime fields must stay draft-only even when a caller merges refs directly.
      await posts.save("b", { data: { title: 123 as never }, body: "" })
      const main = fake.head("main")
      await expect(useWorkspace(workspace, { mode: "write" }).history.merge!({ from: "draft", into: "published" })).rejects.toThrow()
      expect(fake.head("main")).toBe(main)
      expect(fake.branchNames().filter(name => name.startsWith("vitehub/merge/"))).toEqual([])
    })

    it("returns the pull request from the Console publish action", async () => {
      const { posts, workspace } = await setup({ publish: "pr" })
      const saved = await posts.save("b", { data: { title: "B" }, body: "" })
      const editor = defineContent({
        extends: [cms, { store: "github", publish: "pr", workspace }] as const,
        collections: { posts: documents({ path: "content/posts/**/*.md", fields: { title: z.string() } }) },
        authorize: () => true,
        logger: false,
      })
      cleanup.push(() => editor.dispose())
      const result = await createContentConsoleActions({ content: editor }).publish({ collection: "posts", expect: [{ id: "b", digest: saved.digest }] }, { user: { id: "ada" } } as never)
      expect(result).toMatchObject({ documents: [{ id: "b", change: "add" }], pullRequest: { number: 1, url: "https://github.com/onmax/repo/pull/1" } })
    })

    it("shows the pull request on the documents until the published branch has their bytes", async () => {
      const { posts, content } = await setup({ publish: "pr" })
      await posts.save("b", { data: { title: "B" }, body: "" })
      await posts.save("a", { data: { title: "A edited" }, body: "" })
      await content.publish({ collection: "posts", ids: ["b"] })
      vi.advanceTimersByTime(6_000)
      const pr = { number: 1, url: "https://github.com/onmax/repo/pull/1" }
      expect(await posts.status("b")).toMatchObject({ state: "draft", pullRequest: pr })
      expect((await posts.status("a"))?.pullRequest).toBeUndefined()
      fake.mergePullRequest(1)
      vi.advanceTimersByTime(6_000)
      expect(await posts.status("b")).toMatchObject({ state: "published" })
      expect((await posts.status("b"))?.pullRequest).toBeUndefined()
      expect(await posts.get("b")).toMatchObject({ data: { title: "B" } })
    })

    it("applies the conflict rules of commit mode and opens nothing", async () => {
      const { posts, content } = await setup({ publish: "pr" })
      const a = (await posts.raw("a"))!
      await posts.save("a", { data: { title: "A draft" }, body: "" }, { ifDigest: a.digest })
      vi.advanceTimersByTime(6_000)
      fake.commit("main", { "content/posts/a.md": page("A main") })
      vi.advanceTimersByTime(6_000)
      await expect(content.publish()).rejects.toMatchObject({ code: "WORKSPACE_CONFLICT", details: { ref: "published", documents: [{ id: "a" }] } })
      expect(fake.pulls).toHaveLength(0)
      expect([...fake.commits.values()].length).toBeGreaterThan(0)
    })

    it("fails when GitHub refuses the pull request, and leaves no publish branch behind", async () => {
      const { posts, content } = await setup({ publish: "pr" })
      await posts.save("b", { data: { title: "B" }, body: "" })
      fake.respond(request => request.path.endsWith("/pulls") && request.method === "POST" ? Response.json({ message: "Validation Failed: nope" }, { status: 422 }) : undefined)
      await expect(content.publish()).rejects.toThrow("422")
      expect(fake.pulls).toHaveLength(0)
      expect(fake.branchNames().filter(name => name.startsWith("vitehub/publish/"))).toEqual([])
      // The draft keeps its change.
      expect(await posts.status("b")).toMatchObject({ state: "draft" })
    })

    it("refuses to publish a document that an open pull request already publishes", async () => {
      const { posts, content } = await setup({ publish: "pr" })
      await posts.save("b", { data: { title: "B" }, body: "" })
      await content.publish()
      vi.advanceTimersByTime(6_000)
      await expect(content.publish()).rejects.toMatchObject({
        code: "CONTENT_R0017",
        message: expect.stringContaining("posts/b: pull request #1 (https://github.com/onmax/repo/pull/1)"),
      })
      expect(fake.pulls).toHaveLength(1)
      // Other documents are not held back.
      await posts.save("c", { data: { title: "C" }, body: "" })
      expect((await content.publish({ collection: "posts", ids: ["c"] })).pullRequest).toMatchObject({ number: 2 })
    })

    it("finds the pending documents of a pull request whose branch has no Content trailer", async () => {
      const { posts, content } = await setup({ publish: "pr" })
      await posts.save("b", { data: { title: "B" }, body: "" })
      await content.publish()
      // Another tool rewrote the commit, so the message has no trailer.
      fake.commits.get(fake.head(fake.pulls[0]!.head)!)!.message = "Publish by hand"
      vi.advanceTimersByTime(6_000)
      expect(await posts.status("b")).toMatchObject({ pullRequest: { number: 1 } })
      expect(fake.requests.some(request => request.path.endsWith("/git/matching-refs/heads/vitehub/publish/"))).toBe(true)
    })

    it("keeps all pending documents after another commit is added to the publish branch", async () => {
      const { posts, content } = await setup({ publish: "pr" })
      await posts.save("b", { data: { title: "B" }, body: "" })
      await content.publish()
      fake.commit(fake.pulls[0]!.head, { "README.md": "Updated on GitHub" })
      vi.advanceTimersByTime(6_000)

      expect(await posts.status("b")).toMatchObject({ pullRequest: { number: 1 } })
      await expect(content.publish()).rejects.toMatchObject({ code: "CONTENT_R0017" })
    })

    it("writes the pull request title on one line and the message in code", async () => {
      const { posts, content } = await setup({ publish: "pr" })
      await posts.save("b", { data: { title: "B" }, body: "" })
      const message = `Ping @octocat about #12\n${"x".repeat(300)}\n\`\`\`rm\`\`\``
      await content.publish({ message })
      const [pull] = fake.pulls
      expect(pull!.title).not.toMatch(/[\n\r]/)
      expect(pull!.title.length).toBeLessThanOrEqual(200)
      expect(pull!.title).toContain("@\u200Boctocat")
      expect(pull!.title).toContain("#\u200B12")
      expect(pull!.body).toContain("- `posts/b` (add)")
      expect(pull!.body).toContain("````\nPing @octocat about #12")
    })

    describe.each(["merge", "squash", "rebase"] as const)("after a %s merge of its own pull request", (method) => {
      it("keeps the edit made while the pull request was open, and publishes it", async () => {
        const { posts, content } = await setup({ publish: "pr" })
        await posts.save("b", { data: { title: "B1" }, body: "" })
        await content.publish()
        // The author keeps editing while the pull request waits.
        await posts.save("b", { data: { title: "B2" }, body: "" })
        fake.mergePullRequest(1, method)
        vi.advanceTimersByTime(6_000)
        // The next write brings main into the draft. Main holds the draft's earlier version of b, which is no conflict.
        await posts.save("c", { data: { title: "C" }, body: "" })
        expect((await posts.raw("b", { ref: "draft" }))!.text).toContain("B2")
        const head = fake.commits.get(fake.head("vitehub/content")!)!
        const synced = fake.commits.get(head.parents[0]!)!
        expect(synced.parents).toHaveLength(2)
        const result = await content.publish()
        expect(result.documents).toEqual([
          { collection: "posts", id: "b", change: "update" },
          { collection: "posts", id: "c", change: "add" },
        ])
        expect(result.pullRequest).toMatchObject({ number: 2 })
      })

      it("recognizes its pending publish across unrelated draft syncs", async () => {
        const { posts, content } = await setup({ publish: "pr" })
        await posts.save("b", { data: { title: "B1" }, body: "" })
        await content.publish()
        await posts.save("b", { data: { title: "B2" }, body: "" })
        for (const title of ["A2", "A3"]) {
          fake.commit("main", { "content/posts/a.md": page(title) })
          vi.advanceTimersByTime(6_000)
          await posts.save("c", { data: { title }, body: "" })
          expect((await posts.raw("a", { ref: "draft" }))!.text).toContain(title)
        }
        fake.mergePullRequest(1, method)
        vi.advanceTimersByTime(6_000)
        await expect(content.publish()).resolves.toMatchObject({
          pullRequest: { number: 2 },
          documents: expect.arrayContaining([{ collection: "posts", id: "b", change: "update" }]),
        })
        expect((await posts.raw("b", { ref: "draft" }))!.text).toContain("B2")
      })

      it("recognizes its own publish after more than one page of later draft revisions", async () => {
        const { posts, content } = await setup({ publish: "pr" })
        await posts.save("b", { data: { title: "B0" }, body: "" })
        await content.publish()
        for (let i = 1; i <= 35; i++) await posts.save("b", { data: { title: `B${i}` }, body: "" })
        fake.mergePullRequest(1, method)
        vi.advanceTimersByTime(6_000)
        await posts.save("c", { data: { title: "C" }, body: "" })
        await expect(content.publish()).resolves.toMatchObject({ pullRequest: { number: 2 } })
      })

      it("recognizes its own deletion when the draft recreated the document", async () => {
        const { posts, content } = await setup({ publish: "pr" })
        await posts.remove("a")
        await content.publish()
        await posts.save("a", { data: { title: "Recreated" }, body: "" })
        fake.mergePullRequest(1, method)
        vi.advanceTimersByTime(6_000)
        await posts.save("c", { data: { title: "C" }, body: "" })
        await expect(content.publish()).resolves.toMatchObject({ pullRequest: { number: 2 }, documents: expect.arrayContaining([{ collection: "posts", id: "a", change: "add" }]) })
      })

      it("shows the merged publish in the published history of the document", async () => {
        const { posts, content } = await setup({ publish: "pr" })
        await posts.save("b", { data: { title: "B1" }, body: "" })
        await content.publish()
        fake.mergePullRequest(1, method)
        vi.advanceTimersByTime(6_000)
        const { revisions } = await content.revisions("posts", "b", { ref: "published" })
        expect(revisions).toHaveLength(1)
        expect(fake.commits.get(revisions[0]!.id)!.tree.some(entry => entry.path === "content/posts/b.md")).toBe(true)
      })
    })

    it.each([false, true])("keeps an independent historical published state conflicting (deletion: %s)", async (deletion) => {
      const { posts, content } = await setup({ publish: "pr" })
      fake.commit("main", { "content/posts/a.md": deletion ? null : page("Old") })
      fake.commit("main", { "content/posts/a.md": page("Base") })
      await posts.save("a", { data: { title: "Draft" }, body: "" })
      fake.commit("main", { "content/posts/a.md": deletion ? null : page("Old") })
      vi.advanceTimersByTime(6_000)
      await posts.save("b", { data: { title: "B" }, body: "" })
      await expect(content.publish()).rejects.toMatchObject({ code: "WORKSPACE_CONFLICT", details: { ref: "published", documents: [{ id: "a" }] } })
      expect(fake.pulls).toHaveLength(0)
    })

    it("does not treat inherited history before a document sync as its own publish", async () => {
      const { posts, content } = await setup({ publish: "pr" })
      await posts.save("b", { data: { title: "B" }, body: "" })
      fake.commit("main", { "content/posts/a.md": page("A2") })
      vi.advanceTimersByTime(6_000)
      await posts.save("c", { data: { title: "C" }, body: "" })
      expect((await posts.raw("a", { ref: "draft" }))!.text).toContain("A2")
      await posts.save("a", { data: { title: "Draft" }, body: "" })
      fake.commit("main", { "content/posts/a.md": page("A") })
      vi.advanceTimersByTime(6_000)
      await expect(content.publish()).rejects.toMatchObject({ code: "WORKSPACE_CONFLICT", details: { documents: [{ id: "a" }] } })
      expect(fake.pulls).toHaveLength(0)
    })

    it("keeps syncing other documents while one conflicts with the published branch", async () => {
      const { posts, content } = await setup()
      const a = (await posts.raw("a"))!
      await posts.save("a", { data: { title: "A draft" }, body: "" }, { ifDigest: a.digest })
      await posts.save("b", { data: { title: "B" }, body: "" })
      vi.advanceTimersByTime(6_000)
      const main = fake.commit("main", { "content/posts/a.md": page("A main"), "content/posts/d.md": page("D") })
      vi.advanceTimersByTime(6_000)
      // The write merges main. Document a conflicts and stays as the draft has it; d arrives.
      await posts.save("c", { data: { title: "C" }, body: "" })
      const tree = new Map(fake.tree("vitehub/content").map(entry => [entry.path, entry.sha]))
      expect(tree.get("content/posts/d.md")).toBe(textSha(page("D")))
      expect((await posts.raw("a", { ref: "draft" }))!.text).toContain("A draft")
      const merge = fake.commits.get(fake.commits.get(fake.head("vitehub/content")!)!.parents[0]!)!
      expect(merge.parents[1]).toBe(main)
      expect(merge.message).toContain('"conflicts":["content/posts/a.md"]')
      // The conflict does not come back for every write.
      const attempts = merges().length
      await posts.save("e", { data: { title: "E" }, body: "" })
      expect(merges()).toHaveLength(attempts)
      // Publish names the document that both sides changed, and publishes the others when they are chosen.
      await expect(content.publish()).rejects.toMatchObject({ code: "WORKSPACE_CONFLICT", details: { ref: "published", documents: [{ id: "a" }] } })
      expect((await content.publish({ collection: "posts", ids: ["b", "c"] })).documents.map(document => document.id)).toEqual(["b", "c"])
    })

    it("merges published content into the draft on writes, and not on reads", async () => {
      const { posts } = await setup()
      await posts.save("b", { data: { title: "B" }, body: "" })
      const draft = fake.head("vitehub/content")!
      vi.advanceTimersByTime(6_000)
      const added = fake.commit("main", { "content/posts/c.md": page("C"), "content/posts/a.md": page("A2") })
      vi.advanceTimersByTime(6_000)
      expect((await posts.list({ ref: "draft" })).items.map(item => item.id)).toEqual(["a", "b"])
      await posts.status()
      expect(merges()).toHaveLength(0)
      await posts.save("b", { data: { title: "B2" }, body: "" })
      expect(merges()).toHaveLength(1)
      const saved = fake.commits.get(fake.head("vitehub/content")!)!
      const merged = fake.commits.get(saved.parents[0]!)!
      expect(merged.parents).toEqual([draft, added])
      expect(merged.message).toContain("Vitehub-Metadata:")
      expect(saved.message).toContain(added)
      expect((await posts.list({ ref: "draft" })).items.map(item => item.id)).toEqual(["a", "b", "c"])
      expect(await posts.status("a")).toMatchObject({ state: "published" })
      // The same pair costs no request.
      await posts.save("b", { data: { title: "B3" }, body: "" })
      expect(merges()).toHaveLength(1)
    })

    it("goes on without the merge when GitHub refuses it, and warns once", async () => {
      const { posts } = await setup()
      await posts.save("b", { data: { title: "B" }, body: "" })
      vi.advanceTimersByTime(6_000)
      fake.commit("main", { "content/posts/c.md": page("C") })
      vi.advanceTimersByTime(6_000)
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
      fake.respond(request => request.method === "POST" && request.path.endsWith("/merges") ? Response.json({ message: "Resource not accessible" }, { status: 403 }) : undefined)
      await expect(posts.save("b", { data: { title: "B2" }, body: "" })).resolves.toMatchObject({ data: { title: "B2" } })
      await posts.save("b", { data: { title: "B3" }, body: "" })
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0]![0]).toContain("could not bring")
      warn.mockRestore()
    })
  })
})
