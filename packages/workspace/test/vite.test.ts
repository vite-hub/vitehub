import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@vite-hub/internal/build/vercel-runtime-packages", () => ({
  copyVercelFunctionRuntimePackages: vi.fn(async () => undefined),
}))

const tempDirs: string[] = []

async function createViteRoot() {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-workspace-vite-"))
  tempDirs.push(rootDir)
  await mkdir(join(rootDir, "src"), { recursive: true })
  await mkdir(join(rootDir, "workspaces"), { recursive: true })
  await writeFile(join(rootDir, "src/docs.workspace.ts"), [
    `import { defineWorkspace } from "@vite-hub/workspace"`,
    `export default defineWorkspace({})`,
    ``,
  ].join("\n"))
  await writeFile(join(rootDir, "workspaces/ignored.ts"), [
    `import { defineWorkspace } from "@vite-hub/workspace"`,
    `export default defineWorkspace({})`,
    ``,
  ].join("\n"))
  await writeFile(join(rootDir, "src", "vitehub-workspace.d.ts"), `stale src generated types\n`)
  await writeFile(join(rootDir, "vitehub-workspace.d.ts"), `stale root generated types\n`)
  return rootDir
}

async function createViteRootWithoutSrc() {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-workspace-vite-root-"))
  tempDirs.push(rootDir)
  await writeFile(join(rootDir, "docs.workspace.ts"), [
    `import { defineWorkspace } from "@vite-hub/workspace"`,
    `export default defineWorkspace({})`,
    ``,
  ].join("\n"))
  await writeFile(join(rootDir, "vitehub-workspace.d.ts"), `stale root generated types\n`)
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
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe("hubWorkspace", () => {
  it("runs before downstream framework integrations that consume Provider Output config", async () => {
    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace()

    expect(plugin.enforce).toBe("pre")
  })

  it("ignores generated workspace files in the Vite dev watcher", async () => {
    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace()
    const config = plugin.config as (config: { server?: { watch?: { ignored?: string | string[] } } }) => Promise<{ server?: { watch?: { ignored?: string[] } } }>

    await expect(config({})).resolves.toMatchObject({ server: { watch: { ignored: ["**/.vitehub/**"] } } })
    await expect(config({ server: { watch: { ignored: ["**/node_modules/**"] } } })).resolves.toMatchObject({ server: { watch: { ignored: [
      "**/node_modules/**",
      "**/.vitehub/**",
    ] } } })
    await expect(config({ server: { watch: { ignored: ["**/.vitehub/**"] } } })).resolves.toMatchObject({ server: { watch: { ignored: ["**/.vitehub/**"] } } })
  })

  it("attaches noExternal and virtual workspace manifests", async () => {
    const root = await createViteRoot()
    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace()
    const configResolved = plugin.configResolved as (config: { root: string }) => Promise<void>
    const configEnvironment = plugin.configEnvironment as (name: string, environment: { consumer: "client" | "server", resolve?: { dedupe?: string[], noExternal?: string[] } }) => unknown
    const resolveId = plugin.resolveId as (id: string) => string | undefined
    const load = plugin.load as (id: string) => string | undefined

    await configResolved({ root } as never)

    expect(configEnvironment("ssr", { consumer: "server" })).toEqual({
      resolve: { dedupe: ["@vite-hub/workspace"], noExternal: ["@vite-hub/workspace"] },
    })
    expect(configEnvironment("ssr", {
      consumer: "server",
      resolve: {
        dedupe: ["existing"],
        noExternal: ["existing"],
      },
    })).toEqual({
      resolve: {
        dedupe: ["existing", "@vite-hub/workspace"],
        noExternal: ["existing", "@vite-hub/workspace"],
      },
    })
    await expect(readFile(join(root, ".vitehub", "types", "workspace.d.ts"), "utf8")).resolves.toContain('"docs": true')
    await expect(readFile(join(root, "src", "vitehub-workspace.d.ts"), "utf8")).rejects.toThrow()
    await expect(readFile(join(root, "vitehub-workspace.d.ts"), "utf8")).rejects.toThrow()

    const rootId = resolveId("#vitehub/workspaces")!
    expect(load(rootId)).toContain('"docs"')
    expect(load(rootId)).not.toContain('"ignored"')
    const docsId = resolveId("#vitehub/workspaces/docs")!
    expect(load(docsId)).toContain('"entries":[]')
    const registryId = resolveId("#vitehub-workspace-registry")!
    expect(load(registryId)).toContain('"docs": async () => {')
    expect(load(registryId)).toContain("sourceRootDir")
  })

  it("keeps ambient workspace types in generated ViteHub state without src", async () => {
    const root = await createViteRootWithoutSrc()
    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace()
    const configResolved = plugin.configResolved as (config: { root: string }) => Promise<void>

    await configResolved({ root } as never)

    await expect(readFile(join(root, ".vitehub", "types", "workspace.d.ts"), "utf8")).resolves.toContain('"docs": true')
    await expect(readFile(join(root, "vitehub-workspace.d.ts"), "utf8")).rejects.toThrow()
  })

  it("discovers documented server workspace config files in the Vite integration", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-vite-server-"))
    tempDirs.push(root)
    await mkdir(join(root, "server", "workspaces", "tasks"), { recursive: true })
    await writeFile(join(root, "server", "workspaces", "tasks", "config.ts"), [
      `import { defineWorkspace } from "@vite-hub/workspace"`,
      `export default defineWorkspace({ store: { provider: "memory" } })`,
      ``,
    ].join("\n"))

    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace()
    const configResolved = plugin.configResolved as (config: { root: string }) => Promise<void>
    const resolveId = plugin.resolveId as (id: string) => string | undefined
    const load = plugin.load as (id: string) => string | undefined

    await configResolved({ root } as never)

    await expect(readFile(join(root, ".vitehub", "types", "workspace.d.ts"), "utf8")).resolves.toContain('"tasks": true')
    expect(load(resolveId("#vitehub-workspace-registry")!)).toContain('"tasks": async () => {')
    expect(load(resolveId("#vitehub/workspaces")!)).toContain('"tasks"')
  })

  it("loads server workspace configs that import generated Env modules during build asset sync", async () => {
    const testRoot = join(process.cwd(), ".vitest-tmp")
    await mkdir(testRoot, { recursive: true })
    const root = await mkdtemp(join(testRoot, "vitehub-workspace-vite-env-"))
    tempDirs.push(root)
    await mkdir(join(root, "server", "workspaces", "tasks"), { recursive: true })
    await writeFile(join(root, "server", "workspaces", "tasks", "config.ts"), [
      `import { useServerEnv } from "#vitehub/env/server"`,
      `void useServerEnv`,
      `export default { store: { provider: "memory" }, sources: {} }`,
      ``,
    ].join("\n"))

    const { env, hubEnv } = await import("@vite-hub/env/vite")
    const envPlugin = hubEnv()
    const envConfig = envPlugin.config as (config: { env?: unknown, root: string }, env: { command: "build", mode: string }) => Promise<unknown>
    const envConfigResolved = envPlugin.configResolved as unknown as (config: { logger: { info: () => void }, root: string }) => Promise<void>

    await envConfig({
      env: {
        server: {
          airtableToken: env({ secret: true }),
        },
      },
      root,
    }, { command: "build", mode: "production" })
    await envConfigResolved({ logger: { info: vi.fn() }, root })

    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace()
    const configResolved = plugin.configResolved as (config: { command: "build", root: string }) => Promise<void>
    const buildStart = plugin.buildStart as () => Promise<void>

    await configResolved({ command: "build", root })
    await buildStart()

    await expect(readFile(join(root, ".vitehub", "vite-runtime", "workspace", "assets", "registry.mjs"), "utf8")).resolves.toContain('"tasks"')
  })

  it("keeps Vite workspace names relative to nested Vite roots while writing project state", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-vite-suffix-root-"))
    tempDirs.push(root)
    await mkdir(join(root, "frontend", "src"), { recursive: true })
    await mkdir(join(root, "server", "workspaces", "mirror"), { recursive: true })
    await writeFile(join(root, "frontend", "src", "docs.workspace.ts"), [
      `import { defineWorkspace } from "@vite-hub/workspace"`,
      `export default defineWorkspace({ store: { provider: "memory" } })`,
      ``,
    ].join("\n"))
    await writeFile(join(root, "server", "workspaces", "mirror", "config.ts"), [
      `export default { store: { provider: "memory" } }`,
      ``,
    ].join("\n"))

    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace()
    const configResolved = plugin.configResolved as (config: { command: "build", root: string }) => Promise<void>

    await configResolved({ command: "build", root: join(root, "frontend") })

    const types = await readFile(join(root, ".vitehub", "types", "workspace.d.ts"), "utf8")
    expect(types).toContain('"docs": true')
    expect(types).toContain('"mirror": true')
    expect(types).not.toContain('"frontend/src/docs": true')
    expect(plugin.api.getWorkspaces().map((workspace: { name: string }) => workspace.name).sort()).toEqual(["docs", "mirror"])
    await expect(readFile(join(root, "frontend", ".vitehub", "types", "workspace.d.ts"), "utf8")).rejects.toThrow()
  })

  it("emits Nitro runtime setup for hosted workspace stores outside server plugins", async () => {
    const root = await createViteRoot()
    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace()
    const config = plugin.config as (
      config: { root: string, workspace?: { store?: { branch?: string, provider: "github", repository: string, root: string } } },
      env: { command: "build", mode: string },
    ) => Promise<{ nitro?: { plugins?: string[] } }>

    await expect(config({
      root,
      workspace: {
        store: {
          branch: "main",
          provider: "github",
          repository: "onmax/quiver-airtable",
          root: "app/server/workspaces/mirror",
        },
      },
    }, { command: "build", mode: "production" })).resolves.toMatchObject({
      nitro: {
        plugins: [".vitehub/nitro/workspace/plugin.ts"],
      },
    })

    const pluginSource = await readFile(join(root, ".vitehub", "nitro", "workspace", "plugin.ts"), "utf8")
    expect(pluginSource).toContain("configureCloudflareWorkspaceRuntime")
    expect(pluginSource).toContain("setWorkspaceRuntimeRegistry")
    expect(pluginSource).toContain("import registry from './registry.js'")
    expect(pluginSource).toContain('"provider": "github"')
    expect(pluginSource).toContain('"repository": "onmax/quiver-airtable"')
    await expect(readFile(join(root, "server", "plugins", "vitehub-workspace.ts"), "utf8")).rejects.toThrow()
  })

  it("emits Nitro runtime setup for explicit local workspace stores", async () => {
    const root = await createViteRoot()
    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace()
    const config = plugin.config as (
      config: { root: string, workspace?: { root?: string, store?: { provider: "local" } } },
      env: { command: "serve", mode: string },
    ) => Promise<{ nitro?: { plugins?: string[] } }>

    await expect(config({
      root,
      workspace: {
        root: "server/workspaces",
        store: { provider: "local" },
      },
    }, { command: "serve", mode: "development" })).resolves.toMatchObject({
      nitro: {
        plugins: [".vitehub/nitro/workspace/plugin.ts"],
      },
    })

    const pluginSource = await readFile(join(root, ".vitehub", "nitro", "workspace", "plugin.ts"), "utf8")
    expect(pluginSource).toContain("setWorkspaceRuntimeConfig")
    expect(pluginSource).toContain("setWorkspaceRuntimeRegistry")
    expect(pluginSource).toContain("import registry from './registry.js'")
    expect(pluginSource).toContain('"provider": "local"')
    expect(pluginSource).toContain(JSON.stringify(join(root, "server", "workspaces")))
    expect(pluginSource).not.toContain("configureCloudflareWorkspaceRuntime")
  })

  it("keeps generated workspace files in project ViteHub state when Vite root is app", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-vite-app-root-"))
    tempDirs.push(root)
    await mkdir(join(root, "app"), { recursive: true })
    await mkdir(join(root, "server", "workspaces", "mirror"), { recursive: true })
    await writeFile(join(root, "server", "workspaces", "mirror", "config.ts"), [
      `export default { store: { provider: "memory" } }`,
      ``,
    ].join("\n"))

    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace()
    const config = plugin.config as (
      config: { root: string, workspace?: { store?: { branch?: string, provider: "github", repository: string, root: string } } },
      env: { command: "build", mode: string },
    ) => Promise<{ nitro?: { plugins?: string[] } }>

    await expect(config({
      root: join(root, "app"),
      workspace: {
        store: {
          branch: "main",
          provider: "github",
          repository: "onmax/quiver-airtable",
          root: "server/workspaces/mirror",
        },
      },
    }, { command: "build", mode: "production" })).resolves.toMatchObject({
      nitro: {
        plugins: [".vitehub/nitro/workspace/plugin.ts"],
      },
    })

    await expect(readFile(join(root, ".vitehub", "nitro", "workspace", "plugin.ts"), "utf8")).resolves.toContain("configureCloudflareWorkspaceRuntime")
    await expect(readFile(join(root, "app", ".vitehub", "nitro", "workspace", "plugin.ts"), "utf8")).rejects.toThrow()
  })

  it("keeps generated workspace files in project ViteHub state when Vite root is nested", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-vite-nested-root-"))
    tempDirs.push(root)
    await mkdir(join(root, "frontend"), { recursive: true })
    await mkdir(join(root, "server", "workspaces", "mirror"), { recursive: true })
    await writeFile(join(root, "server", "workspaces", "mirror", "config.ts"), [
      `export default { store: { provider: "memory" } }`,
      ``,
    ].join("\n"))

    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace()
    const config = plugin.config as (
      config: { root: string, workspace?: { store?: { branch?: string, provider: "github", repository: string, root: string } } },
      env: { command: "build", mode: string },
    ) => Promise<{ nitro?: { plugins?: string[] } }>

    await expect(config({
      root: join(root, "frontend"),
      workspace: {
        store: {
          branch: "main",
          provider: "github",
          repository: "onmax/quiver-airtable",
          root: "server/workspaces/mirror",
        },
      },
    }, { command: "build", mode: "production" })).resolves.toMatchObject({
      nitro: {
        plugins: [".vitehub/nitro/workspace/plugin.ts"],
      },
    })

    await expect(readFile(join(root, ".vitehub", "nitro", "workspace", "plugin.ts"), "utf8")).resolves.toContain("configureCloudflareWorkspaceRuntime")
    await expect(readFile(join(root, "frontend", ".vitehub", "nitro", "workspace", "plugin.ts"), "utf8")).rejects.toThrow()
  })

  it("materializes the workspace runtime package for Vercel build output", async () => {
    const root = await createViteRoot()
    const { copyVercelFunctionRuntimePackages } = await import("@vite-hub/internal/build/vercel-runtime-packages")
    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace()
    const configResolved = plugin.configResolved as (config: { command: "build", root: string }) => Promise<void>
    const closeBundle = plugin.closeBundle as { handler: () => Promise<void> }
    vi.mocked(copyVercelFunctionRuntimePackages).mockClear()

    await configResolved({ command: "build", root })
    await closeBundle.handler()

    expect(copyVercelFunctionRuntimePackages).toHaveBeenCalledWith({
      packages: [{ name: "@vite-hub/workspace", resolveFrom: expect.any(String) }],
      rootDir: root,
    })
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

  it("lets Vite config override direct integration options", async () => {
    const root = await createViteAssetRoot()

    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace({ assets: ["docs"] })
    const configResolved = plugin.configResolved as (config: { command: "build", root: string, workspace?: { assets?: boolean | string[] } }) => Promise<void>
    const buildStart = plugin.buildStart as () => Promise<void>
    const resolveId = plugin.resolveId as (id: string) => string | undefined

    await configResolved({ command: "build", root, workspace: { assets: false } })
    await buildStart()

    const registryId = resolveId("#vitehub-workspace-assets-registry")!
    const registry = (await import(`${pathToFileURL(registryId).href}?t=${Date.now()}`)).default

    await expect(readFile(registryId, "utf8")).resolves.not.toContain('"docs"')
    await expect(readFile(registryId, "utf8")).resolves.not.toContain('"notes"')
    expect(registry).toEqual({})
  })
})
