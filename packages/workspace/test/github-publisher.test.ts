import { createHash } from "node:crypto"

import { createFakeGitHub, fakeSha } from "./fake-github.ts"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createWorkspace } from "../src/core/workspace.ts"
import { github } from "../src/publish.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"
import { workspaceStoreTarget } from "../src/storage/target.ts"
import { createCurrentSnapshotFromStore } from "../src/storage/utils.ts"

const requests: Array<{ body?: Record<string, unknown>; headers: Headers; method: string; operation?: string; path: string }> = []
let fake: ReturnType<typeof createFakeGitHub>
let remoteTree: Array<{ path: string, sha: string, type: "blob" }> = []
let externalTreeSynced = false
let mirrorRefStatus = 404
let malformedResponsePath: string | undefined
let malformedResponse: unknown

function gitBlobSha(bytes: Uint8Array): string {
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex")
}

function textSha(content: string): string {
  return gitBlobSha(new TextEncoder().encode(content))
}

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" }, status: 200 })
}

beforeEach(() => {
  requests.length = 0
  fake = createFakeGitHub()
  fake.respond(request => request.path === malformedResponsePath ? jsonResponse(malformedResponse) : undefined)
  fake.respond(request => request.path === "/repos/onmax/repo/commits/heads/mirror" && mirrorRefStatus !== 404 && fake.head("mirror") === undefined
    ? new Response("missing mirror branch", { status: mirrorRefStatus, statusText: "Internal Server Error" })
    : undefined)
  remoteTree = []
  externalTreeSynced = false
  mirrorRefStatus = 404
  malformedResponsePath = undefined
  malformedResponse = undefined
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    if (!externalTreeSynced) {
      fake.setBranch("main", fakeSha("base-sha"), remoteTree.map(entry => ({ ...entry, mode: "100644", size: 0 })))
      externalTreeSynced = true
    }
    // The fake records the request before its first await, so the index belongs to this call when requests run in parallel.
    const index = fake.requests.length
    const pending = fake.fetch(input, init)
    const request = fake.requests[index]
    if (request) requests.push(request)
    return await pending
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("GitHub workspace publisher", () => {
  it.each(["onmax/repo\\..\\other", "onmax/..", "onmax/%2e%2e"]) (
    "rejects unsafe repository %j before making GitHub requests",
    async repository => {
      const workspace = createWorkspace({
        name: "docs",
        store: { provider: "memory" },
        publish: [github({ branch: "main", repository, token: "token" })],
      })
      await workspace.writeFile("file.md", "content")
      await expect(workspace.snapshot({ name: "publish" })).rejects.toThrow(
        "GitHub workspace publisher requires a repository in owner/repo format",
      )
      expect(requests).toEqual([])
    },
  )

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

    expect(requests.map(request => request.path)).toContain("/repos/onmax/repo/commits/heads/feature/audio")
    expect(fake.commitInputs()[0]).toMatchObject({
      branch: { branchName: "feature/audio", repositoryNameWithOwner: "onmax/repo" },
      expectedHeadOid: fakeSha("base-sha"),
      fileChanges: { additions: [{ path: "workspace/root/inbox/audio.md", contents: Buffer.from("hola").toString("base64") }] },
      message: { headline: "chore: transcribe audio" },
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
      "/repos/onmax/repo/commits/heads/mirror",
      "/repos/onmax/repo",
      "/repos/onmax/repo/commits/heads/main",
      "/repos/onmax/repo/git/refs",
      "/graphql",
    ]))
    expect(fake.commitInputs()[0]).toMatchObject({
      branch: { branchName: "mirror" },
      expectedHeadOid: fakeSha("base-sha"),
      message: { headline: "first publish" },
    })

    requests.length = 0
    await workspace.writeFile("inbox/second.md", "second")
    await workspace.snapshot({ name: "second publish" })

    expect(fake.commitInputs().at(-1)).toMatchObject({
      branch: { branchName: "mirror" },
      expectedHeadOid: fakeSha("commit-sha-1"),
      message: { headline: "second publish" },
    })
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
    await expect(workspace.snapshot()).rejects.toMatchObject({
      code: "WORKSPACE_FAILED",
      message: expect.stringContaining("[vitehub] GitHub workspace request failed for onmax/repo"),
    })
    expect(requests.map(request => request.path)).toEqual(Array.from(
      { length: 3 },
      () => "/repos/onmax/repo/commits/heads/mirror",
    ))
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

    expect(fake.commitInputs().at(-1)?.fileChanges.deletions).toEqual([{ path: "workspace/root/inbox/audio.md" }])
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

    expect(fake.commitInputs()[0]?.fileChanges.deletions).toEqual([{ path: "workspace/root/inbox/audio.md" }])
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

    expect(fake.commitInputs()[0]?.fileChanges.additions).toEqual([{ path: "workspace/root/inbox/audio.md", contents: Buffer.from("hola").toString("base64") }])
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

    expect(fake.commitInputs()).toEqual([])
    expect(requests.filter(request => request.method !== "GET" && request.operation !== "RepositoryId")).toEqual([])
  })

  it.each([undefined, null, ""])("rejects a content response with SHA %j before publishing", async (sha) => {
    malformedResponsePath = `/repos/onmax/repo/git/trees/${fakeSha("base-sha")}`
    malformedResponse = { tree: [{ path: "workspace/root/file.md", sha, type: "blob" }] }
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
    await workspace.writeFile("file.md", "content")

    await expect(workspace.snapshot()).rejects.toMatchObject({
      code: "WORKSPACE_FAILED",
      message: expect.stringContaining("GitHub workspace returned a malformed tree response."),
    })
    expect(requests.filter(request => request.method !== "GET" && request.operation !== "RepositoryId")).toEqual([])
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

    expect(requests.filter(request => request.method !== "GET" && request.operation !== "RepositoryId")).toEqual([])
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

    expect(requests.filter(request => request.method !== "GET" && request.operation !== "RepositoryId")).toEqual([])
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

    expect(requests.filter(request => request.method !== "GET" && request.operation !== "RepositoryId")).toEqual([])
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
    expect(requests.filter(request => request.method !== "GET" && request.operation !== "RepositoryId")).toEqual([])
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
    expect(requests.filter(request => request.method !== "GET" && request.operation !== "RepositoryId")).toEqual([])
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

    expect(requests.filter(request => request.method !== "GET" && request.operation !== "RepositoryId")).toEqual([])
  })
})
