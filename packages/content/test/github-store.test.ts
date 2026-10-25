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
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

async function setup(options: { database?: boolean, root?: string } = {}) {
  fake.commit("main", {
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
    ...((options.root ?? "") === "" ? { rules: { "**": { write: false } } } : {}),
  })
  const content = defineContent({
    workspace,
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
      .rejects.toMatchObject({ code: "CONTENT_R0015", message: expect.stringContaining("needs the Blob + Database store") })
  })

  it("keeps working in a folder of the repository", async () => {
    fake.commit("main", { "site/content/posts/a.md": page("A") })
    const { posts } = await setup({ root: "site" })
    // The collection path is relative to the folder.
    expect((await posts.list()).items.map(item => item.id)).toEqual(["a"])
    await posts.save("c", { data: { title: "C" }, body: "" })
    expect(fake.tree("vitehub/content").map(entry => entry.path)).toContain("site/content/posts/c.md")
  })
})
