import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { kv } from "@vite-hub/kv"
import { enableViteHubTestMode } from "@vite-hub/runtime/internal/test-mode-setup"
import { github } from "@vite-hub/source"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

import { createFakeGitHub } from "../../workspace/test/fake-github.ts"
import { documents, singleton } from "../src/collections.ts"
import { defineContent, registerContentKV } from "../src/index.ts"
import { historyWorkspace } from "./history-workspace.ts"

import type { MockInstance } from "vitest"
import type { FakeGitHub } from "../../workspace/test/fake-github.ts"

const cleanup: Array<() => Promise<void> | void> = []
let fake: FakeGitHub
let warn: MockInstance<typeof console.warn>

const page = (title: string) => `---\ntitle: ${title}\n---\nBody\n`
const at = (day: number) => `2026-10-${String(day).padStart(2, "0")}T08:00:00.000Z`

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-content-history-"))
  enableViteHubTestMode({ root })
  cleanup.push(async () => {
    await enableViteHubTestMode({ root }).reset()
    Reflect.deleteProperty(globalThis, Symbol.for("vitehub.test"))
    await rm(root, { recursive: true, force: true })
  })
  fake = createFakeGitHub({ owner: "acme", repo: "docs" })
  vi.stubGlobal("fetch", vi.fn(fake.fetch))
  vi.stubEnv("VITEHUB_GITHUB_TOKEN", "token")
  vi.stubEnv("FORGES_GITHUB_TOKEN", "")
  warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  registerContentKV(kv)
  cleanup.push(() => registerContentKV(undefined))
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  warn.mockRestore()
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

function server() {
  const content = defineContent({ route: "public", sources: { docs: github({ repo: "acme/docs", ref: "main", root: "content" }) }, logger: false })
  cleanup.push(() => content.dispose())
  return content
}

/** Requests that list commits. */
const commitLists = () => fake.requests.filter(request => request.path === "/repos/acme/docs/commits")

describe("content.history() for github() Sources", () => {
  it("lists the commits of the page file up to the head, newest first", async () => {
    const first = fake.commit("main", { "content/guide.md": page("Guide") }, { message: "Add the guide\n\nLong body", author: { date: at(1), name: "Ada", login: "ada" } })
    fake.commit("main", { "content/other.md": page("Other") }, { message: "Add other" })
    const second = fake.commit("main", { "content/guide.md": page("Guide v2") }, { message: "Edit the guide", author: { date: at(2), name: "Grace Hopper" } })
    const content = server()

    const history = await content.history("/guide")
    expect(history).toEqual({
      entries: [
        { id: second, at: at(2), author: "Grace Hopper", message: "Edit the guide", url: `https://github.com/acme/docs/commit/${second}` },
        { id: first, at: at(1), author: "ada", message: "Add the guide", url: `https://github.com/acme/docs/commit/${first}` },
      ],
    })
    expect(commitLists()[0]!.search.get("path")).toBe("content/guide.md")
    expect(await content.history("/missing")).toBeNull()
  })

  it("stops at the head commit, not at the branch", async () => {
    const first = fake.commit("main", { "content/guide.md": page("Guide") })
    const content = server()
    expect((await content.get("/guide"))?.data.title).toBe("Guide")
    // A push that the head has not reached yet stays out of the public history.
    fake.commit("main", { "content/guide.md": page("Guide v2") })

    expect((await content.history("/guide"))!.entries.map(entry => entry.id)).toEqual([first])
    expect(commitLists().at(-1)!.search.get("sha")).toBe(first)
  })

  it("caches each page per head commit", async () => {
    fake.commit("main", { "content/guide.md": page("Guide") })
    const content = server()
    const first = await content.history("/guide")
    const before = commitLists().length

    expect(await content.history("/guide")).toEqual(first)
    expect(commitLists()).toHaveLength(before)
    expect(before).toBe(1)
    // Another server instance reads the page from KV.
    expect(await server().history("/guide")).toEqual(first)
    expect(commitLists()).toHaveLength(before)

    // A new head reads GitHub again.
    fake.commit("main", { "content/guide.md": page("Guide v2") })
    await content.sources.advance("docs")
    expect((await content.history("/guide"))!.entries).toHaveLength(2)
    expect(commitLists()).toHaveLength(before + 1)
  })

  it("keeps the cache of another Source root apart", async () => {
    fake.commit("main", { "en/guide.md": page("Guide"), "es/guide.md": page("Guía") }, { message: "Add both" })
    fake.commit("main", { "es/guide.md": page("Guía v2") }, { message: "Edit the Spanish guide" })
    const english = defineContent({ route: "public", sources: { docs: github({ repo: "acme/docs", ref: "main", root: "en" }) }, logger: false })
    cleanup.push(() => english.dispose())
    expect((await english.history("/guide"))!.entries.map(entry => entry.message)).toEqual(["Add both"])
    const spanish = defineContent({ route: "public", sources: { docs: github({ repo: "acme/docs", ref: "main", root: "es" }) }, logger: false })
    cleanup.push(() => spanish.dispose())
    expect((await spanish.history("/guide"))!.entries.map(entry => entry.message)).toEqual(["Edit the Spanish guide", "Add both"])
  })

  it("pages with limit and cursor", async () => {
    const shas = [1, 2, 3, 4, 5].map(day => fake.commit("main", { "content/guide.md": page(`Guide ${day}`) }, { author: { date: at(day), name: "Ada" } }))
    const content = server()

    const first = await content.history("/guide", { limit: 2 })
    expect(first!.entries.map(entry => entry.id)).toEqual([shas[4], shas[3]])
    const second = await content.history("/guide", { limit: 2, cursor: first!.cursor })
    expect(second!.entries.map(entry => entry.id)).toEqual([shas[2], shas[1]])
    const last = await content.history("/guide", { limit: 2, cursor: second!.cursor })
    expect(last).toEqual({ entries: [expect.objectContaining({ id: shas[0] })] })
    // All three calls read one cached page of 100 commits.
    expect(commitLists()).toHaveLength(1)

    await expect(content.history("/guide", { cursor: "nope" })).rejects.toMatchObject({ code: "CONTENT_R0008" })
    await expect(content.history("/guide", { limit: 0 })).rejects.toMatchObject({ code: "CONTENT_R0008" })
  })

  it("reads past the first page of 100 commits", async () => {
    for (let index = 0; index < 101; index++) fake.commit("main", { "content/guide.md": page(`Guide ${index}`) })
    const content = server()

    const first = await content.history("/guide", { limit: 100 })
    expect(first!.entries).toHaveLength(100)
    expect(first!.cursor).toBe("100")
    const rest = await content.history("/guide", { limit: 100, cursor: first!.cursor })
    expect(rest!.entries).toHaveLength(1)
    expect(rest!.cursor).toBeUndefined()
    expect(commitLists().map(request => request.search.get("page"))).toEqual(["1", "2"])
  })

  it("returns no entries and logs CONTENT_R0040 without a token", async () => {
    vi.stubEnv("VITEHUB_GITHUB_TOKEN", "")
    fake.commit("main", { "content/guide.md": page("Guide") })
    const content = server()

    expect(await content.history("/guide")).toEqual({ entries: [] })
    await content.history("/guide")
    expect(commitLists()).toHaveLength(0)
    const warnings = warn.mock.calls.map(([message]) => String(message)).filter(message => message.includes("CONTENT_R0040"))
    expect(warnings).toEqual([expect.stringContaining(`content.history() returned no entries for Content source "docs"`)])
  })
})

describe("content.history() for collections", () => {
  it("lists published revisions only", async () => {
    const workspace = await historyWorkspace(cleanup)
    const content = defineContent({ workspace, collections: { posts: documents({ path: "posts/**/*.md", fields: { title: z.string() } }) }, logger: false })
    cleanup.push(() => content.dispose())
    const posts = content.collection("posts")

    await posts.save("hello", { data: { title: "Hello" }, body: "One\n" })
    expect(await content.history("/hello")).toBeNull()
    const first = await content.publish({ collection: "posts", ids: ["hello"], message: "Ship hello\n\nDetails", metadata: { author: { id: "ada", name: "Ada" } } })
    await posts.save("hello", { data: { title: "Hello v2" }, body: "Two\n" }, { metadata: { author: "draft-author" } })

    const history = await content.history("/hello")
    expect(history).toEqual({ entries: [{ id: first.revision!.id, at: first.revision!.createdAt, author: "Ada", message: "Ship hello", url: null }] })

    const second = await content.publish({ collection: "posts", ids: ["hello"], metadata: { author: "grace" } })
    const page = await content.history("/hello", { limit: 1 })
    expect(page!.entries).toEqual([expect.objectContaining({ id: second.revision!.id, author: "grace" })])
    const next = await content.history("/hello", { limit: 1, cursor: page!.cursor })
    expect(next!.entries).toEqual([expect.objectContaining({ id: first.revision!.id })])
  })
  it("lists the history of a singleton page", async () => {
    const workspace = await historyWorkspace(cleanup)
    const content = defineContent({ workspace, collections: { home: singleton({ path: "home.md", url: "/", fields: { title: z.string() } }) }, logger: false })
    cleanup.push(() => content.dispose())
    await content.collection("home").save({ data: { title: "Home" }, body: "Hi\n" })
    const published = await content.publish({ collection: "home", message: "Ship home" })
    expect(await content.history("/")).toEqual({ entries: [expect.objectContaining({ id: published.revision!.id, message: "Ship home" })] })
  })

  it("lists the source locale history of a page that falls back to it", async () => {
    const workspace = await historyWorkspace(cleanup)
    const content = defineContent({ workspace, collections: { docs: documents({ path: "docs/{locale}/**/*.md", locales: ["en", "es"], fields: { title: z.string() } }) }, logger: false })
    cleanup.push(() => content.dispose())
    await content.collection("docs").save("guide", { data: { title: "Guide" }, body: "One\n" })
    const published = await content.publish({ collection: "docs", ids: ["guide"], message: "Ship guide" })
    const english = await content.history("/guide")
    expect(english!.entries).toEqual([expect.objectContaining({ id: published.revision!.id })])
    expect(await content.history("/es/guide")).toEqual(english)
  })
})
