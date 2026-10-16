import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createGitHubWorkspaceStore } from "../src/providers/github/store.ts"

const root = ".vitehub/workspaces/docs"
const requests: string[] = []

const commits = {
  c1: {
    sha: "c1",
    html_url: "https://github.com/onmax/repo/commit/c1",
    commit: {
      message: "Initial files",
      author: { name: "Ada Lovelace", email: "ada@example.com", date: "2026-10-15T08:00:00Z" },
      committer: { name: "Ada Lovelace", email: "ada@example.com", date: "2026-10-15T08:00:00Z" },
      tree: { sha: "t1" },
    },
    parents: [],
  },
  c2: {
    sha: "c2",
    html_url: "https://github.com/onmax/repo/commit/c2",
    commit: {
      message: "Update guide",
      author: { name: "Grace Hopper", email: "grace@example.com", date: "2026-10-15T09:00:00Z" },
      committer: { name: "Grace Hopper", email: "grace@example.com", date: "2026-10-15T09:00:00Z" },
      tree: { sha: "t2" },
    },
    parents: [{ sha: "c1" }],
  },
  c3: {
    sha: "c3",
    html_url: "https://github.com/onmax/repo/commit/c3",
    commit: {
      message: "Draft guide",
      author: { name: "Katherine Johnson", date: "2026-10-15T10:00:00Z" },
      committer: { name: "Katherine Johnson", date: "2026-10-15T10:00:00Z" },
      tree: { sha: "t3" },
    },
    parents: [{ sha: "c1" }],
  },
} as const

const trees = {
  t1: [
    { path: `${root}/guide.md`, type: "blob", sha: "b-guide-1", size: 6 },
    { path: `${root}/image.bin`, type: "blob", sha: "b-image", size: 2 },
    { path: `${root}/.git/config`, type: "blob", sha: "b-private", size: 1 },
  ],
  t2: [
    { path: `${root}/guide.md`, type: "blob", sha: "b-guide-2", size: 10 },
    { path: `${root}/image.bin`, type: "blob", sha: "b-image", size: 2 },
  ],
  t3: [
    { path: `${root}/draft.md`, type: "blob", sha: "b-draft", size: 6 },
  ],
} as const

const bodies = new Map([
  ["c1/guide.md", new TextEncoder().encode("hello\n")],
  ["c1/image.bin", new Uint8Array([0, 255])],
  ["c2/guide.md", new TextEncoder().encode("updated\n\n")],
  ["c2/image.bin", new Uint8Array([0, 255])],
  ["c3/draft.md", new TextEncoder().encode("draft\n")],
])

function json(value: unknown, headers: Record<string, string> = {}) {
  return Response.json(value, { headers })
}

function requestPage(url: URL): number {
  return Number(url.searchParams.get("page") || "1")
}

beforeEach(() => {
  requests.length = 0
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    requests.push(`${url.hostname}${url.pathname}${url.search}`)
    if (url.hostname === "raw.githubusercontent.com") {
      const [, , , ref, ...path] = decodeURIComponent(url.pathname).split("/")
      const body = bodies.get(`${ref}/${path.join("/").replace(`${root}/`, "")}`)
      return body ? new Response(body) : new Response("missing", { status: 404 })
    }
    if (url.pathname.endsWith("/branches")) {
      const page = requestPage(url)
      if (page > 1) return json([])
      return json([
        { name: "feature/draft", commit: { sha: "c3" } },
        { name: "feature/api+v2", commit: { sha: "c3" } },
        { name: "main", commit: { sha: "c2" } },
      ])
    }
    if (url.pathname.includes("/git/ref/heads/")) {
      const ref = decodeURIComponent(url.pathname.split("/git/ref/heads/")[1] || "")
      const sha = ref === "main" ? "c2" : ref === "feature/draft" ? "c3" : undefined
      return sha ? json({ object: { sha } }) : new Response("missing", { status: 404 })
    }
    if (url.pathname.endsWith("/git/trees/t1") || url.pathname.endsWith("/git/trees/t2") || url.pathname.endsWith("/git/trees/t3")) {
      const tree = trees[url.pathname.split("/git/trees/")[1] as keyof typeof trees]
      return json({ tree })
    }
    if (url.pathname.endsWith("/commits")) {
      const ref = url.searchParams.get("sha")
      const page = requestPage(url)
      if (ref === "main") return page === 1
        ? json([{ sha: "c2" }], { link: '<https://api.github.com/repos/onmax/repo/commits?page=2>; rel="next"' })
        : page === 2 ? json([{ sha: "c1" }]) : json([])
      if (ref === "feature/draft") return json(page === 1 ? [{ sha: "c3" }, { sha: "c1" }] : [])
      return new Response("missing", { status: 404 })
    }
    const commitId = url.pathname.split("/commits/")[1]
    if (commitId && commits[commitId as keyof typeof commits]) return json(commits[commitId as keyof typeof commits])
    return new Response("missing", { status: 404 })
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function store() {
  return createGitHubWorkspaceStore({
    provider: "github",
    repository: "onmax/repo",
    token: "token",
    branch: "main",
    root,
  }, "docs")
}

describe("GitHub Workspace history", () => {
  it("maps branches and commits to refs and revisions with author metadata and links", async () => {
    const history = store().history!
    await expect(history.refs()).resolves.toEqual([
      {
        name: "feature/draft",
        head: expect.objectContaining({ id: "c3", ref: "feature/draft", parentId: "c1", files: 1, bytes: 6, message: "Draft guide", createdAt: "2026-10-15T10:00:00Z", metadata: { author: "Katherine Johnson", url: "https://github.com/onmax/repo/commit/c3" } }),
      },
      {
        name: "main",
        head: expect.objectContaining({ id: "c2", ref: "main", parentId: "c1", files: 2, bytes: 12, metadata: { author: "Grace Hopper", authorEmail: "grace@example.com", url: "https://github.com/onmax/repo/commit/c2" } }),
      },
    ])
    await expect(history.head({ ref: "main" })).resolves.toMatchObject({ id: "c2", ref: "main" })
  })

  it("pages one branch and opens immutable text and binary content", async () => {
    const history = store().history!
    const first = await history.list({ ref: "main", limit: 1 })
    expect(first.revisions).toHaveLength(1)
    expect(first.revisions[0]).toMatchObject({ id: "c2", parentId: "c1" })
    expect(first.cursor).toBe("main:2")
    await expect(history.list({ ref: "feature/draft", cursor: first.cursor, limit: 1 })).rejects.toMatchObject({ code: "WORKSPACE_R0070" })
    await expect(history.list({ ref: "main", cursor: first.cursor, limit: 1 })).resolves.toMatchObject({ revisions: [{ id: "c1" }] })

    const view = await history.open("c2")
    await expect(view.readFile("guide.md")).resolves.toBe("updated\n\n")
    await expect(view.readFile("image.bin", { encoding: "binary" })).resolves.toEqual(new Uint8Array([0, 255]))
    await expect(view.list()).resolves.toEqual([
      expect.objectContaining({ path: "guide.md", type: "file", size: 10, mediaType: "text/markdown" }),
      expect.objectContaining({ path: "image.bin", type: "file", size: 2, mediaType: "application/octet-stream" }),
    ])
    await expect(view.stat("guide.md")).resolves.toMatchObject({ revision: "c2", size: 10 })
    expect(requests.some(path => path.includes("raw.githubusercontent.com/onmax/repo/c2/.vitehub/workspaces/docs/guide.md"))).toBe(true)
  })

  it("reports empty history for a repository without branches", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("empty", { status: 409 })))
    const history = store().history!
    await expect(history.refs()).resolves.toEqual([])
    await expect(history.head()).resolves.toBeNull()
    await expect(history.list()).resolves.toEqual({ revisions: [] })
    await expect(history.usage()).resolves.toEqual({ bytes: 0, objects: 0 })
  })

  it("surfaces malformed GitHub history responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ tree: [{ path: "missing-sha", type: "blob" }] })))
    await expect(store().history!.open("bad")).rejects.toThrow("malformed commit")
  })
})
