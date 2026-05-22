import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { createWorkspaceRegistryContents, discoverNitroWorkspaceDefinitions } from "../src/discovery.ts"

const tempDirs: string[] = []

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-discovery-"))
  tempDirs.push(root)
  await mkdir(join(root, "server", "workspaces"), { recursive: true })
  return root
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe("discoverNitroWorkspaceDefinitions", () => {
  it("discovers directory workspaces from config files and ignores nested source files inside them", async () => {
    const root = await createRoot()
    await mkdir(join(root, "server", "workspaces", "data-sources"), { recursive: true })
    await writeFile(join(root, "server", "workspaces", "data-sources", "config.ts"), "export default {}\n", "utf8")
    await writeFile(join(root, "server", "workspaces", "data-sources", "helper.ts"), "export default {}\n", "utf8")
    await writeFile(join(root, "server", "workspaces", "docs.ts"), "export default {}\n", "utf8")

    expect(discoverNitroWorkspaceDefinitions(root)).toEqual([
      expect.objectContaining({
        handler: join(root, "server", "workspaces", "data-sources", "config.ts"),
        name: "data-sources",
      }),
      expect.objectContaining({
        handler: join(root, "server", "workspaces", "docs.ts"),
        name: "docs",
      }),
    ])
  })

  it("throws when a directory config and flat workspace file resolve to the same name", async () => {
    const root = await createRoot()
    await mkdir(join(root, "server", "workspaces", "docs"), { recursive: true })
    await writeFile(join(root, "server", "workspaces", "docs.ts"), "export default {}\n", "utf8")
    await writeFile(join(root, "server", "workspaces", "docs", "config.ts"), "export default {}\n", "utf8")

    expect(() => discoverNitroWorkspaceDefinitions(root)).toThrow('Duplicate workspace name "docs"')
  })

  it("does not discover deprecated dot config files", async () => {
    const root = await createRoot()
    await mkdir(join(root, "server", "workspaces", "docs"), { recursive: true })
    await writeFile(join(root, "server", "workspaces", "docs", ".config.ts"), "export default {}\n", "utf8")

    expect(discoverNitroWorkspaceDefinitions(root)).toEqual([])
  })

  it("creates registry entries from discovered workspace definitions", async () => {
    const root = await createRoot()
    const registryFile = join(root, ".vitehub", "workspace", "registry.mjs")
    await writeFile(join(root, "server", "workspaces", "docs.ts"), "export default {}\n", "utf8")

    expect(createWorkspaceRegistryContents(registryFile, discoverNitroWorkspaceDefinitions(root))).toContain(
      '"docs": async () => import(',
    )
  })

  it("discovers workspace definitions colocated with directory agents", async () => {
    const root = await createRoot()
    await mkdir(join(root, "server", "agents", "docs"), { recursive: true })
    await writeFile(join(root, "server", "agents", "docs", "config.ts"), "export default defineAgent({ workspace: {}, model })\n", "utf8")

    expect(discoverNitroWorkspaceDefinitions(root)).toEqual([
      expect.objectContaining({
        handler: join(root, "server", "agents", "docs", "config.ts"),
        name: "docs",
        source: "nitro-server-agent-workspaces",
      }),
    ])
  })

  it("rejects agent definitions inside workspace configs", async () => {
    const root = await createRoot()
    await mkdir(join(root, "server", "workspaces", "docs"), { recursive: true })
    await writeFile(join(root, "server", "workspaces", "docs", "config.ts"), "export default defineAgent({ workspace: {}, model })\n", "utf8")

    expect(() => discoverNitroWorkspaceDefinitions(root)).toThrow("defineAgent() belongs in server/agents/<name>/config.ts")
  })
})
