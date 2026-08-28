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
  listServerRefs: vi.fn(async () => [] as Array<{ oid: string; ref: string }>),
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

function artifactsError(code: string, numericCode: number, message: string) {
  return Object.assign(new Error(message), { code, numericCode })
}

function legacyArtifactsError(code: number, message: string) {
  return Object.assign(new Error(message), { code })
}

function disposable<T extends object>(value: T) {
  const dispose = vi.fn()
  return Object.assign(value, { [Symbol.dispose]: dispose, dispose })
}

function artifactsRepo(
  options: {
    defaultBranch?: string
    infoError?: Error
    token?: string
    tokenError?: Error
    tokenExpiresIn?: number
  } = {},
) {
  const infoResult = disposable({
    defaultBranch: options.defaultBranch || "main",
    remote,
  })
  const tokenResults: Array<
    ReturnType<typeof disposable<{ expiresAt: string; plaintext: string }>>
  > = []
  const repo = disposable({
    createToken: vi.fn(async () => {
      if (options.tokenError) throw options.tokenError
      const token = disposable({
        expiresAt: expiresIn(options.tokenExpiresIn ?? 3_600_000),
        plaintext: options.token || "art_v1_fresh?expires=999",
      })
      tokenResults.push(token)
      return token
    }),
    info: vi.fn(async () => {
      if (options.infoError) throw options.infoError
      return infoResult
    }),
  })
  return Object.assign(repo, { infoResult, tokenResults })
}

function createdRepo(
  token = `art_v1_created?expires=${Math.floor((Date.now() + 3_600_000) / 1000)}`,
) {
  return disposable({
    defaultBranch: "main",
    name: "vitehub-workspace-docs",
    remote,
    token,
  })
}

async function createStore(binding: unknown, options: { branch?: string } = {}) {
  setActiveCloudflareEnv({ WORKSPACE_ARTIFACTS: binding })
  const { createCloudflareArtifactsWorkspaceStore } = await import("../src/providers/cloudflare/artifacts-store.ts")
  return createCloudflareArtifactsWorkspaceStore({
    binding: "WORKSPACE_ARTIFACTS",
    namespace: "vitehub",
    ...options,
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
  gitMock.listServerRefs.mockClear()
  gitMock.push.mockClear()
  gitMock.remove.mockClear()
  gitMock.resolveRef.mockClear()
  gitMock.statusMatrix.mockClear()
})

describe("Cloudflare Artifacts workspace store", () => {
  it("derives distinct repository names from distinct Workspace names", async () => {
    const names: string[] = []
    const binding = {
      create: vi.fn(),
      get: vi.fn(async (name: string) => {
        names.push(name)
        throw artifactsError("INTERNAL_ERROR", 10400, "stop after resolving the repository name")
      }),
    }
    setActiveCloudflareEnv({ WORKSPACE_ARTIFACTS: binding })
    const { createCloudflareArtifactsWorkspaceStore } = await import("../src/providers/cloudflare/artifacts-store.ts")
    const options = {
      binding: "WORKSPACE_ARTIFACTS",
      namespace: "vitehub",
      provider: "cloudflare-artifacts" as const,
    }

    for (const name of ["a/b", "a-b", "a_2fb"]) {
      const store = createCloudflareArtifactsWorkspaceStore(options, name)
      await expect(store.readFile("README.md")).rejects.toThrow("stop after resolving")
    }

    expect(names).toEqual([
      "vitehub-workspace-a_2fb",
      "vitehub-workspace-a-b",
      "vitehub-workspace-a__2fb",
    ])
    expect(new Set(names).size).toBe(names.length)
  })

  it("uses the Artifacts binding and commits snapshots", async () => {
    const repo = artifactsRepo()
    const created = createdRepo()
    const binding = {
      create: vi.fn(async () => created),
      get: vi
        .fn()
        .mockRejectedValueOnce(artifactsError("NOT_FOUND", 10200, "missing"))
        .mockResolvedValueOnce(repo),
    }

    const store = await createStore(binding)

    await store.writeFile("README.md", { path: "README.md", content: "hello" })
    expect(await store.readFile("README.md")).toMatchObject({ path: "README.md" })
    await expect(store.glob("*.{md,mdx}")).resolves.toEqual([
      expect.objectContaining({ path: "README.md", type: "file" }),
    ])
    const snapshot = await store.snapshot({ name: "baseline" })
    await store.writeFile("README.md", { path: "README.md", content: "changed" })

    expect(snapshot.id).toBe("commit-1")
    expect(binding.create).toHaveBeenCalledWith(
      "vitehub-workspace-docs",
      expect.objectContaining({
        setDefaultBranch: "main",
      }),
    )
    expect(binding.get).toHaveBeenCalledTimes(2)
    expect(gitMock.clone).not.toHaveBeenCalled()
    expect(gitMock.init).toHaveBeenCalledOnce()
    expect(gitMock.push).toHaveBeenCalledWith(
      expect.objectContaining({
        ref: "main",
        url: remote,
      }),
    )
    expect(repo.createToken).not.toHaveBeenCalled()
    expect(created.dispose).toHaveBeenCalledOnce()
    expect(repo.dispose).toHaveBeenCalledOnce()
    const pushOptions = gitMock.push.mock.calls[0]?.[0] as { onAuth(): { password: string } }
    expect(pushOptions.onAuth().password).toBe("art_v1_created")
    expect((await store.diff({ from: snapshot })).entries).toEqual([
      expect.objectContaining({ path: "README.md", type: "modified" }),
    ])
  })

  it("pushes an empty initial snapshot as a Git commit", async () => {
    const store = await createStore({
      create: vi.fn(),
      get: vi.fn(async () => artifactsRepo()),
    })
    gitMock.statusMatrix.mockResolvedValueOnce([])

    const snapshot = await store.snapshot({ name: "Empty workspace" })

    expect(snapshot.id).toBe("commit-1")
    expect(gitMock.commit).toHaveBeenCalledWith(expect.objectContaining({
      message: "Empty workspace",
    }))
    expect(gitMock.push).toHaveBeenCalledOnce()
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
        if (url.pathname === "/onmax/repo/base-sha/mirror/tasks/todo.md") {
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
      requests.find(request => request.path === "/onmax/repo/base-sha/mirror/tasks/todo.md")?.headers.get("authorization"),
    ).toBe("Bearer github-token")
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
    const error = artifactsError("INTERNAL_ERROR", 10400, "Artifacts unavailable")
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

  it("disposes the repository handle when reading its info fails", async () => {
    const infoError = new Error("repository info unavailable")
    const repo = artifactsRepo({ infoError })
    const store = await createStore({
      create: vi.fn(),
      get: vi.fn(async () => repo),
    })

    await expect(store.readFile("README.md")).rejects.toBe(infoError)
    expect(repo.dispose).toHaveBeenCalledOnce()
    expect(repo.infoResult.dispose).not.toHaveBeenCalled()
    expect(repo.createToken).not.toHaveBeenCalled()
  })

  it("gets the repository created by a concurrent request", async () => {
    const repo = artifactsRepo()
    const binding = {
      create: vi.fn(async () => {
        throw artifactsError("ALREADY_EXISTS", 10201, "already exists")
      }),
      get: vi.fn()
        .mockRejectedValueOnce(artifactsError("NOT_FOUND", 10200, "missing"))
        .mockResolvedValueOnce(repo),
    }
    gitMock.listServerRefs.mockResolvedValueOnce([{ oid: "remote-sha", ref: "refs/heads/main" }])
    gitMock.clone.mockResolvedValueOnce(undefined)
    const store = await createStore(binding)

    await expect(store.readFile("README.md")).resolves.toBeUndefined()
    expect(binding.get).toHaveBeenCalledTimes(2)
    expect(gitMock.clone).toHaveBeenCalledOnce()
    expect(gitMock.init).not.toHaveBeenCalled()
  })

  it("disposes a creation result when the repository cannot be loaded", async () => {
    const created = createdRepo()
    const lookupError = new Error("created repository is not ready")
    const store = await createStore({
      create: vi.fn(async () => created),
      get: vi
        .fn()
        .mockRejectedValueOnce(artifactsError("NOT_FOUND", 10200, "missing"))
        .mockRejectedValueOnce(lookupError),
    })

    await expect(store.readFile("README.md")).rejects.toBe(lookupError)
    expect(created.dispose).toHaveBeenCalledOnce()
  })

  it("initializes repositories without a branch but propagates clone failures for existing branches", async () => {
    const empty = artifactsRepo()
    const emptyStore = await createStore({
      create: vi.fn(),
      get: vi.fn(async () => empty),
    })

    await expect(emptyStore.readFile("README.md")).resolves.toBeUndefined()
    expect(gitMock.clone).not.toHaveBeenCalled()
    expect(gitMock.init).toHaveBeenCalledOnce()

    const nonEmpty = artifactsRepo()
    const cloneError = new Error("clone authentication failed")
    gitMock.listServerRefs.mockResolvedValueOnce([{ oid: "remote-sha", ref: "refs/heads/main" }])
    gitMock.clone.mockRejectedValueOnce(cloneError)
    const nonEmptyStore = await createStore({
      create: vi.fn(),
      get: vi.fn(async () => nonEmpty),
    })

    await expect(nonEmptyStore.readFile("README.md")).rejects.toBe(cloneError)
    expect(gitMock.init).toHaveBeenCalledOnce()
    expect(nonEmpty.dispose).toHaveBeenCalledOnce()
    expect(nonEmpty.infoResult.dispose).toHaveBeenCalledOnce()
    expect(nonEmpty.tokenResults[0]?.dispose).toHaveBeenCalledOnce()
  })

  it("disposes repository RPC results when remote inspection fails", async () => {
    const repo = artifactsRepo()
    const inspectionError = new Error("remote inspection failed")
    gitMock.listServerRefs.mockRejectedValueOnce(inspectionError)
    const store = await createStore({
      create: vi.fn(),
      get: vi.fn(async () => repo),
    })

    await expect(store.readFile("README.md")).rejects.toBe(inspectionError)
    expect(repo.dispose).toHaveBeenCalledOnce()
    expect(repo.infoResult.dispose).toHaveBeenCalledOnce()
    expect(repo.tokenResults[0]?.dispose).toHaveBeenCalledOnce()
  })

  it("renews a short-lived creation token through the repository handle before Git auth", async () => {
    const repo = artifactsRepo({ token: "art_v1_renewed?expires=999" })
    const binding = {
      create: vi.fn(async () => createdRepo(`art_v1_expiring?expires=${Math.floor((Date.now() + 30_000) / 1000)}`)),
      get: vi.fn()
        .mockRejectedValueOnce(artifactsError("NOT_FOUND", 10200, "missing"))
        .mockResolvedValueOnce(repo),
    }
    const store = await createStore(binding)

    await store.writeFile("README.md", { content: "hello", path: "README.md" })
    await store.snapshot()

    expect(repo.createToken).toHaveBeenCalledWith("write", 3600)
    const pushOptions = gitMock.push.mock.calls[0]?.[0] as { onAuth(): { password: string } }
    expect(pushOptions.onAuth().password).toBe("art_v1_renewed")
  })

  it("reacquires and disposes a repository handle when its cached token expires", async () => {
    const loadedRepo = artifactsRepo({ tokenExpiresIn: 30_000 })
    const refreshRepo = artifactsRepo({ token: "art_v1_refreshed?expires=999" })
    const binding = {
      create: vi.fn(),
      get: vi.fn().mockResolvedValueOnce(loadedRepo).mockResolvedValueOnce(refreshRepo),
    }
    const store = await createStore(binding)

    await store.writeFile("README.md", { content: "hello", path: "README.md" })
    await store.snapshot()

    expect(binding.get).toHaveBeenCalledTimes(2)
    expect(loadedRepo.dispose).toHaveBeenCalledOnce()
    expect(loadedRepo.tokenResults[0]?.dispose).toHaveBeenCalledOnce()
    expect(refreshRepo.dispose).toHaveBeenCalledOnce()
    expect(refreshRepo.tokenResults[0]?.dispose).toHaveBeenCalledOnce()
    const pushOptions = gitMock.push.mock.calls[0]?.[0] as { onAuth(): { password: string } }
    expect(pushOptions.onAuth().password).toBe("art_v1_refreshed")
  })

  it("disposes a reacquired repository handle when token minting fails", async () => {
    const loadedRepo = artifactsRepo({ tokenExpiresIn: 30_000 })
    const tokenError = new Error("token minting failed")
    const refreshRepo = artifactsRepo({ tokenError })
    const binding = {
      create: vi.fn(),
      get: vi.fn().mockResolvedValueOnce(loadedRepo).mockResolvedValueOnce(refreshRepo),
    }
    const store = await createStore(binding)

    await store.writeFile("README.md", { content: "hello", path: "README.md" })
    await expect(store.snapshot()).rejects.toBe(tokenError)

    expect(loadedRepo.dispose).toHaveBeenCalledOnce()
    expect(loadedRepo.tokenResults[0]?.dispose).toHaveBeenCalledOnce()
    expect(refreshRepo.dispose).toHaveBeenCalledOnce()
    expect(refreshRepo.tokenResults).toEqual([])
    expect(gitMock.push).not.toHaveBeenCalled()
  })

  it("uses the loaded branch head and repository entries as the initial baseline", async () => {
    const repo = artifactsRepo()
    gitMock.listServerRefs.mockResolvedValueOnce([
      { oid: "remote-commit", ref: "refs/heads/main" },
    ])
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
    })
    gitMock.listServerRefs.mockResolvedValueOnce([{ oid: "remote-sha", ref: "refs/heads/trunk" }])
    gitMock.clone.mockResolvedValueOnce(undefined)
    const { resolveCloudflareArtifactsStore } = await import("../src/config.ts")
    const options = resolveCloudflareArtifactsStore({}, {})
    const store = await createStore(
      {
        create: vi.fn(),
        get: vi.fn(async () => repo),
      },
      options,
    )

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
    const nonEmptyRepo = artifactsRepo()
    const binding = {
      create: vi.fn(async () => createdRepo()),
      get: vi.fn()
        .mockRejectedValueOnce(legacyArtifactsError(10200, "missing"))
        .mockResolvedValueOnce(emptyRepo)
        .mockResolvedValueOnce(nonEmptyRepo),
    }
    gitMock.listServerRefs
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ oid: "commit-1", ref: "refs/heads/main" }])
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
      code: "WORKSPACE_CONFLICT",
      message: expect.stringContaining("changed remotely"),
      name: "ViteHubError",
    })
    await expect(store.snapshot()).rejects.toMatchObject({ code: "WORKSPACE_CONFLICT", name: "ViteHubError" })
    expect(gitMock.commit).toHaveBeenCalledOnce()
    expect(gitMock.push).toHaveBeenCalledTimes(2)
  })

  it("rebases a conflicted snapshot without dropping unrelated staged writes", async () => {
    const repo = artifactsRepo()
    let remoteHead = "base-commit"
    let remotePage = "# Base\n"
    let remoteDraft: string | undefined
    gitMock.listServerRefs.mockResolvedValue([{ oid: remoteHead, ref: "refs/heads/main" }])
    let cloneCalls = 0
    let releaseFinalClone: (() => void) | undefined
    const finalCloneStarted = new Promise<void>((resolve) => {
      gitMock.clone.mockImplementation(async (options?: unknown) => {
        cloneCalls++
        if (cloneCalls === 3) {
          await new Promise<void>((release) => {
            releaseFinalClone = release
            resolve()
          })
        }
      const { fs } = options as {
        fs: { promises: { writeFile(path: string, content: string): Promise<void> } }
      }
      await fs.promises.writeFile("/workspace/page.md", remotePage)
      if (remoteDraft) await fs.promises.writeFile("/workspace/draft.md", remoteDraft)
      })
    })
    gitMock.resolveRef.mockImplementation(async () => remoteHead)
    const rejection = Object.assign(
      new Error("Push rejected because it was not a simple fast-forward"),
      {
        code: "PushRejectedError",
        data: { reason: "not-fast-forward" },
      },
    )
    gitMock.push
      .mockRejectedValueOnce(rejection)
      .mockResolvedValue({ refs: { main: "retry-commit" } })
    const store = await createStore({
      create: vi.fn(),
      get: vi.fn(async () => repo),
    })

    await store.writeFile("page.md", { content: "# Realtime\n", path: "page.md" })
    await store.writeFile("draft.md", { content: "unrelated draft\n", path: "draft.md" })
    remoteHead = "remote-commit"
    remotePage = "# Remote\n"
    remoteDraft = "remote draft\n"

    await expect(store.snapshot({ name: "conflict" })).rejects.toMatchObject({
      code: "WORKSPACE_CONFLICT",
    })
    await expect(store.rebase?.({ takeRemote: ["page.md"] })).rejects.toMatchObject({
      code: "WORKSPACE_CONFLICT",
    })
    await expect(store.readFile("draft.md")).resolves.toMatchObject({
      content: new TextEncoder().encode("unrelated draft\n"),
    })
    remoteDraft = undefined
    const rebase = store.rebase?.({ takeRemote: ["page.md"] })
    await finalCloneStarted
    const readSettled = vi.fn()
    const read = store.readFile("page.md").then(readSettled)
    await Promise.resolve()
    expect(readSettled).not.toHaveBeenCalled()
    releaseFinalClone!()
    await rebase
    await read
    await expect(store.readFile("page.md")).resolves.toMatchObject({
      content: new TextEncoder().encode("# Remote\n"),
    })
    await expect(store.readFile("draft.md")).resolves.toMatchObject({
      content: new TextEncoder().encode("unrelated draft\n"),
    })
    await expect(store.snapshot({ name: "retry" })).resolves.toMatchObject({ id: "commit-1" })
  })

  it("reopens an existing branch before committing and pushing its next snapshot", async () => {
    const repo = artifactsRepo()
    let head: string | undefined
    gitMock.listServerRefs.mockResolvedValueOnce([
      { oid: "remote-commit", ref: "refs/heads/main" },
    ])
    gitMock.clone.mockImplementationOnce(async () => {
      head = "remote-commit"
    })
    gitMock.resolveRef.mockImplementationOnce(async () => head || "")
    gitMock.commit.mockImplementationOnce(async () => {
      if (head !== "remote-commit") throw new Error("commit did not extend the remote head")
      head = "next-commit"
      return head
    })
    gitMock.push.mockImplementationOnce(async () => {
      if (head !== "next-commit") throw new Error("push was not fast-forward")
      return { refs: { main: head } }
    })
    const store = await createStore({
      create: vi.fn(),
      get: vi.fn(async () => repo),
    })

    await store.writeFile("README.md", { content: "next", path: "README.md" })
    await expect(store.snapshot()).resolves.toMatchObject({ id: "next-commit" })
    expect(gitMock.listServerRefs).toHaveBeenCalledWith(
      expect.objectContaining({
        prefix: "refs/heads/main",
        url: remote,
      }),
    )
    expect(gitMock.clone).toHaveBeenCalledOnce()
    expect(gitMock.init).not.toHaveBeenCalled()
    expect(gitMock.clone.mock.invocationCallOrder[0]).toBeLessThan(
      gitMock.commit.mock.invocationCallOrder[0]!,
    )
    expect(gitMock.commit.mock.invocationCallOrder[0]).toBeLessThan(
      gitMock.push.mock.invocationCallOrder[0]!,
    )
    expect(gitMock.push).toHaveBeenCalledWith(
      expect.objectContaining({ ref: "main", url: remote }),
    )
    expect(repo.dispose).toHaveBeenCalledOnce()
    expect(repo.infoResult.dispose).toHaveBeenCalledOnce()
    expect(repo.tokenResults[0]?.dispose).toHaveBeenCalledOnce()
  })
})
