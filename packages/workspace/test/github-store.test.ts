import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createGitHubWorkspaceStore } from "../src/storage/github.ts"

const requests: Array<{ body?: unknown, method: string, path: string }> = []

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status: 200,
  })
}

beforeEach(() => {
  requests.length = 0
  let blobIndex = 0
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const method = init.method || "GET"
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined
    requests.push({ body, method, path: url.pathname })

    if (url.pathname === "/repos/onmax/repo/git/ref/heads/feature/audio") return jsonResponse({ object: { sha: "base-sha" } })
    if (url.pathname === "/repos/onmax/repo/git/commits/base-sha") return jsonResponse({ tree: { sha: "base-tree" } })
    if (url.pathname === "/repos/onmax/repo/git/blobs" && method === "POST") return jsonResponse({ sha: `blob-${++blobIndex}` })
    if (url.pathname === "/repos/onmax/repo/git/trees" && method === "POST") return jsonResponse({ sha: "tree-sha" })
    if (url.pathname === "/repos/onmax/repo/git/commits" && method === "POST") return jsonResponse({ sha: "commit-sha" })
    if (url.pathname === "/repos/onmax/repo/git/refs/heads/feature/audio" && method === "PATCH") return jsonResponse({})

    return new Response("not found", { status: 404 })
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("GitHub workspace store", () => {
  it("publishes pending workspace files as a GitHub commit snapshot", async () => {
    const store = createGitHubWorkspaceStore({
      branch: () => "feature/audio",
      repo: () => "onmax/repo",
      root: () => "workspace/root",
      token: () => "token",
    })

    await store.writeFile("inbox/audio.md", { content: "hola", path: "inbox/audio.md", mediaType: "text/markdown" })

    const snapshot = await store.snapshot({ name: "chore: transcribe audio" })

    expect(snapshot).toMatchObject({
      files: ["workspace/root/inbox/audio.md"],
      id: "commit-sha",
      sha: "commit-sha",
      url: "https://github.com/onmax/repo/commit/commit-sha",
    })
    expect(requests.map(request => request.path)).toContain("/repos/onmax/repo/git/ref/heads/feature/audio")
    expect(requests.map(request => request.path)).not.toContain("/repos/onmax/repo/git/ref/heads/feature%2Faudio")
    expect(requests.find(request => request.path.endsWith("/git/trees"))?.body).toMatchObject({
      base_tree: "base-tree",
      tree: [{ mode: "100644", path: "workspace/root/inbox/audio.md", sha: "blob-1", type: "blob" }],
    })
    expect(requests.find(request => request.path.endsWith("/git/commits"))?.body).toMatchObject({
      message: "chore: transcribe audio",
      parents: ["base-sha"],
      tree: "tree-sha",
    })
  })

  it("requires at least one pending file before publishing a snapshot", async () => {
    const store = createGitHubWorkspaceStore({
      branch: "main",
      repo: "onmax/repo",
      root: "workspace/root",
      token: "token",
    })

    await expect(store.snapshot()).rejects.toThrow("cannot publish an empty snapshot")
    expect(requests).toEqual([])
  })
})
