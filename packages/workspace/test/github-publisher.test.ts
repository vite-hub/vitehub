import { createHash } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createWorkspace } from "../src/core/workspace.ts"
import { github } from "../src/publish.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"
import { workspaceStoreTarget } from "../src/storage/target.ts"
import { createCurrentSnapshotFromStore } from "../src/storage/utils.ts"

const requests: Array<{ body?: unknown, headers: Headers, method: string, path: string }> = []
let refSha = "base-sha"
let remoteTreeSha = "base-tree"
let remoteTree: Array<{ path: string, sha: string, type: "blob" }> = []
let commitIndex = 0
let treeIndex = 0
let mirrorRefSha: string | undefined
let mirrorRefStatus = 404

function gitBlobSha(bytes: Uint8Array): string {
  return createHash("sha1")
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex")
}

function textSha(content: string): string {
  return gitBlobSha(new TextEncoder().encode(content))
}

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status: 200,
  })
}

beforeEach(() => {
  requests.length = 0
  refSha = "base-sha"
  remoteTreeSha = "base-tree"
  remoteTree = []
  commitIndex = 0
  treeIndex = 0
  mirrorRefSha = undefined
  mirrorRefStatus = 404
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const method = init.method || "GET"
    const body = typeof init.body === "string" ? JSON.parse(init.body) as {
      content?: string
      force?: boolean
      ref?: string
      sha?: string | null
      tree?: Array<{ path: string, sha: string | null, type: "blob" }>
    } : undefined
    requests.push({ body, headers: new Headers(init.headers), method, path: url.pathname })

    if (url.pathname === "/repos/onmax/repo/git/ref/heads/mirror") {
      if (mirrorRefSha) return jsonResponse({ object: { sha: mirrorRefSha } })
      return new Response("missing mirror branch", {
        status: mirrorRefStatus,
        statusText: mirrorRefStatus === 404 ? "Not Found" : "Internal Server Error",
      })
    }
    if (url.pathname === "/repos/onmax/repo") return jsonResponse({ default_branch: "main" })
    if (url.pathname === "/repos/onmax/repo/git/ref/heads/main") return jsonResponse({ object: { sha: refSha } })
    if (url.pathname === "/repos/onmax/repo/git/ref/heads/feature/audio") return jsonResponse({ object: { sha: refSha } })
    if (url.pathname.startsWith("/repos/onmax/repo/git/commits/")) return jsonResponse({ tree: { sha: remoteTreeSha } })
    if (url.pathname.startsWith("/repos/onmax/repo/contents/")) {
      const path = decodeURIComponent(url.pathname.slice("/repos/onmax/repo/contents/".length))
      const entry = remoteTree.find(item => item.path === path)
      return entry
        ? jsonResponse({ ...entry, type: "file" })
        : new Response("missing file", { status: 404, statusText: "Not Found" })
    }
    if (url.pathname === "/repos/onmax/repo/git/trees/base-tree" && method === "GET") return jsonResponse({ tree: remoteTree })
    if (url.pathname.startsWith("/repos/onmax/repo/git/trees/tree-sha-") && method === "GET") return jsonResponse({ tree: remoteTree })
    if (url.pathname === "/repos/onmax/repo/git/blobs" && method === "POST" && body?.content) {
      return jsonResponse({ sha: gitBlobSha(Buffer.from(body.content, "base64")) })
    }
    if (url.pathname === "/repos/onmax/repo/git/trees" && method === "POST") {
      for (const entry of body?.tree || []) {
        remoteTree = remoteTree.filter(item => item.path !== entry.path)
        if (entry.sha) remoteTree.push({ path: entry.path, sha: entry.sha, type: "blob" })
      }
      remoteTreeSha = `tree-sha-${++treeIndex}`
      return jsonResponse({ sha: remoteTreeSha })
    }
    if (url.pathname === "/repos/onmax/repo/git/commits" && method === "POST") return jsonResponse({ sha: `commit-sha-${++commitIndex}` })
    if (url.pathname === "/repos/onmax/repo/git/refs" && method === "POST") {
      if (body?.ref === "refs/heads/mirror" && body.sha) mirrorRefSha = body.sha
      return jsonResponse({})
    }
    if (url.pathname === "/repos/onmax/repo/git/refs/heads/mirror" && method === "PATCH") {
      if (body?.sha) mirrorRefSha = body.sha
      return jsonResponse({})
    }
    if (url.pathname === "/repos/onmax/repo/git/refs/heads/feature/audio" && method === "PATCH") {
      if (body?.sha) refSha = body.sha
      return jsonResponse({})
    }

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

    const audioSha = textSha("hola")
    expect(requests.map(request => request.path)).toContain("/repos/onmax/repo/git/ref/heads/feature/audio")
    expect(requests.map(request => request.path)).not.toContain("/repos/onmax/repo/git/ref/heads/feature%2Faudio")
    expect(requests.find(request => request.path.endsWith("/git/trees"))?.body).toMatchObject({
      base_tree: "base-tree",
      tree: [{ mode: "100644", path: "workspace/root/inbox/audio.md", sha: audioSha, type: "blob" }],
    })
    expect(requests.find(request => request.path.endsWith("/git/commits"))?.body).toMatchObject({
      message: "chore: transcribe audio",
      parents: ["base-sha"],
      tree: "tree-sha-1",
    })
    expect(requests.every(request => request.headers.get("user-agent") === "vitehub-workspace")).toBe(true)
  })

  it("creates a missing branch from the default branch before using non-forced updates", async () => {
    const workspace = createWorkspace({
      name: "docs",
      store: { provider: "memory" },
      publish: [github({
        branch: "mirror",
        repository: "onmax/repo",
        root: "workspace/root",
        token: "token",
      })],
    })

    await workspace.writeFile("inbox/first.md", "first")
    await workspace.snapshot({ name: "first publish" })

    expect(requests.map(request => request.path)).toEqual(expect.arrayContaining([
      "/repos/onmax/repo/git/ref/heads/mirror",
      "/repos/onmax/repo",
      "/repos/onmax/repo/git/ref/heads/main",
    ]))
    expect(requests.find(request => request.path.endsWith("/git/trees") && request.method === "POST")?.body)
      .toMatchObject({ base_tree: "base-tree" })
    expect(requests.find(request => request.path.endsWith("/git/commits") && request.method === "POST")?.body)
      .toMatchObject({ parents: ["base-sha"] })
    expect(requests.find(request => request.path === "/repos/onmax/repo/git/refs" && request.method === "POST")?.body)
      .toEqual({ ref: "refs/heads/mirror", sha: "commit-sha-1" })
    expect(requests.some(request => request.method === "PATCH")).toBe(false)

    requests.length = 0
    await workspace.writeFile("inbox/second.md", "second")
    await workspace.snapshot({ name: "second publish" })

    expect(requests.find(request => request.path.endsWith("/git/refs/heads/mirror") && request.method === "PATCH")?.body)
      .toEqual({ force: false, sha: "commit-sha-2" })
    expect(requests.some(request => request.path === "/repos/onmax/repo/git/refs" && request.method === "POST")).toBe(false)
  })

  it("does not treat non-404 branch failures as missing", async () => {
    mirrorRefStatus = 500
    const workspace = createWorkspace({
      name: "docs",
      store: { provider: "memory" },
      publish: [github({
        branch: "mirror",
        repository: "onmax/repo",
        token: "token",
      })],
    })

    await workspace.writeFile("inbox/first.md", "first")
    await expect(workspace.snapshot()).rejects.toThrow("500 Internal Server Error")
    expect(requests.map(request => request.path)).toEqual([
      "/repos/onmax/repo/git/ref/heads/mirror",
    ])
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
      base_tree: "tree-sha-1",
      tree: [{ mode: "100644", path: "workspace/root/inbox/audio.md", sha: null, type: "blob" }],
    })
  })

  it("publishes deletions from the remote tree without local publisher state", async () => {
    remoteTree = [{ path: "workspace/root/inbox/audio.md", sha: textSha("hola"), type: "blob" }]

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

    await workspace.snapshot({ name: "delete remote audio" })

    expect(requests.find(request => request.path.endsWith("/git/trees"))?.body).toMatchObject({
      base_tree: "base-tree",
      tree: [{ mode: "100644", path: "workspace/root/inbox/audio.md", sha: null, type: "blob" }],
    })
  })

  it("preserves remote-only files when untracked deletion is disabled", async () => {
    remoteTree = [
      { path: "workspace/root/assets/audio.mp3", sha: textSha("asset"), type: "blob" },
      { path: "workspace/root/inbox/audio.md", sha: textSha("old"), type: "blob" },
    ]

    const workspace = createWorkspace({
      name: "docs",
      store: { provider: "memory" },
      publish: [github({
        branch: "feature/audio",
        deleteUntracked: false,
        repo: "onmax/repo",
        root: "workspace/root",
        token: "token",
      })],
    })

    await workspace.writeFile("inbox/audio.md", "hola", { mediaType: "text/markdown" })
    await workspace.snapshot({ name: "update transcript" })

    expect(requests.find(request => request.path.endsWith("/git/trees"))?.body).toMatchObject({
      base_tree: "base-tree",
      tree: [{
        mode: "100644",
        path: "workspace/root/inbox/audio.md",
        sha: textSha("hola"),
        type: "blob",
      }],
    })
  })

  it("checks only workspace paths when untracked deletion is disabled", async () => {
    remoteTree = [{ path: "workspace/root/inbox/audio.md", sha: textSha("hola"), type: "blob" }]

    const workspace = createWorkspace({
      name: "docs",
      store: { provider: "memory" },
      publish: [github({
        branch: "feature/audio",
        deleteUntracked: false,
        repo: "onmax/repo",
        root: "workspace/root",
        token: "token",
      })],
    })

    await workspace.writeFile("inbox/audio.md", "hola", { mediaType: "text/markdown" })
    await workspace.snapshot()

    const contentsRequest = requests.find(request => request.path === "/repos/onmax/repo/contents/workspace/root/inbox/audio.md")
    expect(contentsRequest?.headers.get("accept")).toBe("application/vnd.github.object+json")
    expect(requests.some(request => request.path.endsWith("/git/trees/base-tree"))).toBe(false)
    expect(requests.filter(request => request.method !== "GET")).toEqual([])
  })

  it("skips publishing when deletion is disabled and only remote files are untracked", async () => {
    remoteTree = [{ path: "workspace/root/assets/audio.mp3", sha: textSha("asset"), type: "blob" }]

    const workspace = createWorkspace({
      name: "docs",
      store: { provider: "memory" },
      publish: [github({
        branch: "feature/audio",
        deleteUntracked: false,
        repo: "onmax/repo",
        root: "workspace/root",
        token: "token",
      })],
    })

    await workspace.snapshot()

    expect(requests.filter(request => request.method !== "GET")).toEqual([])
  })

  it("skips unchanged snapshots after comparing the remote tree", async () => {
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

    await workspace.snapshot({ name: "unchanged" })

    expect(requests.filter(request => request.method !== "GET")).toEqual([])
  })

  it("keeps direct publication content-addressed", async () => {
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
    await workspace.publish({ name: "initial publish" })
    requests.length = 0

    await workspace.publish({ name: "unchanged publish" })

    expect(requests.filter(request => request.method !== "GET")).toEqual([])
  })

  it("rejects direct publication to the active GitHub Store branch", async () => {
    const workspace = createWorkspace({
      name: "docs",
      store: {
        provider: "github",
        branch: "feature/audio",
        repository: "onmax/repo",
        root: "workspace/store",
        token: "token",
      },
      publish: [github({
        branch: "feature/audio",
        repository: "onmax/repo",
        root: "workspace/publisher",
        token: "token",
      })],
    })

    await expect(workspace.snapshot()).resolves.toMatchObject({ id: expect.any(String) })
    await expect(workspace.publish()).rejects.toThrow(
      "GitHub publisher cannot publish to onmax/repo@feature/audio while it backs the active GitHub Workspace Store",
    )
    expect(requests.filter(request => request.method !== "GET")).toEqual([])
  })

  it("uses the loaded GitHub Store target when dynamic options change", async () => {
    let storeBranch = "feature/audio"
    const workspace = createWorkspace({
      name: "docs",
      store: {
        provider: "github",
        branch: () => storeBranch,
        repository: "onmax/repo",
        token: "token",
      },
      publish: [github({
        branch: "feature/audio",
        repository: "onmax/repo",
        token: "token",
      })],
    })

    storeBranch = "other"

    await expect(workspace.publish()).rejects.toThrow(
      "GitHub publisher cannot publish to onmax/repo@feature/audio while it backs the active GitHub Workspace Store",
    )
    expect(requests.filter(request => request.method !== "GET")).toEqual([])
  })

  it("does not fall back to GitHub config when the live Store uses another provider", async () => {
    const store = createMemoryWorkspaceStore() as ReturnType<typeof createMemoryWorkspaceStore> & {
      [workspaceStoreTarget]: () => { provider: string }
    }
    store[workspaceStoreTarget] = () => ({ provider: "custom" })
    const publisher = github({
      branch: "feature/audio",
      repository: "onmax/repo",
      token: "token",
    })

    await expect(publisher.publish({
      durable: false,
      rootDir: process.cwd(),
      snapshot: await createCurrentSnapshotFromStore(store),
      store,
      workspace: {
        name: "docs",
        store: {
          provider: "github",
          branch: "feature/audio",
          repository: "onmax/repo",
          token: "token",
        },
      },
    })).resolves.toBeUndefined()
  })

  it("skips empty snapshots with no remote files", async () => {
    const workspace = createWorkspace({
      name: "docs",
      store: { provider: "memory" },
      publish: [github({
        branch: "mirror",
        repo: "onmax/repo",
        root: "workspace/root",
        token: "token",
      })],
    })

    await workspace.snapshot()

    expect(requests.filter(request => request.method !== "GET")).toEqual([])
  })
})
