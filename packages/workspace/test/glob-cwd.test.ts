import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { createWorkspace } from "../src/core/workspace.ts"
import { createGitHubWorkspaceStore } from "../src/providers/github/store.ts"
import { createWorkspaceAssets } from "../src/runtime/assets.ts"
import { custom } from "../src/sources/custom.ts"
import { fetch as fetchSource } from "../src/sources/fetch.ts"
import { markLiveWorkspaceSource } from "../src/sources/live.ts"
import { createWorkspaceSourceView } from "../src/sources/view.ts"
import { createLocalWorkspaceStore } from "../src/storage/local.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"
import { checkGlobCwd, globCwdPaths, seedGlobCwdStore } from "./glob-cwd-checks.ts"

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

describe("Workspace glob cwd", () => {
  it("filters custom Store results when the Store ignores cwd", async () => {
    const store = createMemoryWorkspaceStore()
    await seedGlobCwdStore(store)
    const glob = store.glob.bind(store)
    vi.spyOn(store, "glob").mockImplementation(pattern => glob(pattern))
    const workspace = createWorkspace({
      name: "custom-store-glob-cwd",
      store,
    })

    expect((await workspace.glob(["**/*.md", "**/*.mdx"], { cwd: "docs" })).map(entry => entry.path))
      .toEqual(["docs/nested/guide.mdx", "docs/readme.md"])
    expect(await workspace.glob("*.md", { cwd: "docs" })).toEqual([])
  })

  it("matches relative patterns in the memory Store", async () => {
    const store = createMemoryWorkspaceStore()
    await seedGlobCwdStore(store)
    await checkGlobCwd(store)
  })

  it("matches relative patterns in the local Store", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-glob-cwd-"))
    roots.push(root)
    const store = createLocalWorkspaceStore(root)
    await seedGlobCwdStore(store)
    await checkGlobCwd(store)
  })

  it("matches relative patterns in bundled assets", async () => {
    const assets = createWorkspaceAssets(Object.fromEntries(globCwdPaths.map(path => [path, { load: async () => path }])))
    await checkGlobCwd(assets)
  })

  it("matches relative patterns in materialized Sources through the public Workspace", async () => {
    const workspace = createWorkspace({
      name: "glob-cwd",
      store: { driver: "memory" },
      sources: { docs: custom({ mount: "", materialize: "lazy", files: globCwdPaths.map(path => ({ path, content: path })) }) },
    })
    await checkGlobCwd(workspace)
  })

  it("matches relative patterns in live Sources", async () => {
    const source = markLiveWorkspaceSource(custom({
      mount: "",
      materialize: "lazy",
      async getKeys() { return globCwdPaths },
      async getItem(key) { return { key, content: key } },
    }), Object.fromEntries(globCwdPaths.map(path => [path, `/local/${path}`])))
    const view = createWorkspaceSourceView({ name: "live-glob-cwd", sources: { docs: source } }, createMemoryWorkspaceStore())
    await checkGlobCwd(view)
  })

  it("excludes request descriptors outside cwd", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected provider request"))
    const store = createMemoryWorkspaceStore()
    await store.writeFile("docs/data.json", { path: "docs/data.json", content: "{}" })
    const querySchema = {
      "~standard": {
        jsonSchema: { input: () => ({ type: "object", properties: {} }) },
        validate: () => ({ value: {} }),
      },
    }
    const view = createWorkspaceSourceView({
      name: "descriptor-glob-cwd",
      sources: { status: fetchSource({ url: "https://example.invalid/status", querySchema }) },
    }, store)

    expect((await view.glob("**/*.json", { cwd: "docs" })).map(entry => entry.path)).toEqual(["docs/data.json"])
    expect((await view.glob("**/*.json")).map(entry => entry.path)).toEqual([".vitehub/sources/status.json", "docs/data.json"])
    expect(request).not.toHaveBeenCalled()
  })

  it.each(["memory", "github"])("allows descriptor cwd with the %s Store", async (provider) => {
    const request = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected provider request"))
    const store = provider === "memory"
      ? createMemoryWorkspaceStore()
      : createGitHubWorkspaceStore({ driver: "github", repository: "onmax/repo", token: "test-token" }, "descriptor-cwd")
    const querySchema = {
      "~standard": {
        jsonSchema: { input: () => ({ type: "object", properties: {} }) },
        validate: () => ({ value: {} }),
      },
    }
    const view = createWorkspaceSourceView({
      name: "descriptor-cwd",
      sources: { status: fetchSource({ url: "https://example.invalid/status", querySchema }) },
    }, store)

    expect((await view.glob("*.json", { cwd: ".vitehub/sources" })).map(entry => entry.path))
      .toEqual([".vitehub/sources/status.json"])
    expect(await view.glob("*.md", { cwd: ".vitehub/sources" })).toEqual([])
    const emptyView = createWorkspaceSourceView({ name: "no-descriptors" }, store)
    expect(await emptyView.glob("*.json", { cwd: ".vitehub/sources" })).toEqual([])
    expect(request).not.toHaveBeenCalled()
  })
})
