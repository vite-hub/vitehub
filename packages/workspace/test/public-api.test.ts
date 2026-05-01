import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach } from "vitest"
import { describe, expect, it } from "vitest"

import { defineWorkspace, loader, registerWorkspace, source, useWorkspace } from "../src/index.ts"
import { setWorkspaceRuntimeConfig } from "../src/runtime/state.ts"

const tempDirs: string[] = []

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-api-"))
  tempDirs.push(root)
  return root
}

afterEach(async () => {
  setWorkspaceRuntimeConfig(false)
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe("workspace public API", () => {
  it("defines, registers, syncs, and uses a workspace", async () => {
    registerWorkspace(defineWorkspace({
      name: "api",
      store: { provider: "memory" },
      sources: [
        source.markdown({
          path: "README.md",
          workspacePath: "README.md",
          content: "# API\n",
        }),
      ],
      loaders: [loader.files()],
    }))

    const workspace = await useWorkspace("api")
    await workspace.sync()
    await workspace.writeFile("generated/summary.md", "summary")

    expect(await workspace.readFile("README.md")).toBe("# API\n")
    expect(await workspace.exists("generated/summary.md")).toBe(true)
    expect(await workspace.glob("**/*.md")).toHaveLength(2)
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
    setWorkspaceRuntimeConfig({ root: configuredRoot })

    registerWorkspace(defineWorkspace({
      name: "runtime-root",
      rootDir: root,
    }))

    const workspace = await useWorkspace("runtime-root")
    await workspace.writeFile("notes.md", "runtime")

    await expect(readFile(join(configuredRoot, "runtime-root", "notes.md"), "utf8")).resolves.toBe("runtime")
  })
})
