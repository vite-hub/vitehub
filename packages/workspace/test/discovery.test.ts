import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { createSource, file, glob } from "@vite-hub/source"
import { afterEach, describe, expect, it } from "vitest"

import { createWorkspaceRegistryContents, createWorkspaceVirtualRegistryContents, discoverServerWorkspaceDefinitions, discoverViteWorkspaceDefinitions } from "../src/build/discovery.ts"

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
  it("uses forwarded server directories for Vite discovery", async () => {
    const root = await createRoot()
    const serverDir = join(root, "backend")
    await mkdir(join(serverDir, "workspaces"), { recursive: true })
    await writeFile(join(serverDir, "workspaces", "docs.ts"), "export default {}\n", "utf8")

    expect(discoverViteWorkspaceDefinitions(root, { serverDirs: [serverDir] })).toEqual([
      expect.objectContaining({
        handler: join(serverDir, "workspaces", "docs.ts"),
        name: "docs",
      }),
    ])
  })

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
    expect(contents).toContain('["docs"]: async () => {')
    expect(contents).toContain("const mod = await import(")
  })

  it.each(["file", "virtual"] as const)("loads a discovered __proto__ definition from the %s registry", async (kind) => {
    const root = await createRoot()
    const registryFile = join(root, "registry.mjs")
    await writeFile(join(root, "server", "workspaces", "__proto__.mjs"), 'export default { label: "prototype workspace" }\n')
    const definitions = discoverServerWorkspaceDefinitions(root)
    expect(definitions.map(definition => definition.name)).toEqual(["__proto__"])
    const contents = kind === "file"
      ? createWorkspaceRegistryContents(registryFile, definitions)
      : createWorkspaceVirtualRegistryContents(definitions)
    await writeFile(registryFile, contents)

    const { default: registry }: { default: Record<string, () => Promise<{ default: { label: string } }>> } = await import(pathToFileURL(registryFile).href)

    expect(Object.keys(registry)).toEqual(["__proto__"])
    expect(Object.getPrototypeOf(registry)).toBe(Object.prototype)
    await expect(registry["__proto__"]!()).resolves.toMatchObject({ default: { label: "prototype workspace" } })
  })

  it.each(["docs.mjs", "docs/config.mjs"])("preserves explicit sourceRootDir values in %s", async (modulePath) => {
    const root = await createRoot()
    const registryFile = join(root, "registry.mjs")
    await mkdir(join(root, "server", "workspaces", "docs"), { recursive: true })
    await writeFile(join(root, "server", "workspaces", modulePath), "export default { sourceRootDir: '/custom/docs' }\n", "utf8")

    const contents = createWorkspaceRegistryContents(registryFile, discoverServerWorkspaceDefinitions(root))
    await writeFile(registryFile, contents)
    const { default: registry }: { default: Record<string, () => Promise<{ default: { sourceRootDir: string } }>> } = await import(pathToFileURL(registryFile).href)

    await expect(registry["docs"]!()).resolves.toMatchObject({ default: { sourceRootDir: "/custom/docs" } })
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

  it("sets the Source root of flat Workspace files to the project root", async () => {
    const root = await createRoot()
    await writeFile(join(root, "server", "workspaces", "docs.ts"), "export default {}\n", "utf8")

    const [definition] = discoverServerWorkspaceDefinitions(root)

    expect(definition).toMatchObject({ name: "docs", source: "server-workspaces" })
    expect(definition).toHaveProperty("sourceRootDir", root)
  })

  it.each(["file", "virtual"] as const)("reads flat Workspace Sources from the project root through the %s registry", async (kind) => {
    const root = await createRoot()
    const viteRoot = join(root, "app")
    await mkdir(viteRoot)
    await mkdir(join(root, "docs"))
    await writeFile(join(root, "docs", "intro.md"), "Project docs\n")
    await writeFile(join(root, "server", "workspaces", "docs.mjs"), "export default {}\n")
    const definitions = discoverViteWorkspaceDefinitions(viteRoot, { serverRootDir: root })
    const registryFile = join(root, "registry.mjs")
    await writeFile(registryFile, kind === "file"
      ? createWorkspaceRegistryContents(registryFile, definitions)
      : createWorkspaceVirtualRegistryContents(definitions))
    const { default: registry }: { default: Record<string, () => Promise<{ default: { sourceRootDir?: string } }>> } = await import(pathToFileURL(registryFile).href)
    const { default: workspace } = await registry["docs"]!()

    await expect(createSource(file({ path: "docs/intro.md" }), workspace).read("docs/intro.md")).resolves.toBe("Project docs\n")
    await expect(createSource(glob({ cwd: "docs", include: "**/*.md" }), workspace).read("intro.md")).resolves.toBe("Project docs\n")
  })

  it.each([false, true])("preserves colocated Source roots for flat Nuxt layer Workspaces (workspace folder: %s)", async (workspaceFolder) => {
    const root = await createRoot()
    const layerRoot = await createRoot()
    const serverDir = join(root, "backend")
    const layerWorkspacesDir = join(layerRoot, "server", "workspaces")
    const sourceRootDir = workspaceFolder ? join(layerWorkspacesDir, "workspace") : layerWorkspacesDir
    await mkdir(join(serverDir, "workspaces"), { recursive: true })
    await mkdir(sourceRootDir, { recursive: true })
    await writeFile(join(serverDir, "workspaces", "app.mjs"), "export default {}\n")
    await writeFile(join(layerWorkspacesDir, "docs.mjs"), "export default {}\n")
    await writeFile(join(root, "README.md"), "Application docs\n")
    await writeFile(join(sourceRootDir, "README.md"), "Layer docs\n")

    const definitions = discoverViteWorkspaceDefinitions(root, { serverDirs: [serverDir, join(layerRoot, "server")] })
    const registryFile = join(root, "registry.mjs")
    await writeFile(registryFile, createWorkspaceRegistryContents(registryFile, definitions))
    const { default: registry }: { default: Record<string, () => Promise<{ default: { sourceRootDir?: string } }>> } = await import(pathToFileURL(registryFile).href)
    const { default: workspace } = await registry["docs"]!()

    expect(workspace.sourceRootDir).toBe(sourceRootDir)
    await expect(createSource(file({ path: "README.md" }), workspace).read("README.md")).resolves.toBe("Layer docs\n")
    expect(definitions.find(definition => definition.name === "app")).toHaveProperty("sourceRootDir", root)
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
