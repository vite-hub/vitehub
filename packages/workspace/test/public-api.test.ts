import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach } from "vitest"
import { describe, expect, it } from "vitest"

import { useWorkspaceAssets } from "../src/assets.ts"
import { defineWorkspace, registerWorkspace, source, useWorkspace } from "../src/index.ts"
import { resetWorkspaceAssetsRegistry } from "../src/asset-registry.ts"
import { resetWorkspaceRegistry, setWorkspaceRegistry } from "../src/registry.ts"
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

  it("defines, registers, syncs, and uses a workspace", async () => {
    registerWorkspace("api", defineWorkspace({
      store: { provider: "memory" },
      sources: [
        source.file({
          path: "README.md",
          workspacePath: "README.md",
          content: "# API\n",
        }),
        source.file({
          workspacePath: "AGENTS.md",
          content: "# Instructions\n",
        }),
      ],
    }))

    const workspace = await useWorkspace("api")
    await workspace.sync()
    await workspace.writeFile("generated/summary.md", "summary")

    expect(await workspace.readFile("README.md")).toBe("# API\n")
    expect(await workspace.readFile("AGENTS.md")).toBe("# Instructions\n")
    await expect(workspace.stat("AGENTS.md")).resolves.toMatchObject({ mediaType: "text/markdown" })
    expect(await workspace.exists("generated/summary.md")).toBe(true)
    expect(await workspace.glob("**/*.md")).toHaveLength(3)
    expect(workspace.mount({ mode: "copy-on-write" })).toMatchObject({
      mode: "copy-on-write",
      target: "/workspace",
    })

    const defaultSession = await workspace.open()
    expect(defaultSession.exec).toBeUndefined()
    const localSession = await workspace.open({ runtime: "local" })
    expect(localSession.exec).toEqual(expect.any(Function))
  })

  it("uses runtime workspace root for default local stores", async () => {
    const root = await createRoot()
    const configuredRoot = join(root, "runtime-workspaces")
    await mkdir(configuredRoot, { recursive: true })
    setWorkspaceRuntimeConfig({ root: configuredRoot, store: { provider: "local" } })

    registerWorkspace("runtime-root", defineWorkspace({
      rootDir: root,
    }))

    const workspace = await useWorkspace("runtime-root")
    await workspace.writeFile("notes.md", "runtime")

    await expect(readFile(join(configuredRoot, "runtime-root", "notes.md"), "utf8")).resolves.toBe("runtime")
  })

  it("injects inferred names when loading registry definitions", async () => {
    setWorkspaceRegistry({
      docs: async () => ({ default: defineWorkspace({ store: { provider: "memory" } }) }),
    })

    const workspace = await useWorkspace("docs")

    expect(workspace.name).toBe("docs")
  })

  it("refreshes loader-backed workspace definitions when the registry changes", async () => {
    setWorkspaceRegistry({
      docs: async () => ({ default: defineWorkspace({
        store: { provider: "memory" },
        sources: [
          source.file({
            workspacePath: "README.md",
            content: "v1\n",
          }),
        ],
      }) }),
    })

    const first = await useWorkspace("docs")
    await first.sync()
    expect(await first.readFile("README.md")).toBe("v1\n")

    setWorkspaceRegistry({
      docs: async () => ({ default: defineWorkspace({
        store: { provider: "memory" },
        sources: [
          source.file({
            workspacePath: "README.md",
            content: "v2\n",
          }),
        ],
      }) }),
    })

    const second = await useWorkspace("docs")
    await second.sync()
    expect(await second.readFile("README.md")).toBe("v2\n")
  })

  it("reads workspace assets from the runtime asset registry", async () => {
    setWorkspaceRuntimeAssetsRegistry({
      docs: {
        async getKeys() {
          return ["README.md"]
        },
        async getItem<T>(key: string) {
          return (key === "README.md" ? "# Docs\n" : null) as T | null
        },
      },
    })

    const assets = useWorkspaceAssets("docs")

    await expect(assets.getKeys()).resolves.toEqual(["README.md"])
    await expect(assets.getItem<string>("README.md")).resolves.toBe("# Docs\n")
    await expect(assets.getItem("missing.md")).resolves.toBeNull()
  })
})
