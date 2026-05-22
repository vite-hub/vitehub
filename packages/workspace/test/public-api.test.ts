import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { resetWorkspaceAssetsRegistry } from "../src/asset-registry.ts"
import { defineWorkspace, source, useWorkspace } from "../src/index.ts"
import { registerWorkspace } from "../src/test.ts"
import { resetWorkspaceRegistry, setWorkspaceRegistry } from "../src/core/registry.ts"
import { createWorkspaceAssets } from "../src/runtime/assets.ts"
import { setWorkspaceRuntimeAssetsRegistry, setWorkspaceRuntimeConfig } from "../src/runtime/state.ts"

const tempDirs: string[] = []

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-api-"))
  tempDirs.push(root)
  return root
}

afterEach(async () => {
  resetWorkspaceAssetsRegistry()
  resetWorkspaceRegistry()
  setWorkspaceRuntimeConfig(false)
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe("workspace public API", () => {
  it("rejects authored workspace names", () => {
    expect(() => defineWorkspace({ name: "api" } as never)).toThrow("Workspace names are inferred")
  })

  it("uses the writable facade for synced reads and writes", async () => {
    registerWorkspace("api", defineWorkspace({
      store: { provider: "memory" },
      sources: {
        docs: source.file({
          workspacePath: "README.md",
          content: "# API\n",
        }),
        agents: source.file({
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

  it("mounts inline files at the workspace root", async () => {
    registerWorkspace("root-file", defineWorkspace({
      store: { provider: "memory" },
      sources: {
        instructions: source.file({
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
        instructions: source.file({
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
        instructions: source.file("AGENTS.md"),
      },
    }))

    const workspace = useWorkspace("source-root-file")

    expect(await workspace.fs.readFile("AGENTS.md")).toBe("# Agent\n")
    await expect(workspace.fs.exists("instructions/AGENTS.md")).resolves.toBe(false)
  })

  it("rejects unsafe local file source paths", () => {
    expect(() => source.file("/AGENTS.md")).toThrow()
    expect(() => source.file("C:/Users/maxi/AGENTS.md")).toThrow()
    expect(() => source.file("../AGENTS.md")).toThrow()
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
    await expect(workspace.fs.writeFile("generated/result.txt", "ok")).resolves.toBeUndefined()
    await expect(workspace.fs.writeFile("generated/large.txt", "x".repeat(1025))).rejects.toThrow("limits writes")
    await expect(workspace.fs.writeFile("docs/guide.md", "# Guide\n", { mediaType: "text/plain" })).rejects.toThrow("does not allow media type")
    await expect(workspace.fs.writeFile("docs/guide.md", "<script />\n", { mediaType: "text/markdown" })).rejects.toThrow("validator rejected")
    await expect(workspace.fs.writeFile("docs/guide.md", "# Guide\n", { mediaType: "text/markdown" })).resolves.toBeUndefined()
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
          repo: source.file({
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
          repo: source.file({
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
          docs: source.file({
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
          docs: source.file({
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
