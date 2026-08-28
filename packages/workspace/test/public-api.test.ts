import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { resetWorkspaceAssetsRegistry } from "../src/asset-registry.ts"
import { defineWorkspace, file, useWorkspace } from "../src/index.ts"
import { registerWorkspace } from "../src/test.ts"
import { resetWorkspaceRegistry, setWorkspaceRegistry } from "../src/core/registry.ts"
import { createWorkspaceAssets } from "../src/runtime/assets.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"
import { resolveWorkspaceStoreTarget } from "../src/storage/target.ts"
import { setWorkspaceHostedStoreLoader, setWorkspaceRuntimeAssetsRegistry, setWorkspaceRuntimeConfig, useWorkspace as useRuntimeWorkspace } from "../src/runtime/state.ts"

const tempDirs: string[] = []

async function readBuiltSourceModule(sourcePath: string): Promise<string> {
  const distDir = new URL("../dist/", import.meta.url)
  const files = await readdir(distDir, { recursive: true })
  const marker = `//#region ${sourcePath}`
  const modules = await Promise.all(
    files.filter(file => file.endsWith(".js"))
      .map(file => readFile(new URL(file, distDir), "utf8")),
  )
  const matches = modules.filter(content => content.includes(marker))

  if (matches.length !== 1) {
    throw new Error(`Expected one built module for ${sourcePath}, found ${matches.length}`)
  }

  return matches[0]
}

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-api-"))
  tempDirs.push(root)
  return root
}

afterEach(async () => {
  resetWorkspaceAssetsRegistry()
  resetWorkspaceRegistry()
  setWorkspaceHostedStoreLoader(undefined)
  setWorkspaceRuntimeConfig(false)
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe("workspace public API", () => {
  it("rejects authored workspace names", () => {
    expect(() => defineWorkspace({ name: "api" } as never)).toThrow("Workspace names are inferred")
  })

  it("exports runtime useWorkspace without the source authoring entry", async () => {
    const builtRuntimeState = await readFile(new URL("../dist/runtime/state.js", import.meta.url), "utf8")
    expect(builtRuntimeState).not.toContain("@vite-hub/source")

    registerWorkspace("runtime-api", defineWorkspace({
      store: { provider: "memory" },
    }))

    const workspace = useRuntimeWorkspace("runtime-api", { mode: "write" })
    await workspace.fs.writeFile("data.json", "{}")

    expect(await workspace.fs.readFile("data.json")).toBe("{}")
  })

  it("merges generated agent sources with configured workspace sources", async () => {
    setWorkspaceRegistry({
      agent: async () => ({
        default: {
          __vitehubWorkspaceAgentOptions: {
            workspace: {
              sources: {
                skill: file({
                  content: "# Skill\n",
                  workspacePath: "skills/browser/SKILL.md",
                }),
              },
              store: { provider: "memory" },
            },
          },
          sources: {
            instructions: file({
              content: "# Agent\n",
              workspacePath: "AGENTS.md",
            }),
          },
        } as never,
      }),
    })

    const workspace = useWorkspace("agent", { mode: "write" })

    expect(await workspace.fs.readFile("AGENTS.md")).toBe("# Agent\n")
    expect(await workspace.fs.readFile("skills/browser/SKILL.md")).toBe("# Skill\n")
  })

  it("keeps shell as a lazy workspace tools dependency", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
    const distDir = new URL("../dist/", import.meta.url)
    const aiFiles = (await readdir(distDir)).filter(file => file === "ai.js" || /^ai-.*\.js$/.test(file))
    const dependencyLoaderFiles = (await readdir(distDir)).filter(file => file === "dependency-loaders.js" || /^dependency-loaders-.*\.js$/.test(file))
    const aiDeclarationFiles = (await readdir(distDir)).filter(file => file === "ai.d.ts" || /^ai-.*\.d\.ts$/.test(file))
    const builtAi = (await Promise.all(aiFiles.map(file => readFile(new URL(file, distDir), "utf8")))).join("\n")
    const builtDependencyLoaders = (await Promise.all(dependencyLoaderFiles.map(file => readFile(new URL(file, distDir), "utf8")))).join("\n")
    const builtAiDeclarations = (await Promise.all(aiDeclarationFiles.map(file => readFile(new URL(file, distDir), "utf8")))).join("\n")
    const runtimeFiles = (await readdir(distDir)).filter(file => file === "runtime.js" || file === "runtime/state.js" || /^use-.*\.js$/.test(file))
    const builtRuntime = (await Promise.all(runtimeFiles.map(file => readFile(new URL(file, distDir), "utf8")))).join("\n")

    expect(packageJson.dependencies?.["@vite-hub/shell"]).toBeUndefined()
    expect(packageJson.peerDependencies?.["@vite-hub/shell"]).toBe("workspace:*")
    expect(packageJson.peerDependenciesMeta?.["@vite-hub/shell"]).toEqual({ optional: true })
    expect(builtAiDeclarations).not.toContain("@vite-hub/shell")
    expect(builtAi).not.toContain("from\"@vite-hub/shell")
    expect(builtAi).not.toContain("from \"@vite-hub/shell")
    expect(builtAi).not.toContain("import(\"@vite-hub/shell\")")
    expect(builtAi).not.toContain("import('@vite-hub/shell')")
    expect(builtAi).not.toContain("import(\"@vite-hub/shell/workspace\")")
    expect(builtAi).not.toContain("import('@vite-hub/shell/workspace')")
    expect(`${builtAi}\n${builtDependencyLoaders}`).toContain("@vite-hub/shell/workspace")
    expect(builtDependencyLoaders).not.toContain('import("@vite-hub/shell/workspace")')
    expect(builtDependencyLoaders).not.toContain("import('@vite-hub/shell/workspace')")
    expect(builtRuntime).not.toContain("import(\"@vite-hub/shell")
    expect(builtRuntime).not.toContain("import('@vite-hub/shell")
  })

  it("keeps workspace declarations installable without optional integration peers", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
    const builtServer = await readFile(new URL("../dist/server.d.ts", import.meta.url), "utf8")
    const builtCollectionsClient = await readFile(new URL("../dist/collections/client.js", import.meta.url), "utf8")
    const builtCloudflareArtifactsStore = await readBuiltSourceModule("src/providers/cloudflare/artifacts-store.ts")
    const builtMountx = await readFile(new URL("../dist/mountx.js", import.meta.url), "utf8")
    const distDir = new URL("../dist/", import.meta.url)
    const distFiles = await readdir(distDir, { recursive: true })
    const declarations = (await Promise.all(distFiles
      .filter(file => file.endsWith(".d.ts"))
      .map(file => readFile(new URL(file, distDir), "utf8")))).join("\n")
    const effectFreeBundles = (await Promise.all([
      "cloudflare.js",
      "source-metadata.js",
      "runtime/empty-assets-registry.js",
      "runtime/empty-registry.js",
      "providers/github/store.js",
    ].map(file => readFile(new URL(file, distDir), "utf8")))).join("\n")
    const effectImport = /(?:from\s*|import\s*(?:\(\s*)?)["']effect(?:\/[^"']*)?["']/
    const vueFreeBundles = (await Promise.all(["index.js", "server.js", "collections.js"]
      .map(file => readFile(new URL(file, distDir), "utf8")))).join("\n")

    expect(packageJson.dependencies?.h3).toBe("catalog:unjs")
    expect(packageJson.dependencies?.ofetch).toBe("catalog:unjs")
    expect(packageJson.exports).toHaveProperty("./collections")
    expect(packageJson.exports).toHaveProperty("./collections/client")
    expect(packageJson.exports).toHaveProperty("./mountx")
    expect(packageJson.peerDependencies?.vue).toBe("catalog:ui")
    expect(packageJson.peerDependenciesMeta?.vue).toEqual({ optional: true })
    expect(packageJson.dependencies?.["files-sdk"]).toBeUndefined()
    expect(packageJson.peerDependencies?.h3).toBeUndefined()
    expect(packageJson.peerDependenciesMeta?.h3).toBeUndefined()
    expect(packageJson.peerDependencies?.["@vite-hub/sandbox"]).toBeUndefined()
    expect(packageJson.peerDependenciesMeta?.["@vite-hub/sandbox"]).toBeUndefined()
    expect(packageJson.peerDependencies?.["files-sdk"]).toBeUndefined()
    expect(packageJson.peerDependenciesMeta?.["files-sdk"]).toBeUndefined()
    expect(packageJson.peerDependencies?.["@vercel/blob"]).toBeUndefined()
    expect(packageJson.peerDependenciesMeta?.["@vercel/blob"]).toBeUndefined()
    expect(builtServer).toContain("from \"h3\"")
    expect(declarations).not.toContain("files-sdk")
    expect(declarations).not.toContain("@vercel/blob")
    expect(declarations).not.toContain("@vite-hub/sandbox")
    expect(declarations).not.toMatch(effectImport)
    expect(effectFreeBundles).not.toMatch(effectImport)
    expect(builtCloudflareArtifactsStore).not.toMatch(effectImport)
    expect(builtMountx).toContain('from "mountx/drivers/unstorage"')
    expect(vueFreeBundles).not.toContain('from "mountx')
    expect(vueFreeBundles).not.toMatch(/from\s*["']vue["']/)
    expect(builtCollectionsClient).toMatch(/from\s*["']vue["']/)
  })

  it("keeps hosted runtime setup off the public Workspace surface", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
    const hosted = await import("../src/hosted.ts")
    const builtVercelBlobStore = await readBuiltSourceModule("src/providers/vercel/blob-store.ts")

    expect(packageJson.exports).not.toHaveProperty("./hosted")
    expect(packageJson.exports).toHaveProperty("./internal/runtime/hosted")
    expect(packageJson.exports).toHaveProperty("./internal/runtime/hosted-vercel-blob")
    expect(hosted).toHaveProperty("configureHostedWorkspaceRuntime")
    expect(hosted).toHaveProperty("installHostedWorkspaceRuntime")
    expect(hosted).not.toHaveProperty("createCloudflareArtifactsWorkspaceStore")
    expect(hosted).not.toHaveProperty("createGitHubWorkspaceStore")
    expect(hosted).not.toHaveProperty("createVercelBlobWorkspaceStore")
    expect(builtVercelBlobStore).not.toContain("files-sdk")
    expect(builtVercelBlobStore).not.toContain('import("files-sdk/vercel-blob")')
    expect(builtVercelBlobStore).not.toContain('import("@vercel/blob")')
    expect(builtVercelBlobStore).not.toContain('from "@vercel/blob"')
    expect(builtVercelBlobStore).not.toContain('from "undici"')
  })

  it("uses the writable facade for synced reads and writes", async () => {
    registerWorkspace("api", defineWorkspace({
      store: { provider: "memory" },
      sources: {
        docs: file({
          workspacePath: "README.md",
          content: "# API\n",
        }),
        agents: file({
          workspacePath: "AGENTS.md",
          content: "# Instructions\n",
        }),
      },
    }))

    const workspace = useWorkspace("api", { mode: "write" })
    await workspace.fs.writeFile("generated/summary.md", "summary")

    expect(await workspace.fs.readFile("README.md")).toBe("# API\n")
    expect(await workspace.fs.readFile("AGENTS.md")).toBe("# Instructions\n")
    await expect(workspace.fs.stat("AGENTS.md")).resolves.toMatchObject({ mediaType: "text/markdown" })
    expect(await workspace.fs.exists("generated/summary.md")).toBe(true)
    expect(await workspace.fs.glob("**/*.md")).toHaveLength(3)
  })

  it("rejects a conditional write after the Workspace file changes", async () => {
    registerWorkspace("conditional-write", defineWorkspace({ store: { provider: "memory" } }))
    const first = useWorkspace("conditional-write", { mode: "write" })
    const second = useWorkspace("conditional-write", { mode: "write" })
    await first.fs.writeFile("docs/page.md", "first")
    const baseline = await first.fs.stat("docs/page.md")
    await second.fs.writeFile("docs/page.md", "second")

    await expect(first.fs.writeFile("docs/page.md", "stale", { ifDigest: baseline.digest! }))
      .rejects.toMatchObject({ code: "WORKSPACE_CONFLICT" })
    await expect(first.fs.readFile("docs/page.md")).resolves.toBe("second")
  })

  it("rejects validator path rewrites before mutating a preserved path", async () => {
    registerWorkspace("preserved-path", defineWorkspace({
      rules: {
        "**": {
          validate: input => ({ ...input, path: "redirected.md" }),
          write: true,
        },
      },
      store: { provider: "memory" },
    }))
    const workspace = useWorkspace("preserved-path", { mode: "write" })

    await expect(workspace.fs.writeFile("document.md", "draft", { preservePath: true }))
      .rejects.toThrow("cannot rewrite preserved path")
    await expect(workspace.fs.exists("document.md")).resolves.toBe(false)
    await expect(workspace.fs.exists("redirected.md")).resolves.toBe(false)
  })

  it("exposes source materialization on the writable facade", async () => {
    registerWorkspace("materialize-api", defineWorkspace({
      store: { provider: "memory" },
      sources: {
        docs: file({
          workspacePath: "README.md",
          content: "# API\n",
          materialize: "lazy",
        }),
      },
    }))

    const workspace = useWorkspace("materialize-api", { mode: "write" })
    await expect(workspace.materializeSources({ sources: ["docs"] })).resolves.toMatchObject({
      sources: [expect.objectContaining({ source: "docs", status: "ready" })],
    })
    expect(await workspace.fs.readFile("README.md")).toBe("# API\n")
  })

  it("checkpoints writable workspace history", async () => {
    const store = createMemoryWorkspaceStore()
    const snapshot = vi.spyOn(store, "snapshot")
    const rebase = vi.fn(async () => {})
    store.rebase = rebase
    registerWorkspace("history-api", defineWorkspace({ store }))

    const workspace = useWorkspace("history-api", { mode: "write" })
    const checkpoint = await workspace.history.checkpoint({ message: "docs: save draft" })
    await workspace.history.rebase({ takeRemote: ["docs/page.md"] })

    expect(snapshot).toHaveBeenCalledWith({ name: "docs: save draft" })
    expect(rebase).toHaveBeenCalledWith({ takeRemote: ["docs/page.md"] })
    expect(checkpoint.name).toBe("docs: save draft")
  })

  it("identifies memory workspace stores", async () => {
    await expect(resolveWorkspaceStoreTarget(createMemoryWorkspaceStore())).resolves.toEqual({ provider: "memory" })
  })

  it("publishes from the writable facade without running definition sync", async () => {
    const store = createMemoryWorkspaceStore()
    const snapshot = vi.spyOn(store, "snapshot")
    const publish = vi.fn(async () => {})
    registerWorkspace("publish-api", defineWorkspace({
      loaders: [{ name: "sync-probe", async load() {} }],
      publish: [{ name: "test", publish }],
      store,
    }))

    const workspace = useWorkspace("publish-api", { mode: "write" })
    await workspace.publish({ name: "publish current state" })

    expect(snapshot).not.toHaveBeenCalled()
    expect(publish).toHaveBeenCalledOnce()
  })

  it("waits for in-flight definition sync before publishing", async () => {
    let markSyncStarted!: () => void
    const syncStarted = new Promise<void>((resolve) => { markSyncStarted = resolve })
    let finishSync!: () => void
    const syncing = new Promise<void>((resolve) => { finishSync = resolve })
    const publish = vi.fn(async () => {})
    registerWorkspace("publish-after-sync", defineWorkspace({
      loaders: [{ name: "sync-probe", async load() { markSyncStarted(); await syncing } }],
      publish: [{ name: "test", publish }],
      store: { provider: "memory" },
    }))

    const workspace = useWorkspace("publish-after-sync", { mode: "write" })
    const read = workspace.fs.exists("README.md")
    await syncStarted
    const publication = workspace.publish()
    await Promise.resolve()
    expect(publish).not.toHaveBeenCalled()

    finishSync()
    await Promise.all([read, publication])
    expect(publish).toHaveBeenCalledTimes(2)
  })

  it("serves allowlisted workspace files as H3-compatible responses", async () => {
    registerWorkspace("files", defineWorkspace({
      store: { provider: "memory" },
    }))
    const workspace = useWorkspace("files", { mode: "write" })
    await workspace.fs.writeFile("tasks/open.json", "{\"ok\":true}", { mediaType: "application/json" })

    const { readWorkspaceFileResponse } = await import("../src/server.ts")
    const response = await readWorkspaceFileResponse({
      allow: ["tasks/**/*.json"],
      path: "open.json",
      root: "tasks",
      workspace: "files",
    })

    expect(response.headers.get("content-type")).toBe("application/json")
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    await expect(response.text()).resolves.toBe("{\"ok\":true}")
    await expect(readWorkspaceFileResponse({
      allow: ["tasks/**/*.json"],
      path: "secret.txt",
      root: "tasks",
      workspace: "files",
    })).rejects.toMatchObject({ statusCode: 404 })
  })

  it("mounts inline files at the workspace root", async () => {
    registerWorkspace("root-file", defineWorkspace({
      store: { provider: "memory" },
      sources: {
        instructions: file({
          mount: "",
          workspacePath: "AGENTS.md",
          content: "# Instructions\n",
        }),
      },
    }))

    const workspace = useWorkspace("root-file", { mode: "write" })

    expect(await workspace.fs.readFile("AGENTS.md")).toBe("# Instructions\n")
    expect(await workspace.fs.list()).toEqual([
      expect.objectContaining({ path: "AGENTS.md", type: "file" }),
    ])
    await expect(workspace.fs.exists("instructions/AGENTS.md")).resolves.toBe(false)
  })

  it("keeps inline files root mounted when mount options omit a path", async () => {
    registerWorkspace("root-file-mount-options", defineWorkspace({
      store: { provider: "memory" },
      sources: {
        instructions: file({
          mount: { materialize: "lazy" },
          workspacePath: "AGENTS.md",
          content: "# Instructions\n",
        }),
      },
    }))

    const workspace = useWorkspace("root-file-mount-options", { mode: "write" })

    expect(await workspace.fs.readFile("AGENTS.md")).toBe("# Instructions\n")
    await expect(workspace.fs.exists("instructions/AGENTS.md")).resolves.toBe(false)
  })

  it("reads local file sources from the workspace source root", async () => {
    const root = await createRoot()
    const sourceRoot = join(root, "server", "agents", "docs", "workspace")
    await mkdir(sourceRoot, { recursive: true })
    await writeFile(join(sourceRoot, "AGENTS.md"), "# Agent\n")

    registerWorkspace("source-root-file", defineWorkspace({
      rootDir: sourceRoot,
      store: { provider: "memory" },
      sources: {
        instructions: file("AGENTS.md"),
      },
    }))

    const workspace = useWorkspace("source-root-file")

    expect(await workspace.fs.readFile("AGENTS.md")).toBe("# Agent\n")
    await expect(workspace.fs.exists("instructions/AGENTS.md")).resolves.toBe(false)
  })

  it("preserves nested local file source paths in the workspace", async () => {
    const root = await createRoot()
    const sourceRoot = join(root, "server", "agents", "review", "workspace")
    await mkdir(join(sourceRoot, ".agents", "summary"), { recursive: true })
    await writeFile(join(sourceRoot, ".agents", "summary", "AGENTS.md"), "# Summary\n")

    registerWorkspace("nested-source-file", defineWorkspace({
      rootDir: sourceRoot,
      store: { provider: "memory" },
      sources: {
        summaryInstructions: file(".agents/summary/AGENTS.md"),
      },
    }))

    const workspace = useWorkspace("nested-source-file")

    expect(await workspace.fs.readFile(".agents/summary/AGENTS.md")).toBe("# Summary\n")
    await expect(workspace.fs.exists("AGENTS.md")).resolves.toBe(false)
  })

  it("keeps runtime-injected source roots on colocated agent workspaces", async () => {
    const root = await createRoot()
    const sourceRoot = join(root, "server", "agents", "support", "workspace")
    await mkdir(sourceRoot, { recursive: true })
    await writeFile(join(root, "AGENTS.md"), "# Project\n")
    await writeFile(join(sourceRoot, "AGENTS.md"), "# Support\n")

    setWorkspaceRegistry({
      support: async () => ({
        default: {
          rootDir: root,
          sourceRootDir: sourceRoot,
          __vitehubWorkspaceAgentOptions: {
            workspace: {
              rootDir: root,
              store: { provider: "memory" },
              sources: {
                instructions: file("AGENTS.md"),
              },
            },
          },
        } as never,
      }),
    })

    const workspace = useWorkspace("support")

    expect(await workspace.fs.readFile("AGENTS.md")).toBe("# Support\n")
  })

  it("rejects unsafe local file source paths", () => {
    expect(() => file("/AGENTS.md")).toThrow()
    expect(() => file("C:/Users/maxi/AGENTS.md")).toThrow()
    expect(() => file("../AGENTS.md")).toThrow()
  })

  it("enforces workspace rules before writes reach the store", async () => {
    registerWorkspace("rules", defineWorkspace({
      store: { provider: "memory" },
      rules: {
        "/**": { write: false },
        "/generated/**": { maxBytes: "1kb", write: true },
        "/docs/**/*.md": {
          mediaType: "text/markdown",
          validate(input) {
            if (typeof input.content === "string" && input.content.includes("<script")) return false
          },
          write: true,
        },
      },
    }))

    const workspace = useWorkspace("rules", { mode: "write" })

    await expect(workspace.fs.writeFile("README.md", "# Blocked\n")).rejects.toThrow("does not allow writeFile")
    await expect(workspace.fs.writeFile("generated/result.txt", "ok")).resolves.toBe("generated/result.txt")
    await expect(workspace.fs.writeFile("generated/large.txt", "x".repeat(1025))).rejects.toThrow("limits writes")
    await expect(workspace.fs.writeFile("docs/guide.md", "# Guide\n", { mediaType: "text/plain" })).rejects.toThrow("does not allow media type")
    await expect(workspace.fs.writeFile("docs/guide.md", "<script />\n", { mediaType: "text/markdown" })).rejects.toThrow("validator rejected")
    await expect(workspace.fs.writeFile("docs/guide.md", "# Guide\n", { mediaType: "text/markdown" })).resolves.toBe("docs/guide.md")
  })

  it("merges workspace plugin rules and hooks into the write pipeline", async () => {
    const events: string[] = []
    registerWorkspace("plugin-rules", defineWorkspace({
      store: { provider: "memory" },
      plugins: [{
        id: "docs",
        hooks: {
          "write:after": ({ operation, path }) => {
            events.push(`${operation}:${path}`)
          },
        },
        rules: {
          "/docs/**": { write: true },
        },
      }],
      rules: {
        "/**": { write: false },
      },
    }))

    const workspace = useWorkspace("plugin-rules", { mode: "write" })

    await workspace.fs.writeFile("docs/notes.md", "notes")
    await expect(workspace.fs.writeFile("tmp/notes.md", "notes")).rejects.toThrow("does not allow writeFile")
    expect(events).toEqual(["writeFile:docs/notes.md"])
  })

  it("uses the read-only facade for bundled assets", async () => {
    setWorkspaceRuntimeAssetsRegistry({
      docs: createWorkspaceAssets({
        "README.md": { load: async () => "# Docs\n" },
      }),
    })

    const workspace = useWorkspace("docs")

    await expect(workspace.fs.readFile("README.md")).resolves.toBe("# Docs\n")
    await expect(workspace.fs.readFile("missing.md" as never)).rejects.toThrow("Workspace file does not exist: missing.md")
    await expect(workspace.fs.exists("README.md")).resolves.toBe(true)
    await expect(workspace.fs.exists("missing.md" as never)).resolves.toBe(false)
    await expect(workspace.fs.list()).resolves.toEqual([
      expect.objectContaining({ path: "README.md", type: "file" }),
    ])
    await expect(workspace.fs.glob("README.md")).resolves.toEqual([
      expect.objectContaining({ path: "README.md", type: "file" }),
    ])
    await expect(workspace.fs.stat("README.md")).resolves.toMatchObject({ path: "README.md", type: "file" })
    await expect(workspace.fs.stat("missing.md" as never)).rejects.toThrow("Workspace file does not exist: missing.md")
  })

  it("merges bundled assets with lazy runtime sources in the read-only facade", async () => {
    setWorkspaceRuntimeAssetsRegistry({
      docs: createWorkspaceAssets({
        "AGENTS.md": { load: async () => "# Instructions\n" },
      }),
    })
    setWorkspaceRegistry({
      docs: async () => ({ default: defineWorkspace({
        store: { provider: "memory" },
        sources: {
          repo: file({
            content: "# Repo\n",
            materialize: "lazy",
            mount: "repo",
            workspacePath: "README.md",
          }),
        },
      }) }),
    })

    const workspace = useWorkspace("docs")

    await expect(workspace.fs.readFile("AGENTS.md")).resolves.toBe("# Instructions\n")
    await expect(workspace.fs.readFile("repo/README.md")).resolves.toBe("# Repo\n")
    await expect(workspace.fs.exists("repo/README.md")).resolves.toBe(true)
    await expect(workspace.fs.list("", { recursive: true })).resolves.toEqual([
      expect.objectContaining({ path: "AGENTS.md", type: "file" }),
      expect.objectContaining({ path: "repo", type: "directory" }),
      expect.objectContaining({ path: "repo/README.md", type: "file" }),
    ])
  })

  it("caps merged read-only search results", async () => {
    setWorkspaceRuntimeAssetsRegistry({
      docs: createWorkspaceAssets({
        "AGENTS.md": { load: async () => "needle in assets\n" },
      }),
    })
    setWorkspaceRegistry({
      docs: async () => ({ default: defineWorkspace({
        store: { provider: "memory" },
        sources: {
          repo: file({
            content: "needle in runtime\n",
            materialize: "lazy",
            mount: "repo",
            workspacePath: "README.md",
          }),
        },
      }) }),
    })

    const workspace = useWorkspace("docs")

    await expect(workspace.fs.search({ limit: 1, pattern: "needle" })).resolves.toHaveLength(1)
  })

  it("shares runtime setup across duplicate package instances", async () => {
    const runtimeRoot = await createRoot()
    const configA = await import(`${new URL("../src/runtime/config.ts", import.meta.url).href}?copy=config-a`) as typeof import("../src/runtime/config.ts")
    const configB = await import(`${new URL("../src/runtime/config.ts", import.meta.url).href}?copy=config-b`) as typeof import("../src/runtime/config.ts")
    const registryA = await import(`${new URL("../src/core/registry.ts", import.meta.url).href}?copy=registry-a`) as typeof import("../src/core/registry.ts")
    const registryB = await import(`${new URL("../src/core/registry.ts", import.meta.url).href}?copy=registry-b`) as typeof import("../src/core/registry.ts")
    const assetsA = await import(`${new URL("../src/asset-registry.ts", import.meta.url).href}?copy=assets-a`) as typeof import("../src/asset-registry.ts")
    const assetsB = await import(`${new URL("../src/asset-registry.ts", import.meta.url).href}?copy=assets-b`) as typeof import("../src/asset-registry.ts")
    const hostedStoreA = await import(`${new URL("../src/runtime/hosted-store-loader.ts", import.meta.url).href}?copy=hosted-store-a`) as typeof import("../src/runtime/hosted-store-loader.ts")
    const hostedStoreB = await import(`${new URL("../src/runtime/hosted-store-loader.ts", import.meta.url).href}?copy=hosted-store-b`) as typeof import("../src/runtime/hosted-store-loader.ts")
    const serverA = await import(`${new URL("../src/server.ts", import.meta.url).href}?copy=server-a`) as typeof import("../src/server.ts")
    const serverB = await import(`${new URL("../src/server.ts", import.meta.url).href}?copy=server-b`) as typeof import("../src/server.ts")

    configA.setWorkspaceRuntimeConfig({ root: runtimeRoot, store: { provider: "local" } })
    expect(configB.getWorkspaceRuntimeConfig()).toEqual({ root: runtimeRoot, store: { provider: "local" } })

    registryA.setWorkspaceRegistry({
      shared: async () => ({ default: defineWorkspace({ store: { provider: "memory" } }) }),
    })
    await expect(registryB.useRegisteredWorkspace("shared")).resolves.toMatchObject({ name: "shared" })

    assetsA.setWorkspaceAssetsRegistry({
      shared: createWorkspaceAssets({
        "README.md": { load: async () => "# Shared\n" },
      }),
    })
    await expect(assetsB.useWorkspaceAssets("shared").readFile("README.md")).resolves.toBe("# Shared\n")

    const loader = (() => {
      throw new Error("unused")
    }) as never
    hostedStoreA.setWorkspaceHostedStoreLoader(loader)
    expect(hostedStoreB.getWorkspaceHostedStoreLoader()).toBe(loader)

    const tokenOptions = { serverId: "shared-dev-server" }
    const token = await serverA.refreshWorkspaceDevToken(runtimeRoot, tokenOptions)
    await expect(serverB.validateWorkspaceDevToken(runtimeRoot, new Headers({
      [serverB.workspaceDevTokenHeader]: token,
    }), tokenOptions)).resolves.toBe(true)
  })

  it("uses runtime workspace root for default local stores", async () => {
    const root = await createRoot()
    const configuredRoot = join(root, "runtime-workspaces")
    await mkdir(configuredRoot, { recursive: true })
    setWorkspaceRuntimeConfig({ root: configuredRoot, store: { provider: "local" } })

    registerWorkspace("runtime-root", defineWorkspace({
      rootDir: root,
    }))

    const workspace = useWorkspace("runtime-root", { mode: "write" })
    await workspace.fs.writeFile("notes.md", "runtime")

    await expect(readFile(join(configuredRoot, "runtime-root", "notes.md"), "utf8")).resolves.toBe("runtime")
  })

  it("injects inferred names when loading registry definitions", async () => {
    setWorkspaceRegistry({
      docs: async () => ({ default: defineWorkspace({ store: { provider: "memory" } }) }),
    })

    const workspace = useWorkspace("docs", { mode: "write" })
    await expect(workspace.fs.list()).resolves.toEqual([])
  })

  it("refreshes loader-backed workspace definitions when the registry changes", async () => {
    setWorkspaceRegistry({
      docs: async () => ({ default: defineWorkspace({
        store: { provider: "memory" },
        sources: {
          docs: file({
            workspacePath: "README.md",
            content: "v1\n",
          }),
        },
      }) }),
    })

    const first = useWorkspace("docs", { mode: "write" })
    expect(await first.fs.readFile("README.md")).toBe("v1\n")

    setWorkspaceRegistry({
      docs: async () => ({ default: defineWorkspace({
        store: { provider: "memory" },
        sources: {
          docs: file({
            workspacePath: "README.md",
            content: "v2\n",
          }),
        },
      }) }),
    })

    const second = useWorkspace("docs", { mode: "write" })
    expect(await second.fs.readFile("README.md")).toBe("v2\n")
  })
})
