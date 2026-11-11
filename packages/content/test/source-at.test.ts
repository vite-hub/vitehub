import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { kv } from "@vite-hub/kv"
import { enableViteHubTestMode } from "@vite-hub/runtime/internal/test-mode-setup"
import { github } from "@vite-hub/source"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createFakeGitHub, fakeSha } from "../../workspace/test/fake-github.ts"
import { defineContent, registerContentKV } from "../src/index.ts"
import { MAX_SOURCE_VIEWS } from "../src/source-heads.ts"

import type { FakeGitHub } from "../../workspace/test/fake-github.ts"
import type { ContentSourceView } from "../src/index.ts"

const cleanup: Array<() => Promise<void> | void> = []
let fake: FakeGitHub

const page = (title: string) => `---\ntitle: ${title}\n---\nBody\n`
/** Frontmatter that YAML cannot parse. */
const broken = "---\ntitle: [unclosed\n---\nBody\n"

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-content-at-"))
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
  vi.spyOn(console, "warn").mockImplementation(() => {})
  registerContentKV(kv)
  cleanup.push(() => registerContentKV(undefined))
})

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

function server() {
  const content = defineContent({ sources: { docs: github({ repo: "acme/docs", ref: "main" }) }, logger: false })
  cleanup.push(() => content.dispose())
  return content
}

async function title(view: Pick<ContentSourceView, "get">, path: string) {
  return (await view.get(path))?.data.title
}

/** The GitHub archives that the fake served. */
function downloads() {
  return fake.requests.filter(request => /\/tarball\/|\/tar\.gz\//.test(request.path)).length
}

describe("content.sources.at()", () => {
  it("opens a commit SHA next to the head", async () => {
    const first = fake.commit("main", { "guide.md": page("Guide"), "old.md": page("Old") })
    fake.commit("main", { "guide.md": page("Guide v2"), "old.md": null })
    const content = server()

    const view = await content.sources.at(first.toUpperCase(), "docs")
    expect(view).toMatchObject({ source: "docs", ref: first, kind: "commit", sha: first, pull: null })
    expect(await title(view, "/guide")).toBe("Guide")
    expect((await view.list()).map(item => item.path).sort()).toEqual(["/guide", "/old"])
    expect((await view.navigation()).length).toBe(2)

    // The head instance reads its own commit and its own cache entries.
    expect((await content.get("/guide"))?.data.title).toBe("Guide v2")
    expect(await content.get("/old")).toBeFalsy()
    expect(await title(view, "/old")).toBe("Old")
  })

  it("opens a branch whose name has a slash, and holds the lookup for 30 seconds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    fake.commit("main", { "guide.md": page("Guide") })
    const first = fake.commit("feat/new-guide", { "guide.md": page("Draft guide") })
    const content = server()

    const view = await content.sources.at("feat/new-guide", "docs")
    expect(view).toMatchObject({ ref: "feat/new-guide", kind: "branch", sha: first, pull: null })
    expect(await title(view, "/guide")).toBe("Draft guide")

    const second = fake.commit("feat/new-guide", { "guide.md": page("Draft guide v2") })
    vi.advanceTimersByTime(29_000)
    expect((await content.sources.at("feat/new-guide", "docs")).sha).toBe(first)
    vi.advanceTimersByTime(2_000)
    const moved = await content.sources.at("feat/new-guide", "docs")
    expect(moved.sha).toBe(second)
    expect(await title(moved, "/guide")).toBe("Draft guide v2")
    // A view keeps its commit after the branch moves.
    expect(await title(view, "/guide")).toBe("Draft guide")
  })

  it("opens the head commit of a pull request, with what a preview rule needs", async () => {
    fake.commit("main", { "guide.md": page("Guide") })
    const head = fake.commit("feat/pr", { "guide.md": page("PR guide") })
    fake.commit("fork-branch", { "guide.md": page("Fork guide") })
    fake.openPull("feat/pr", "main", "Same repository", { labels: ["preview:enabled"] })
    fake.openPull("fork-branch", "main", "From a fork", { fork: "mallory/docs" })
    const content = server()

    const view = await content.sources.at("pr/1", "docs")
    expect(view).toMatchObject({
      ref: "pr/1",
      kind: "pull",
      sha: head,
      pull: { number: 1, state: "open", merged: false, head: "feat/pr", headRepo: "acme/docs", base: "main", fork: false, labels: ["preview:enabled"] },
    })
    expect(await title(view, "/guide")).toBe("PR guide")
    expect((await content.sources.at("pr/2", "docs")).pull).toMatchObject({ fork: true, headRepo: "mallory/docs", labels: [] })
  })

  it("names a ref that the repository does not have", async () => {
    fake.commit("main", { "guide.md": page("Guide") })
    const content = server()

    for (const ref of ["missing", "feat", "pr/99", fakeSha("missing commit")]) {
      await expect(content.sources.at(ref, "docs")).rejects.toMatchObject({ code: "CONTENT_R0028", message: expect.stringContaining(JSON.stringify(ref)) })
    }
    // A failed lookup is not held: the branch opens once it exists.
    fake.commit("missing", { "guide.md": page("Now here") })
    expect(await title(await content.sources.at("missing", "docs"), "/guide")).toBe("Now here")
  })

  it("rejects an invalid ref before it asks GitHub", async () => {
    const content = server()
    const invalid: unknown[] = [
      "",
      "x".repeat(201),
      "../secrets",
      "feat/../main",
      "/main",
      "main/",
      "feat//x",
      ".hidden",
      "feat/.x",
      "main.lock",
      "main.",
      "feat/-/guide",
      "-main",
      "feat x",
      "feat~1",
      "main@{1}",
      "feat\\x",
      "%2e%2e",
      "pr/0",
      "pr/abc",
      "pr/12/guide",
      42,
    ]
    for (const ref of invalid) {
      // SAFETY: The test passes values that a JavaScript caller or a route parameter can pass.
      await expect(content.sources.at(ref as string, "docs")).rejects.toMatchObject({ code: "CONTENT_R0027" })
    }
    expect(fake.requests).toHaveLength(0)
    await expect(content.sources.at("main", "unknown")).rejects.toMatchObject({ code: "CONTENT_R0008" })
  })

  it("opens no view of a commit whose documents do not parse", async () => {
    fake.commit("main", { "guide.md": page("Guide") })
    const bad = fake.commit("feat/broken", { "broken.md": broken })
    const content = server()

    await expect(content.sources.at("feat/broken", "docs")).rejects.toMatchObject({
      code: "CONTENT_R0030",
      message: expect.stringContaining(`Commit ${bad} of ref "feat/broken"`),
    })
    expect((await content.sources.head("docs")).views).toEqual([])
  })

  it(`holds at most ${MAX_SOURCE_VIEWS} views open`, async () => {
    const shas: string[] = []
    for (let index = 0; index <= MAX_SOURCE_VIEWS; index++) shas.push(fake.commit("main", { "guide.md": page(`Guide ${index}`) }))
    const content = server()

    const opened: ContentSourceView[] = []
    for (const sha of shas) {
      const view = await content.sources.at(sha, "docs")
      expect(await title(view, "/guide")).toBe(`Guide ${opened.length}`)
      opened.push(view)
    }
    expect((await content.sources.head("docs")).views).toEqual(shas.slice(1))

    // A view that left the pool opens again from the commit cache, and the pool stays bounded.
    const before = downloads()
    expect(await title(opened[0]!, "/guide")).toBe("Guide 0")
    const { views } = await content.sources.head("docs")
    expect(views).toHaveLength(MAX_SOURCE_VIEWS)
    expect(views.at(-1)).toBe(shas[0])
    expect(downloads()).toBe(before)
  })

  it("shares one view and one download between refs at the same commit", async () => {
    fake.commit("main", { "guide.md": page("Guide") })
    const sha = fake.commit("feat/shared", { "guide.md": page("Shared") })
    fake.openPull("feat/shared", "main", "Shared")
    const content = server()

    const views = await Promise.all(["feat/shared", "pr/1", sha].map(ref => content.sources.at(ref, "docs")))
    expect(views.map(view => [view.kind, view.sha])).toEqual([["branch", sha], ["pull", sha], ["commit", sha]])
    expect(await Promise.all(views.map(view => title(view, "/guide")))).toEqual(["Shared", "Shared", "Shared"])
    expect(downloads()).toBe(1)
    expect((await content.sources.head("docs")).views).toEqual([sha])
  })

  it("opens refs without a token or a KV store", async () => {
    vi.stubEnv("VITEHUB_GITHUB_TOKEN", "")
    registerContentKV(undefined)
    fake.commit("main", { "guide.md": page("Guide") })
    fake.commit("feat/public", { "guide.md": page("Public preview") })
    const content = server()

    expect(await title(await content.sources.at("feat/public", "docs"), "/guide")).toBe("Public preview")
  })
})
