import { afterEach, describe, expect, it, vi } from "vitest"

import { clearActiveCloudflareEnv, setActiveCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"
import { defineWorkspace } from "../src/index.ts"
import { resetWorkspaceRegistry, setWorkspaceRegistry } from "../src/core/registry.ts"
import { resetWorkspaceStoreCache } from "../src/core/workspace-cache.ts"
import { setWorkspaceHostedStoreLoader } from "../src/runtime/hosted-store-loader.ts"
import { setWorkspaceRuntimeConfig } from "../src/runtime/config.ts"

const gitMock = vi.hoisted(() => ({
  add: vi.fn(async () => {}),
  clone: vi.fn(async () => {
    throw new Error("empty remote")
  }),
  commit: vi.fn(async () => "commit-1"),
  init: vi.fn(async () => {}),
  push: vi.fn(async () => ({ refs: { main: "commit-1" } })),
  remove: vi.fn(async () => {}),
  statusMatrix: vi.fn(async ({ fs }: { fs: { entries: Map<string, { kind: "file" | "dir" }> } }) => [...fs.entries]
    .filter(([path, entry]) => path.startsWith("/workspace/") && entry.kind === "file")
    .map(([path]) => [path.slice("/workspace/".length), 0, 2, 0])),
}))

vi.mock("isomorphic-git", () => gitMock)
vi.mock("isomorphic-git/http/web", () => ({}))

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
  gitMock.statusMatrix.mockClear()
})

describe("Cloudflare Artifacts workspace store", () => {
  it("uses the Artifacts binding and commits snapshots", async () => {
    const createdRepo = {
      createToken: vi.fn(async () => ({ plaintext: "art_v1_secret?expires=999" })),
      name: "vitehub-workspace-docs",
      remote: "https://account.artifacts.cloudflare.net/git/vitehub/vitehub-workspace-docs.git",
    }
    const binding = {
      create: vi.fn(async () => ({ ...createdRepo, token: "art_v1_created?expires=999" })),
      get: vi.fn(async () => {
        throw new Error("missing")
      }),
    }

    setActiveCloudflareEnv({ WORKSPACE_ARTIFACTS: binding })
    const { createCloudflareArtifactsWorkspaceStore } = await import("../src/providers/cloudflare/artifacts-store.ts")
    const store = createCloudflareArtifactsWorkspaceStore({
      binding: "WORKSPACE_ARTIFACTS",
      namespace: "vitehub",
      provider: "cloudflare-artifacts",
    }, "docs")

    await store.writeFile("README.md", { path: "README.md", content: "hello" })
    expect(await store.readFile("README.md")).toMatchObject({ path: "README.md" })
    const snapshot = await store.snapshot({ name: "baseline" })
    await store.writeFile("README.md", { path: "README.md", content: "changed" })

    expect(snapshot.id).toBe("commit-1")
    expect(binding.create).toHaveBeenCalledWith("vitehub-workspace-docs", expect.objectContaining({
      setDefaultBranch: "main",
    }))
    expect(gitMock.push).toHaveBeenCalledWith(expect.objectContaining({
      ref: "main",
      url: createdRepo.remote,
    }))
    expect((await store.diff({ from: snapshot })).entries).toEqual([
      expect.objectContaining({ path: "README.md", type: "modified" }),
    ])
  })

  it("configures Cloudflare hosted Workspace runtime through public API", async () => {
    const repo = {
      createToken: vi.fn(async () => ({ plaintext: "art_v1_secret?expires=999" })),
      name: "vitehub-workspace-docs",
      remote: "https://account.artifacts.cloudflare.net/git/vitehub/vitehub-workspace-docs.git",
    }
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
    ).toBe("application/vnd.github.raw")
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
    const repo = {
      createToken: vi.fn(async () => ({ plaintext: "art_v1_secret?expires=999" })),
      name: "vitehub-workspace-docs",
      remote: "https://account.artifacts.cloudflare.net/git/vitehub/vitehub-workspace-docs.git",
    }
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
    const repo = {
      createToken: vi.fn(async () => ({ plaintext: "art_v1_secret?expires=999" })),
      name: "vitehub-workspace-docs",
      remote: "https://account.artifacts.cloudflare.net/git/vitehub/vitehub-workspace-docs.git",
    }
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
})
