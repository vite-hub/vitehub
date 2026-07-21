import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { createWorkspaceRegistryContents, discoverServerWorkspaceDefinitions } from "../src/build/discovery.ts"

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

describe("discoverServerWorkspaceDefinitions", () => {
  it("discovers directory workspaces from config files and ignores nested source files inside them", async () => {
    const root = await createRoot()
    await mkdir(join(root, "server", "workspaces", "data-sources"), { recursive: true })
    await writeFile(join(root, "server", "workspaces", "data-sources", "config.ts"), "export default {}\n", "utf8")
    await writeFile(join(root, "server", "workspaces", "data-sources", "helper.ts"), "export default {}\n", "utf8")
    await writeFile(join(root, "server", "workspaces", "docs.ts"), "export default {}\n", "utf8")

    expect(discoverServerWorkspaceDefinitions(root)).toEqual([
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

    expect(() => discoverServerWorkspaceDefinitions(root)).toThrow('Duplicate workspace name "docs"')
  })

  it("creates registry entries from discovered workspace definitions", async () => {
    const root = await createRoot()
    const registryFile = join(root, ".vitehub", "workspace", "registry.mjs")
    await writeFile(join(root, "server", "workspaces", "docs.ts"), "export default {}\n", "utf8")

    const contents = createWorkspaceRegistryContents(registryFile, discoverServerWorkspaceDefinitions(root))
    expect(contents).toContain('"docs": async () => {')
    expect(contents).toContain("const mod = await import(")
  })

  it("preserves explicit sourceRootDir values in workspace modules", async () => {
    const root = await createRoot()
    const registryFile = join(root, ".vitehub", "workspace", "registry.mjs")
    await writeFile(join(root, "server", "workspaces", "docs.ts"), "export default { sourceRootDir: '/custom/docs' }\n", "utf8")

    const contents = createWorkspaceRegistryContents(registryFile, discoverServerWorkspaceDefinitions(root))

    expect(contents).toContain("sourceRootDir: mod.default.sourceRootDir ??")
  })

  it("applies resolved store overrides to Workspace Agent options", async () => {
    const root = await createRoot()
    const registryFile = join(root, ".vitehub", "workspace", "registry.mjs")
    await mkdir(join(root, "server", "agents", "docs"), { recursive: true })
    await writeFile(join(root, "server", "agents", "docs", "agent.ts"), "export default defineAgent({ workspace: { store: { provider: 'cloudflare-artifacts' } } })\n", "utf8")
    const definitions = discoverServerWorkspaceDefinitions(root)
    const store = { binding: "ENV_ARTIFACTS", namespace: "environment", provider: "cloudflare-artifacts" }

    const contents = createWorkspaceRegistryContents(registryFile, definitions, new Map([["docs", { store }]]))

    expect(contents).toContain("workspace: { ...mod.default.__vitehubWorkspaceAgentOptions.workspace, store:")
    expect(contents).toContain('"binding":"ENV_ARTIFACTS"')
  })

  it("uses config directory when sibling workspace path is not a directory", async () => {
    const root = await createRoot()
    const directory = join(root, "server", "workspaces", "docs")
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, "config.ts"), "export default {}\n", "utf8")
    await writeFile(join(directory, "workspace"), "not a directory\n", "utf8")

    expect(discoverServerWorkspaceDefinitions(root)).toEqual([
      expect.objectContaining({
        handler: join(directory, "config.ts"),
        name: "docs",
        sourceRootDir: directory,
      }),
    ])
  })

  it("discovers workspace definitions colocated with directory agents", async () => {
    const root = await createRoot()
    await mkdir(join(root, "server", "agents", "docs", "workspace"), { recursive: true })
    await writeFile(join(root, "server", "agents", "docs", "agent.ts"), "export default defineAgent({ workspace: {}, model })\n", "utf8")

    expect(discoverServerWorkspaceDefinitions(root)).toEqual([
      expect.objectContaining({
        handler: join(root, "server", "agents", "docs", "agent.ts"),
        name: "docs",
        source: "server-agent-workspaces",
        sourceRootDir: join(root, "server", "agents", "docs", "workspace"),
      }),
    ])
  })

  it("rejects agent definitions inside workspace configs", async () => {
    const root = await createRoot()
    await mkdir(join(root, "server", "workspaces", "docs"), { recursive: true })
    await writeFile(join(root, "server", "workspaces", "docs", "config.ts"), "export default defineAgent({ workspace: {}, model })\n", "utf8")

    expect(() => discoverServerWorkspaceDefinitions(root)).toThrow("defineAgent() belongs in server/agents/<name>/agent.ts")
  })
})
