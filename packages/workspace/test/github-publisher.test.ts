import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createWorkspace } from "../src/core/workspace.ts"
import { github } from "../src/publish.ts"

const requests: Array<{ body?: unknown, headers: Headers, method: string, path: string }> = []

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
    requests.push({ body, headers: new Headers(init.headers), method, path: url.pathname })

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

describe("GitHub workspace publisher", () => {
  it("publishes workspace snapshots as GitHub commits", async () => {
    const workspace = createWorkspace({
      name: "docs",
      store: { provider: "memory" },
      publish: [github({
        branch: () => "feature/audio",
        repo: () => "onmax/repo",
        root: () => "workspace/root",
        token: () => "token",
      })],
    })

    await workspace.writeFile("inbox/audio.md", "hola", { mediaType: "text/markdown" })

    await workspace.snapshot({ name: "chore: transcribe audio" })

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
    expect(requests.every(request => request.headers.get("user-agent") === "vitehub-workspace")).toBe(true)
  })

  it("publishes delete-only snapshots after the last workspace file is removed", async () => {
    const workspace = createWorkspace({
      name: "docs",
      store: { provider: "memory" },
      publish: [github({
        branch: "feature/audio",
        repo: "onmax/repo",
        root: "workspace/root",
        token: "token",
      })],
    })

    await workspace.writeFile("inbox/audio.md", "hola", { mediaType: "text/markdown" })
    await workspace.snapshot({ name: "baseline" })
    requests.length = 0

    await workspace.rm("inbox/audio.md")
    await workspace.snapshot({ name: "delete audio" })

    expect(requests.map(request => request.path)).not.toContain("/repos/onmax/repo/git/blobs")
    expect(requests.find(request => request.path.endsWith("/git/trees"))?.body).toMatchObject({
      base_tree: "base-tree",
      tree: [{ path: "workspace/root/inbox/audio.md", sha: null }],
    })
  })

  it("skips empty snapshots with no previously published files", async () => {
    const workspace = createWorkspace({
      name: "docs",
      store: { provider: "memory" },
      publish: [github({
        branch: "feature/audio",
        repo: "onmax/repo",
        root: "workspace/root",
        token: "token",
      })],
    })

    await workspace.snapshot()

    expect(requests).toEqual([])
  })
})
