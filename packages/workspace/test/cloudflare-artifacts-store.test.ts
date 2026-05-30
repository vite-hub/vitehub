import { afterEach, describe, expect, it, vi } from "vitest"

import { clearActiveCloudflareEnv, setActiveCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"

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
