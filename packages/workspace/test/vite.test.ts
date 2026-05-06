import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { afterEach, describe, expect, it } from "vitest"

const tempDirs: string[] = []

async function createViteRoot() {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-workspace-vite-"))
  tempDirs.push(rootDir)
  await mkdir(join(rootDir, "src"), { recursive: true })
  await mkdir(join(rootDir, "workspaces"), { recursive: true })
  await writeFile(join(rootDir, "src/docs.workspace.ts"), [
    `import { defineWorkspace } from "@vitehub/workspace"`,
    `export default defineWorkspace({})`,
    ``,
  ].join("\n"))
  await writeFile(join(rootDir, "workspaces/ignored.ts"), [
    `import { defineWorkspace } from "@vitehub/workspace"`,
    `export default defineWorkspace({})`,
    ``,
  ].join("\n"))
  return rootDir
}

async function createViteAssetRoot() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-vite-assets-"))
  tempDirs.push(root)
  await mkdir(join(root, "src"), { recursive: true })
  for (const name of ["docs", "notes"]) {
    await writeFile(join(root, "src", `${name}.workspace.mjs`), [
      `export default {`,
      `  store: { provider: "memory" },`,
      `  sources: {`,
      `    files: {`,
      `      name: "inline",`,
      `      async getKeys() { return ["README.md"] },`,
      `      async getItem(key) { return { key, path: key, content: "${name}\\n" } },`,
      `    },`,
      `  },`,
      `}`,
      ``,
    ].join("\n"))
  }
  return root
}

afterEach(async () => {
  delete process.env.VITEHUB_WORKSPACE_DEV
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe("hubWorkspace", () => {
  it("attaches Nitro, noExternal, and virtual workspace manifests", async () => {
    const root = await createViteRoot()
    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace()
    const configResolved = plugin.configResolved as (config: { root: string }) => Promise<void>
    const configEnvironment = plugin.configEnvironment as (name: string, environment: { consumer: "client" | "server", resolve?: { noExternal?: string[] } }) => unknown
    const resolveId = plugin.resolveId as (id: string) => string | undefined
    const load = plugin.load as (id: string) => string | undefined

    await configResolved({ root } as never)

    expect(plugin.nitro.name).toBe("@vitehub/workspace")
    expect(process.env.VITEHUB_WORKSPACE_DEV).toBe("true")
    expect(configEnvironment("ssr", { consumer: "server" })).toEqual({
      resolve: { noExternal: ["@vitehub/workspace"] },
    })
    await expect(readFile(join(root, "src", "vitehub-workspace.d.ts"), "utf8")).resolves.toContain('"docs": true')

    const rootId = resolveId("virtual:vitehub/workspaces")!
    expect(load(rootId)).toContain('"docs"')
    expect(load(rootId)).not.toContain('"ignored"')
    const docsId = resolveId("virtual:vitehub/workspaces/docs")!
    expect(load(docsId)).toContain('"entries":[]')
    const registryId = resolveId("#vitehub-workspace-registry")!
    expect(load(registryId)).toContain('"docs": async () => import(')
  })

  it("emits build-time workspace assets for Vite builds", async () => {
    const root = await createViteAssetRoot()

    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace()
    const configResolved = plugin.configResolved as (config: { command: "build", root: string }) => Promise<void>
    const buildStart = plugin.buildStart as () => Promise<void>
    const resolveId = plugin.resolveId as (id: string) => string | undefined

    await configResolved({ command: "build", root })
    await buildStart()

    const registryId = resolveId("#vitehub-workspace-assets-registry")!
    const registry = (await import(`${pathToFileURL(registryId).href}?t=${Date.now()}`)).default

    await expect(readFile(registryId, "utf8")).resolves.toContain('"docs"')
    await expect(readFile(registryId, "utf8")).resolves.toContain('"notes"')
    await expect(registry.docs.list()).resolves.toEqual([
      expect.objectContaining({ path: "files", type: "directory" }),
    ])
    await expect(registry.docs.readFile("files/README.md")).resolves.toBe("docs\n")
    await expect(registry.notes.readFile("files/README.md")).resolves.toBe("notes\n")
  })

  it("emits selected build-time workspace assets for Vite builds", async () => {
    const root = await createViteAssetRoot()

    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace({ assets: ["docs"] })
    const configResolved = plugin.configResolved as (config: { command: "build", root: string }) => Promise<void>
    const buildStart = plugin.buildStart as () => Promise<void>
    const resolveId = plugin.resolveId as (id: string) => string | undefined

    await configResolved({ command: "build", root })
    await buildStart()

    const registryId = resolveId("#vitehub-workspace-assets-registry")!
    const registry = (await import(`${pathToFileURL(registryId).href}?t=${Date.now()}`)).default

    await expect(readFile(registryId, "utf8")).resolves.toContain('"docs"')
    await expect(readFile(registryId, "utf8")).resolves.not.toContain('"notes"')
    await expect(registry.docs.readFile("files/README.md")).resolves.toBe("docs\n")
    expect(registry.notes).toBeUndefined()
  })

  it("can disable build-time workspace assets for Vite builds", async () => {
    const root = await createViteAssetRoot()

    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace({ assets: false })
    const configResolved = plugin.configResolved as (config: { command: "build", root: string }) => Promise<void>
    const buildStart = plugin.buildStart as () => Promise<void>
    const resolveId = plugin.resolveId as (id: string) => string | undefined

    await configResolved({ command: "build", root })
    await buildStart()

    const registryId = resolveId("#vitehub-workspace-assets-registry")!
    const registry = (await import(`${pathToFileURL(registryId).href}?t=${Date.now()}`)).default

    await expect(readFile(registryId, "utf8")).resolves.not.toContain('"docs"')
    await expect(readFile(registryId, "utf8")).resolves.not.toContain('"notes"')
    expect(registry).toEqual({})
  })
})
