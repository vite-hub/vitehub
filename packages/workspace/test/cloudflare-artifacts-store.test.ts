import { afterEach, describe, expect, it, vi } from "vitest"

import { clearActiveCloudflareEnv, setActiveCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"
import { defineWorkspace } from "../src/index.ts"
import { resetWorkspaceRegistry, setWorkspaceRegistry } from "../src/core/registry.ts"
import { resetWorkspaceStoreCache } from "../src/core/workspace-cache.ts"
import { setWorkspaceHostedStoreLoader } from "../src/runtime/hosted-store-loader.ts"
import { setWorkspaceRuntimeConfig } from "../src/runtime/config.ts"

const gitMock = vi.hoisted(() => ({
  add: vi.fn(async () => {}),
  clone: vi.fn(async (_options?: unknown): Promise<void> => {
    throw new Error("empty remote")
  }),
  commit: vi.fn(async () => "commit-1"),
  init: vi.fn(async () => {}),
  push: vi.fn(async (_options?: unknown) => ({ refs: { main: "commit-1" } })),
  remove: vi.fn(async () => {}),
  resolveRef: vi.fn(async () => "remote-sha"),
  statusMatrix: vi.fn(async ({ fs }: { fs: { entries: Map<string, { kind: "file" | "dir" }> }, ignored?: boolean }) => [...fs.entries]
    .filter(([path, entry]) => path.startsWith("/workspace/") && entry.kind === "file")
    .map(([path]) => [path.slice("/workspace/".length), 0, 2, 0])),
}))

vi.mock("isomorphic-git", () => gitMock)
vi.mock("isomorphic-git/http/web", () => ({}))

const remote = "https://account.artifacts.cloudflare.net/git/vitehub/vitehub-workspace-docs.git"

function expiresIn(milliseconds: number) {
  return new Date(Date.now() + milliseconds).toISOString()
}

function artifactsError(code: number, message: string) {
  return Object.assign(new Error(message), { code })
}

function artifactsRepo(options: { defaultBranch?: string, lastPushAt?: string | null, source?: string | null, token?: string } = {}) {
  return {
    createToken: vi.fn(async () => ({
      expiresAt: expiresIn(3_600_000),
      plaintext: options.token || "art_v1_fresh?expires=999",
    })),
    defaultBranch: options.defaultBranch || "main",
    lastPushAt: options.lastPushAt ?? null,
    name: "vitehub-workspace-docs",
    remote,
    source: options.source ?? null,
  }
}

function createdRepo(token = `art_v1_created?expires=${Math.floor((Date.now() + 3_600_000) / 1000)}`) {
  return {
    defaultBranch: "main",
    name: "vitehub-workspace-docs",
    remote,
    token,
  }
}

async function createStore(binding: unknown) {
  setActiveCloudflareEnv({ WORKSPACE_ARTIFACTS: binding })
  const { createCloudflareArtifactsWorkspaceStore } = await import("../src/providers/cloudflare/artifacts-store.ts")
  return createCloudflareArtifactsWorkspaceStore({
    binding: "WORKSPACE_ARTIFACTS",
    namespace: "vitehub",
    provider: "cloudflare-artifacts",
  }, "docs")
}

afterEach(() => {
  clearActiveCloudflareEnv()
  vi.unstubAllGlobals()
  resetWorkspaceRegistry()
  resetWorkspaceStoreCache()
  setWorkspaceHostedStoreLoader(undefined)
  setWorkspaceRuntimeConfig(false)
  gitMock.add.mockClear()
  gitMock.clone.mockClear()
  gitMock.commit.mockClear()
  gitMock.init.mockClear()
  gitMock.push.mockClear()
  gitMock.remove.mockClear()
  gitMock.resolveRef.mockClear()
  gitMock.statusMatrix.mockClear()
})

describe("Cloudflare Artifacts workspace store", () => {
  it("uses the Artifacts binding and commits snapshots", async () => {
    const repo = artifactsRepo()
    const binding = {
      create: vi.fn(async () => createdRepo()),
      get: vi.fn()
        .mockRejectedValueOnce(artifactsError(10200, "missing"))
        .mockResolvedValueOnce(repo),
    }

    const store = await createStore(binding)

    await store.writeFile("README.md", { path: "README.md", content: "hello" })
    expect(await store.readFile("README.md")).toMatchObject({ path: "README.md" })
    const snapshot = await store.snapshot({ name: "baseline" })
    await store.writeFile("README.md", { path: "README.md", content: "changed" })

    expect(snapshot.id).toBe("commit-1")
    expect(binding.create).toHaveBeenCalledWith("vitehub-workspace-docs", expect.objectContaining({
      setDefaultBranch: "main",
    }))
    expect(binding.get).toHaveBeenCalledTimes(2)
    expect(gitMock.clone).not.toHaveBeenCalled()
    expect(gitMock.init).toHaveBeenCalledOnce()
    expect(gitMock.push).toHaveBeenCalledWith(expect.objectContaining({
      ref: "main",
      url: repo.remote,
    }))
    expect(repo.createToken).not.toHaveBeenCalled()
    const pushOptions = gitMock.push.mock.calls[0]?.[0] as { onAuth(): { password: string } }
    expect(pushOptions.onAuth().password).toBe("art_v1_created")
    expect((await store.diff({ from: snapshot })).entries).toEqual([
      expect.objectContaining({ path: "README.md", type: "modified" }),
    ])
  })

  it("configures Cloudflare hosted Workspace runtime through public API", async () => {
    const repo = artifactsRepo()
    setActiveCloudflareEnv({
      WORKSPACE_ARTIFACTS: {
        create: vi.fn(async () => repo),
        get: vi.fn(async () => repo),
      },
    })

    const { configureCloudflareWorkspaceRuntime } = await import("../src/cloudflare.ts")
    const { useWorkspace } = await import("../src/runtime.ts")
    configureCloudflareWorkspaceRuntime({
      env: {
        VITEHUB_WORKSPACE_ARTIFACTS_NAMESPACE: "tasks",
      },
    })
    setWorkspaceRegistry({
      docs: async () => ({ default: defineWorkspace({}) }),
    })

    const workspace = useWorkspace("docs", { mode: "write" })
    await workspace.fs.writeFile("README.md", "hello")
    await expect(workspace.fs.readFile("README.md")).resolves.toBe("hello")
  })

  it("configures GitHub Workspace Stores through the hosted runtime", async () => {
    const requests: Array<{ headers: Headers; method: string; path: string }> = []
    setActiveCloudflareEnv({ GITHUB_TOKEN: "github-token" })
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        const method = init.method || "GET"
        requests.push({ headers: new Headers(init.headers), method, path: url.pathname })

        if (url.pathname === "/repos/onmax/repo/git/ref/heads/main") {
          return new Response(JSON.stringify({ object: { sha: "base-sha" } }), {
            headers: { "content-type": "application/json" },
          })
        }
        if (url.pathname === "/repos/onmax/repo/git/commits/base-sha") {
          return new Response(JSON.stringify({ tree: { sha: "tree-sha" } }), {
            headers: { "content-type": "application/json" },
          })
        }
        if (url.pathname === "/repos/onmax/repo/git/trees/tree-sha") {
          return new Response(JSON.stringify({
            tree: [{ path: "mirror/tasks/todo.md", sha: "blob-sha", size: 6, type: "blob" }],
          }), {
            headers: { "content-type": "application/json" },
          })
        }
        if (url.pathname === "/repos/onmax/repo/git/blobs/blob-sha") {
          return new Response("hello\n", {
            headers: { "content-type": "application/octet-stream" },
          })
        }
        return new Response("not found", { status: 404 })
      }),
    )

    const { configureHostedWorkspaceRuntime } = await import("../src/hosted.ts")
    const { useWorkspace } = await import("../src/runtime.ts")
    configureHostedWorkspaceRuntime({
      store: {
        branch: "main",
        provider: "github",
        repository: "onmax/repo",
        root: "mirror",
      },
    })
    setWorkspaceRegistry({
      mirror: async () => ({ default: defineWorkspace({}) }),
    })

    const workspace = useWorkspace("mirror")
    await expect(workspace.fs.readFile("tasks/todo.md")).resolves.toBe("hello\n")
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer github-token")
    expect(
      requests.find(request => request.path === "/repos/onmax/repo/git/blobs/blob-sha")?.headers.get("accept"),
    ).toBe("application/vnd.github.raw+json")
  })

  it("preserves explicit GitHub tokens in the Cloudflare runtime", async () => {
    const requests: Array<{ headers: Headers; method: string; path: string }> = []
    setActiveCloudflareEnv({ GITHUB_TOKEN: "fallback-token" })
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        const method = init.method || "GET"
        requests.push({ headers: new Headers(init.headers), method, path: url.pathname })

        if (url.pathname === "/repos/onmax/repo/git/ref/heads/main") {
          return new Response(JSON.stringify({ object: { sha: "base-sha" } }), {
            headers: { "content-type": "application/json" },
          })
        }
        if (url.pathname === "/repos/onmax/repo/git/commits/base-sha") {
          return new Response(JSON.stringify({ tree: { sha: "tree-sha" } }), {
            headers: { "content-type": "application/json" },
          })
        }
        if (url.pathname === "/repos/onmax/repo/git/trees/tree-sha") {
          return new Response(JSON.stringify({
            tree: [],
          }), {
            headers: { "content-type": "application/json" },
          })
        }
        return new Response("not found", { status: 404 })
      }),
    )

    const { configureCloudflareWorkspaceRuntime } = await import("../src/cloudflare.ts")
    const { useWorkspace } = await import("../src/runtime.ts")
    configureCloudflareWorkspaceRuntime({
      store: {
        branch: "main",
        provider: "github",
        repository: "onmax/repo",
        root: "mirror",
        token: "explicit-token",
      },
    })
    setWorkspaceRegistry({
      mirror: async () => ({ default: defineWorkspace({}) }),
    })

    const workspace = useWorkspace("mirror")
    await expect(workspace.fs.list("", { recursive: true })).resolves.toEqual([])
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer explicit-token")
  })

  it("rejects traversal and reserved public paths", async () => {
    const repo = artifactsRepo()
    setActiveCloudflareEnv({
      WORKSPACE_ARTIFACTS: {
        create: vi.fn(async () => repo),
        get: vi.fn(async () => repo),
      },
    })
    const { createCloudflareArtifactsWorkspaceStore } = await import("../src/providers/cloudflare/artifacts-store.ts")
    const store = createCloudflareArtifactsWorkspaceStore({
      binding: "WORKSPACE_ARTIFACTS",
      namespace: "vitehub",
      provider: "cloudflare-artifacts",
    }, "docs")

    await expect(store.writeFile("../x", { path: "../x", content: "x" })).rejects.toThrow("Workspace path escapes")
    await expect(store.writeFile(".git/config", { path: ".git/config", content: "x" })).rejects.toThrow("Workspace path escapes")
    await expect(store.readFile(".vitehub/meta/loader.json")).rejects.toThrow("Workspace path escapes")
  })

  it("requires recursive deletion for non-empty directories", async () => {
    const repo = artifactsRepo()
    setActiveCloudflareEnv({
      WORKSPACE_ARTIFACTS: {
        create: vi.fn(async () => repo),
        get: vi.fn(async () => repo),
      },
    })
    const { createCloudflareArtifactsWorkspaceStore } = await import("../src/providers/cloudflare/artifacts-store.ts")
    const store = createCloudflareArtifactsWorkspaceStore({
      binding: "WORKSPACE_ARTIFACTS",
      namespace: "vitehub",
      provider: "cloudflare-artifacts",
    }, "docs")

    await store.writeFile("nested/README.md", { path: "nested/README.md", content: "hello" })

    await expect(store.rm("nested")).rejects.toThrow("Workspace directory is not empty")
    await expect(store.readFile("nested/README.md")).resolves.toMatchObject({ path: "nested/README.md" })

    await store.rm("nested", { recursive: true })
    await expect(store.readFile("nested/README.md")).resolves.toBeUndefined()
  })

  it("propagates transient repository lookup failures without creating", async () => {
    const error = artifactsError(10400, "Artifacts unavailable")
    const binding = {
      create: vi.fn(),
      get: vi.fn(async () => {
        throw error
      }),
    }
    const store = await createStore(binding)

    await expect(store.readFile("README.md")).rejects.toBe(error)
    expect(binding.create).not.toHaveBeenCalled()
  })

  it("gets the repository created by a concurrent request", async () => {
    const repo = artifactsRepo({ lastPushAt: "2026-07-11T00:00:00.000Z" })
    const binding = {
      create: vi.fn(async () => {
        throw artifactsError(10201, "already exists")
      }),
      get: vi.fn()
        .mockRejectedValueOnce(artifactsError(10200, "missing"))
        .mockResolvedValueOnce(repo),
    }
    gitMock.clone.mockResolvedValueOnce(undefined)
    const store = await createStore(binding)

    await expect(store.readFile("README.md")).resolves.toBeUndefined()
    expect(binding.get).toHaveBeenCalledTimes(2)
    expect(gitMock.clone).toHaveBeenCalledOnce()
    expect(gitMock.init).not.toHaveBeenCalled()
  })

  it("initializes known-empty repositories but propagates clone failures for non-empty repositories", async () => {
    const empty = artifactsRepo()
    const emptyStore = await createStore({
      create: vi.fn(),
      get: vi.fn(async () => empty),
    })

    await expect(emptyStore.readFile("README.md")).resolves.toBeUndefined()
    expect(gitMock.clone).not.toHaveBeenCalled()
    expect(gitMock.init).toHaveBeenCalledOnce()

    const nonEmpty = artifactsRepo({ lastPushAt: "2026-07-11T00:00:00.000Z" })
    const cloneError = new Error("clone authentication failed")
    gitMock.clone.mockRejectedValueOnce(cloneError)
    const nonEmptyStore = await createStore({
      create: vi.fn(),
      get: vi.fn(async () => nonEmpty),
    })

    await expect(nonEmptyStore.readFile("README.md")).rejects.toBe(cloneError)
    expect(gitMock.init).toHaveBeenCalledOnce()
  })

  it("renews a short-lived creation token through the repository handle before Git auth", async () => {
    const repo = artifactsRepo({ token: "art_v1_renewed?expires=999" })
    const binding = {
      create: vi.fn(async () => createdRepo(`art_v1_expiring?expires=${Math.floor((Date.now() + 30_000) / 1000)}`)),
      get: vi.fn()
        .mockRejectedValueOnce(artifactsError(10200, "missing"))
        .mockResolvedValueOnce(repo),
    }
    const store = await createStore(binding)

    await store.writeFile("README.md", { content: "hello", path: "README.md" })
    await store.snapshot()

    expect(repo.createToken).toHaveBeenCalledWith("write", 3600)
    const pushOptions = gitMock.push.mock.calls[0]?.[0] as { onAuth(): { password: string } }
    expect(pushOptions.onAuth().password).toBe("art_v1_renewed")
  })

  it("uses the loaded branch head and repository entries as the initial baseline", async () => {
    const repo = artifactsRepo({ lastPushAt: "2026-07-11T00:00:00.000Z" })
    gitMock.resolveRef.mockResolvedValueOnce("remote-commit")
    gitMock.clone.mockImplementationOnce(async (options?: unknown) => {
      const { fs } = options as {
        fs: { promises: { writeFile(path: string, content: string): Promise<void> } }
      }
      await fs.promises.writeFile("/workspace/README.md", "remote")
    })
    const store = await createStore({
      create: vi.fn(),
      get: vi.fn(async () => repo),
    })

    await expect(store.diff()).resolves.toMatchObject({ entries: [] })
    gitMock.statusMatrix.mockResolvedValueOnce([])
    await expect(store.snapshot()).resolves.toMatchObject({ id: "remote-commit" })
    expect(gitMock.resolveRef).toHaveBeenCalledWith(expect.objectContaining({ ref: "main" }))
  })

  it("snapshots an existing repository to its default branch", async () => {
    const repo = artifactsRepo({
      defaultBranch: "trunk",
      lastPushAt: "2026-07-11T00:00:00.000Z",
    })
    gitMock.clone.mockResolvedValueOnce(undefined)
    const store = await createStore({
      create: vi.fn(),
      get: vi.fn(async () => repo),
    })

    await store.writeFile("README.md", { content: "hello", path: "README.md" })
    await store.snapshot()

    expect(gitMock.clone).toHaveBeenCalledWith(expect.objectContaining({ ref: "trunk" }))
    expect(gitMock.resolveRef).toHaveBeenCalledWith(expect.objectContaining({ ref: "trunk" }))
    expect(gitMock.push).toHaveBeenCalledWith(expect.objectContaining({ ref: "trunk" }))
  })

  it("stages Workspace files ignored by repository Git rules", async () => {
    const store = await createStore({
      create: vi.fn(),
      get: vi.fn(async () => artifactsRepo()),
    })
    await store.writeFile(".gitignore", { content: "private.txt\n", path: ".gitignore" })
    await store.writeFile("private.txt", { content: "kept", path: "private.txt" })
    gitMock.statusMatrix.mockImplementationOnce(async ({ ignored }) => ignored
      ? [["private.txt", 0, 2, 0]]
      : [])

    await store.snapshot()

    expect(gitMock.statusMatrix).toHaveBeenCalledWith(expect.objectContaining({ ignored: true }))
    expect(gitMock.add).toHaveBeenCalledWith(expect.objectContaining({ filepath: "private.txt", force: true }))
  })

  it("round-trips file media types and metadata through the committed sidecar", async () => {
    type FileEntry = { data: Uint8Array; kind: "file"; mtimeMs: number }
    let committed = new Map<string, FileEntry>()
    const emptyRepo = artifactsRepo()
    const nonEmptyRepo = artifactsRepo({ lastPushAt: "2026-07-11T00:00:00.000Z" })
    const binding = {
      create: vi.fn(async () => createdRepo()),
      get: vi.fn()
        .mockRejectedValueOnce(artifactsError(10200, "missing"))
        .mockResolvedValueOnce(emptyRepo)
        .mockResolvedValueOnce(nonEmptyRepo),
    }
    gitMock.push.mockImplementationOnce(async (options?: unknown) => {
      const { fs } = options as { fs: { entries: Map<string, FileEntry | { kind: "dir" }> } }
      committed = new Map(
        [...fs.entries]
          .filter((entry): entry is [string, FileEntry] => entry[1].kind === "file")
          .map(([path, entry]) => [path, { ...entry, data: new Uint8Array(entry.data) }]),
      )
      return { refs: { main: "commit-1" } }
    })
    gitMock.clone.mockImplementationOnce(async (options?: unknown) => {
      const { fs } = options as {
        fs: { promises: { writeFile(path: string, content: Uint8Array): Promise<void> } }
      }
      for (const [path, entry] of committed) await fs.promises.writeFile(path, entry.data)
    })

    const writer = await createStore(binding)
    await writer.writeFile("result.json", {
      content: '{"ok":true}',
      mediaType: "application/json",
      metadata: { source: "agent" },
      path: "result.json",
    })
    await writer.snapshot()

    expect(committed.has("/workspace/.vitehub/files.json")).toBe(true)
    const reader = await createStore(binding)
    await expect(reader.readFile("result.json")).resolves.toMatchObject({
      mediaType: "application/json",
      metadata: { source: "agent" },
    })
    await expect(reader.stat("result.json")).resolves.toMatchObject({
      mediaType: "application/json",
      metadata: { source: "agent" },
    })
    await expect(reader.list("", { recursive: true })).resolves.toEqual([
      expect.objectContaining({
        mediaType: "application/json",
        metadata: { source: "agent" },
        path: "result.json",
      }),
    ])
  })

  it("serializes concurrent snapshots", async () => {
    const repo = artifactsRepo()
    const store = await createStore({
      create: vi.fn(),
      get: vi.fn(async () => repo),
    })
    await store.writeFile("README.md", { content: "hello", path: "README.md" })
    gitMock.statusMatrix.mockResolvedValueOnce([["README.md", 0, 2, 0]]).mockResolvedValueOnce([])
    let releasePush!: () => void
    const pushing = new Promise<void>((resolve) => {
      releasePush = resolve
    })
    gitMock.push.mockImplementationOnce(async () => {
      await pushing
      return { refs: { main: "commit-1" } }
    })

    const first = store.snapshot()
    await vi.waitFor(() => expect(gitMock.push).toHaveBeenCalledOnce())
    const second = store.snapshot()
    await Promise.resolve()
    expect(gitMock.statusMatrix).toHaveBeenCalledOnce()
    releasePush()

    await Promise.all([first, second])
    expect(gitMock.commit).toHaveBeenCalledOnce()
    expect(gitMock.push).toHaveBeenCalledOnce()
  })

  it("keeps writes queued behind an in-flight snapshot boundary", async () => {
    const store = await createStore({
      create: vi.fn(),
      get: vi.fn(async () => artifactsRepo()),
    })
    await store.writeFile("README.md", { content: "first", path: "README.md" })
    gitMock.statusMatrix
      .mockResolvedValueOnce([["README.md", 0, 2, 0]])
      .mockResolvedValueOnce([["later.md", 0, 2, 0]])
    let releasePush!: () => void
    const pushing = new Promise<void>((resolve) => {
      releasePush = resolve
    })
    gitMock.push.mockImplementationOnce(async () => {
      await pushing
      return { refs: { main: "commit-1" } }
    })

    const firstSnapshot = store.snapshot()
    await vi.waitFor(() => expect(gitMock.push).toHaveBeenCalledOnce())
    const laterWrite = store.writeFile("later.md", { content: "later", path: "later.md" })
    releasePush()

    const baseline = await firstSnapshot
    await laterWrite
    const diff = await store.diff()
    const nextSnapshot = await store.snapshot()

    expect(baseline.entries).not.toHaveProperty("later.md")
    expect(diff).toMatchObject({
      entries: [expect.objectContaining({ path: "later.md", type: "added" })],
    })
    expect(nextSnapshot).toMatchObject({
      entries: expect.objectContaining({ "later.md": expect.any(Object) }),
    })
  })

  it("retries a pending local commit after a transient push failure", async () => {
    const repo = artifactsRepo()
    const store = await createStore({
      create: vi.fn(),
      get: vi.fn(async () => repo),
    })
    await store.writeFile("README.md", { content: "hello", path: "README.md" })
    gitMock.statusMatrix.mockResolvedValueOnce([["README.md", 0, 2, 0]]).mockResolvedValueOnce([])
    gitMock.push.mockRejectedValueOnce(new Error("network unavailable"))

    await expect(store.snapshot()).rejects.toThrow("network unavailable")
    await expect(store.snapshot()).resolves.toMatchObject({ id: "commit-1" })
    expect(gitMock.commit).toHaveBeenCalledOnce()
    expect(gitMock.push).toHaveBeenCalledTimes(2)
  })

  it("maps non-fast-forward pushes to a Workspace conflict and keeps the commit pending", async () => {
    const repo = artifactsRepo()
    const store = await createStore({
      create: vi.fn(),
      get: vi.fn(async () => repo),
    })
    await store.writeFile("README.md", { content: "hello", path: "README.md" })
    gitMock.statusMatrix.mockResolvedValueOnce([["README.md", 0, 2, 0]]).mockResolvedValueOnce([])
    const rejection = Object.assign(new Error("Push rejected because it was not a simple fast-forward"), {
      code: "PushRejectedError",
      data: { reason: "not-fast-forward" },
    })
    gitMock.push.mockRejectedValueOnce(rejection).mockRejectedValueOnce(rejection)

    await expect(store.snapshot()).rejects.toMatchObject({
      message: expect.stringContaining("changed remotely"),
      name: "WorkspaceError",
    })
    await expect(store.snapshot()).rejects.toMatchObject({ name: "WorkspaceError" })
    expect(gitMock.commit).toHaveBeenCalledOnce()
    expect(gitMock.push).toHaveBeenCalledTimes(2)
  })

  it("clones existing fork history that has not received a direct push", async () => {
    const repo = artifactsRepo({
      lastPushAt: null,
      source: "artifacts:namespace/base",
    })
    gitMock.clone.mockResolvedValueOnce(undefined)
    const store = await createStore({
      create: vi.fn(),
      get: vi.fn(async () => repo),
    })

    await expect(store.readFile("README.md")).resolves.toBeUndefined()
    expect(gitMock.clone).toHaveBeenCalledOnce()
    expect(gitMock.init).not.toHaveBeenCalled()
  })
})
