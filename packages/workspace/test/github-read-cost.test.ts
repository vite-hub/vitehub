import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { readGitHubReadStats, registerWorkspaceKV } from "../src/providers/github/cache.ts"
import { createGitHubWorkspaceStore } from "../src/providers/github/store.ts"
import { createFakeGitHub } from "./fake-github.ts"

import type { FakeGitHub } from "./fake-github.ts"
import type { WorkspaceKV } from "../src/providers/github/cache.ts"

let fake: FakeGitHub

beforeEach(() => {
  fake = createFakeGitHub({ etags: true })
  vi.stubGlobal("fetch", vi.fn(fake.fetch))
})

afterEach(() => {
  registerWorkspaceKV(undefined)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function history() {
  return createGitHubWorkspaceStore({ provider: "github", repository: "onmax/repo", token: "token", root: "", refs: { published: "main", draft: "draft" } }, "docs").history!
}

/** Requests by shape, such as `GET /commits` or `GET /git/trees/:sha`. */
function shapes(): string[] {
  return fake.requests.map(request => `${request.method} ${request.path.replace(/^\/repos\/onmax\/repo/, "").replace(/[0-9a-f]{40}/g, ":sha")}`)
}

/** A memory KV store with the shape of ViteHub KV. */
function memoryKV(): WorkspaceKV & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>()
  return {
    values,
    get: async <T>(key: string) => [undefined, (values.get(key) as T | undefined) ?? null] as const,
    set: async <T>(key: string, value: T) => {
      values.set(key, structuredClone(value))
      return [undefined, undefined] as const
    },
  }
}

function seedHistory(commits: number) {
  for (let index = 0; index < commits; index++) fake.commit("main", { [`docs/page-${index % 5}.md`]: `# Page ${index}\n` }, { message: `Edit ${index}` })
}

describe("GitHub history reads", () => {
  it("lists a page of revisions with one request, without a commit or tree request per revision", async () => {
    seedHistory(30)
    const listed = await history().list({ ref: "published", limit: 20 })
    expect(listed.revisions).toHaveLength(20)
    expect(listed.revisions[0]).toMatchObject({ ref: "published", message: "Edit 29" })
    expect(listed.revisions[0]).not.toHaveProperty("files")
    expect(shapes()).toEqual(["GET /commits/heads/main", "GET /commits"])
    // The page starts at the head commit, so it names a commit and never changes.
    expect(fake.requests[1]!.search.get("sha")).toBe(fake.head("main"))
  })

  it("reads a branch head with one request, and opens a revision with its file count", async () => {
    seedHistory(3)
    const store = history()
    const head = await store.head({ ref: "published" })
    expect(head).toMatchObject({ id: fake.head("main"), message: "Edit 2" })
    expect(shapes()).toEqual(["GET /commits/heads/main"])
    const view = await store.open(head!.id)
    expect(view.revision).toMatchObject({ id: head!.id, files: 3 })
    expect(shapes()).toEqual(["GET /commits/heads/main", "GET /git/trees/:sha"])
  })

  it("asks again for a branch head with its ETag, and GitHub answers 304", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    seedHistory(2)
    const store = history()
    const first = await store.head({ ref: "published" })
    vi.setSystemTime(Date.now() + 10_000)
    expect(await store.head({ ref: "published" })).toEqual(first)
    expect(fake.notModified.map(request => request.path)).toEqual(["/repos/onmax/repo/commits/heads/main"])
    // A moved branch is a new answer.
    fake.commit("main", { "docs/new.md": "new\n" })
    vi.setSystemTime(Date.now() + 10_000)
    expect((await store.head({ ref: "published" }))?.id).toBe(fake.head("main"))
    expect(fake.notModified).toHaveLength(1)
  })

  it.each([false, true])("keeps answers for a commit sha in KV, so another server instance sends no request for them, ancestor: %s", async (ancestor) => {
    seedHistory(3)
    const kv = memoryKV()
    registerWorkspaceKV(kv)
    const head = fake.head("main")!
    if (ancestor) fake.commit("main", { "docs/new.md": "new\n" })
    const first = history()
    // Content opens the head that head() returned, so the ref of the commit is known.
    await first.head({ ref: "published" })
    const files = ancestor ? [] : await (await first.open(head)).list("", { recursive: true })
    await first.list({ ref: "published", cursor: `published:after:${head}` })
    expect(kv.values.size).toBeGreaterThan(0)
    const before = readGitHubReadStats()
    fake.requests.length = 0
    const second = history()
    await second.head({ ref: "published" })
    fake.requests.length = 0
    if (!ancestor) expect(await (await second.open(head)).list("", { recursive: true })).toEqual(files)
    await second.list({ ref: "published", cursor: `published:after:${head}` })
    expect(shapes()).toEqual([])
    // The page of revisions, plus the tree for a head cursor or the ancestry proof for an older cursor.
    expect(readGitHubReadStats().kv - before.kv).toBe(2)
  })

  it("reads many files of one commit from one archive, and few files one by one", async () => {
    const files: Record<string, string> = {}
    for (let index = 0; index < 20; index++) files[`docs/page-${index}.md`] = `# Page ${index}\n`
    fake.commit("main", files)
    const store = history()
    const view = await store.open(fake.head("main")!)
    await view.preload!(Object.keys(files))
    for (const path of Object.keys(files)) expect(await view.readFile(path)).toBe(files[path])
    expect(shapes().filter(shape => shape.startsWith("GET /git/blobs/"))).toEqual([])
    expect(shapes().filter(shape => shape.startsWith("GET /tarball/"))).toHaveLength(1)

    fake.commit("main", { "docs/one.md": "one\n", "docs/two.md": "two\n" })
    fake.requests.length = 0
    const next = await store.open(fake.head("main")!)
    await next.preload!(["docs/one.md", "docs/two.md", "docs/page-1.md"])
    expect(shapes().filter(shape => shape.startsWith("GET /tarball/"))).toEqual([])
    expect(await next.readFile("docs/one.md")).toBe("one\n")
  })
})
