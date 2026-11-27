import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { collectViteHubDefinitionInspectors } from "@vite-hub/internal/inspect"
import { nitro as nitroPlugin } from "nitro/vite"
import { resolveConfig } from "vite"
import { afterEach, describe, expect, it, vi } from "vitest"

import { collectWorkspaceContributions } from "../src/build/contributions.ts"
import { createWorkspaceRegistryContents, createWorkspaceVirtualRegistryContents, discoverViteWorkspaceDefinitions } from "../src/build/discovery.ts"
import { inspectWorkspaceDefinitions } from "../src/inspect.ts"
import { createWorkspaceNitroConfig, hubWorkspace } from "../src/vite.ts"

import type { CollectedWorkspaceContribution, WorkspaceContributingPlugin } from "../src/vite.ts"
import type { Nitro } from "nitro/types"
import type { Plugin } from "vite"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-contributions-"))
  tempDirs.push(root)
  await mkdir(join(root, "server", "workspaces"), { recursive: true })
  await writeFile(join(root, "server", "workspaces", "docs.ts"), "export default {}\n", "utf8")
  await mkdir(join(root, "node_modules", "content-owner"), { recursive: true })
  await writeFile(join(root, "node_modules", "content-owner", "package.json"), JSON.stringify({
    exports: { "./workspace": "./workspace.mjs" },
    name: "content-owner",
    type: "module",
  }))
  await writeFile(join(root, "node_modules", "content-owner", "workspace.mjs"), "export const contentWorkspace = { label: \"package content\" }\n")
  return root
}

async function createPackageStoreRoot(storeSource: string) {
  const root = await createRoot()
  await mkdir(join(root, "node_modules", "content-store"), { recursive: true })
  await writeFile(join(root, "node_modules", "content-store", "package.json"), JSON.stringify({
    exports: "./store.mjs",
    name: "content-store",
    type: "module",
  }))
  await writeFile(join(root, "node_modules", "content-store", "store.mjs"), storeSource)
  await writeFile(join(root, "node_modules", "content-owner", "workspace.mjs"), `import { store } from "content-store"\nexport const contentWorkspace = { store }\n`)
  return root
}

function contributor(workspaces: NonNullable<WorkspaceContributingPlugin["vitehub"]>["workspaces"], name = "content-owner/vite"): WorkspaceContributingPlugin {
  return { name, vitehub: { workspaces } }
}

function hook<T extends (...args: never[]) => unknown>(value: unknown): T {
  const handler = value && typeof value === "object" && "handler" in value ? value.handler : value
  if (typeof handler !== "function") throw new TypeError("Expected a Vite hook.")
  // SAFETY: Each test passes the argument subset that the selected Workspace hook reads.
  return handler as T
}

const context = { projectRoot: "/app", root: "/app" }

function collected(name: string, module: string, exportName = "default", plugin = "content-owner/vite"): CollectedWorkspaceContribution {
  return { definition: { export: exportName, module }, name, plugin }
}

describe("collectWorkspaceContributions", () => {
  it("collects static and factory contributions from nested plugin options", async () => {
    const factory = vi.fn(() => [{ definition: { export: "cms", module: "/abs/cms.ts" }, name: "content", reason: "Content documents." }])
    const contributions = await collectWorkspaceContributions([
      { name: "unrelated" },
      [contributor([{ definition: { module: "pkg/notes" }, name: "notes" }], "notes/vite"), [contributor(factory)]],
      false,
    ], { ...context, serverDirs: ["/app/server"] })

    expect(factory).toHaveBeenCalledWith({ projectRoot: "/app", root: "/app", serverDirs: ["/app/server"], plugins: expect.any(Array) })
    expect(contributions).toEqual([
      { ...collected("content", "/abs/cms.ts", "cms"), reason: "Content documents." },
      collected("notes", "pkg/notes", "default", "notes/vite"),
    ])
  })

  it("keeps one copy when one plugin is registered twice and normalizes the default export", async () => {
    const plugin = contributor([{ definition: { module: "pkg/content" }, name: "content" }])
    const contributions = await collectWorkspaceContributions([
      plugin,
      contributor([{ definition: { export: "default", module: "pkg/content" }, name: "content" }]),
    ], context)

    expect(contributions).toEqual([collected("content", "pkg/content")])
  })

  it("rejects one name from two plugins and names both plugins", async () => {
    await expect(collectWorkspaceContributions([
      contributor([{ definition: { module: "pkg/a" }, name: "content" }], "a/vite"),
      contributor([{ definition: { module: "pkg/b" }, name: "content" }], "b/vite"),
    ], context)).rejects.toMatchObject({
      code: "WORKSPACE_B0003",
      message: expect.stringMatching(/Workspace "content" is contributed more than once:\n {2}- pkg\/a from plugin "a\/vite"\n {2}- pkg\/b from plugin "b\/vite"/),
    })
  })

  it.each([
    [{ definition: { module: "./relative.ts" }, name: "content" }, "is relative"],
    [{ definition: { module: "pkg/content" }, name: "" }, "`name` must be a non-empty string"],
    [{ name: "content" }, "needs `definition: { module, export? }`"],
    [{ definition: { export: "", module: "pkg/content" }, name: "content" }, "`definition.export` of Workspace \"content\" must be a non-empty string"],
  ])("rejects an invalid contribution %#", async (contribution, message) => {
    // SAFETY: Each case passes invalid input that the collector must reject at runtime.
    const invalid = contribution as unknown as CollectedWorkspaceContribution
    await expect(collectWorkspaceContributions([contributor([invalid])], context)).rejects.toMatchObject({
      code: "WORKSPACE_B0004",
      message: expect.stringContaining(message),
    })
  })
})

describe("discoverViteWorkspaceDefinitions contributions", () => {
  it("merges contributed definitions with discovered files in name order", async () => {
    const root = await createRoot()

    expect(discoverViteWorkspaceDefinitions(root, {
      contributions: [
        collected("content", "content-owner/workspace", "contentWorkspace"),
        { ...collected("zeta", "/abs/zeta.ts"), reason: "Zeta files." },
      ],
    })).toEqual([
      {
        contributor: "content-owner/vite",
        export: "contentWorkspace",
        handler: "content-owner/workspace",
        name: "content",
        path: "content-owner/workspace",
        source: "vite-plugin-contribution",
      },
      expect.objectContaining({ handler: join(root, "server", "workspaces", "docs.ts"), name: "docs" }),
      { contributor: "content-owner/vite", handler: "/abs/zeta.ts", name: "zeta", path: "/abs/zeta.ts", reason: "Zeta files.", source: "vite-plugin-contribution" },
    ])
  })

  it("fails when a contribution reuses a discovered Workspace name", async () => {
    const root = await createRoot()

    expect(() => discoverViteWorkspaceDefinitions(root, {
      contributions: [collected("docs", "content-owner/workspace")],
    })).toThrow(expect.objectContaining({
      code: "WORKSPACE_B0003",
      message: expect.stringContaining(join(root, "server", "workspaces", "docs.ts")),
    }))
  })

  it.each(["file", "virtual"] as const)("loads contributed exports from the %s registry", async (kind) => {
    const root = await createRoot()
    const registryFile = join(root, ".vitehub", "nitro", "workspace", "registry.mjs")
    await mkdir(join(root, ".vitehub", "nitro", "workspace"), { recursive: true })
    await mkdir(join(root, "owner"), { recursive: true })
    await writeFile(join(root, "owner", "workspace.mjs"), "export const fileWorkspace = { label: \"file content\" }\nexport const empty = undefined\n")
    const definitions = discoverViteWorkspaceDefinitions(root, {
      contributions: [
        collected("content", join(root, "owner", "workspace.mjs"), "fileWorkspace"),
        collected("empty", join(root, "owner", "workspace.mjs"), "empty"),
        collected("package", "content-owner/workspace", "contentWorkspace"),
      ],
    }).filter(definition => definition.name !== "docs")
    const contents = kind === "file"
      ? createWorkspaceRegistryContents(registryFile, definitions)
      : createWorkspaceVirtualRegistryContents(definitions)
    expect(contents).toContain("import(\"content-owner/workspace\")")
    await writeFile(registryFile, contents)

    const { default: registry }: { default: Record<string, () => Promise<{ default: { label: string } }>> } = await import(pathToFileURL(registryFile).href)

    await expect(registry.content!()).resolves.toEqual({ default: { label: "file content" } })
    await expect(registry.package!()).resolves.toEqual({ default: { label: "package content" } })
    await expect(registry.empty!()).rejects.toThrow("has no export \"empty\". Check the Workspace contribution of \"content-owner/vite\".")
  })

  it("applies resolved store overrides to contributed definitions", async () => {
    const root = await createRoot()
    const registryFile = join(root, "registry.mjs")
    const definitions = discoverViteWorkspaceDefinitions(root, { contributions: [collected("content", "content-owner/workspace", "contentWorkspace")] })
    const store = { binding: "CONTENT", namespace: "content", driver: "cloudflare" }
    await writeFile(registryFile, createWorkspaceRegistryContents(registryFile, definitions, new Map([["content", { store }]])))

    const { default: registry }: { default: Record<string, () => Promise<{ default: { label: string, store: unknown } }>> } = await import(pathToFileURL(registryFile).href)

    await expect(registry.content!()).resolves.toEqual({ default: { label: "package content", store } })
  })
})

describe("inspectWorkspaceDefinitions contributions", () => {
  it("lists contributed Workspaces with their contributor", async () => {
    const root = await createRoot()

    const summaries = await inspectWorkspaceDefinitions({
      plugins: [contributor([{ definition: { export: "contentWorkspace", module: "content-owner/workspace" }, name: "content", reason: "Content documents." }])],
      projectRoot: root,
      rootDir: root,
      serverRootDir: root,
    })

    expect(summaries).toEqual([
      {
        fields: [
          { label: "Kind", value: "Contributed Workspace Definition" },
          { label: "Contributed by", value: "content-owner/vite" },
          { label: "Export", value: "contentWorkspace" },
          { label: "Reason", value: "Content documents." },
        ],
        file: "content-owner/workspace",
        name: "content",
        source: "vite-plugin-contribution",
      },
      expect.objectContaining({ file: "server/workspaces/docs.ts", name: "docs" }),
    ])
  })
})

describe("hubWorkspace contributions", () => {
  it.each(["vite", "nitro"] as const)("keeps package-imported Artifacts stores in %s dev config", async (host) => {
    const root = await createPackageStoreRoot(`export const store = { driver: "cloudflare", binding: "CONTENT_FILES", namespace: "content" }\n`)
    const plugins = [contributor([{ definition: { export: "contentWorkspace", module: "content-owner/workspace" }, name: "content" }])]
    let nitro: unknown
    if (host === "vite") {
      const plugin = hubWorkspace()
      const config = hook<(config: Record<string, unknown>, env: { command: "serve", mode: string }) => Promise<unknown>>(plugin.config)
      const userConfig = { nitro: { preset: "cloudflare-module" }, plugins, root }
      await config(userConfig, { command: "serve", mode: "development" })
      nitro = userConfig.nitro
    }
    else {
      nitro = await createWorkspaceNitroConfig({ command: "serve", nitro: {}, plugins, viteRoot: root })
    }
    expect(nitro).toMatchObject({
      cloudflare: { wrangler: { artifacts: [{ binding: "CONTENT_FILES", namespace: "content" }] } },
    })
  })

  it.each(["plugin options", "nitro.config", "Node"])("uses the resolved Nitro dev preset from %s", async (source) => {
    const root = await createPackageStoreRoot([
      `import { writeFileSync } from "node:fs"`,
      `writeFileSync(new URL("./loaded", import.meta.url), "loaded")`,
      `export const store = { driver: "cloudflare", binding: "CONTENT_FILES", namespace: "content" }`,
    ].join("\n"))
    const workspace = hubWorkspace()
    const owner = contributor([{ definition: { export: "contentWorkspace", module: "content-owner/workspace" }, name: "content" }])
    if (source === "nitro.config") await writeFile(join(root, "nitro.config.ts"), `export default { preset: "cloudflare-module" }\n`)
    const preset = source === "nitro.config" ? undefined : source === "Node" ? "node-server" : "cloudflare-module"
    const configured = new Error("Nitro configuration inspected")
    let instance: Nitro | undefined
    try {
      await expect(resolveConfig({
        configFile: false,
        logLevel: "silent",
        root,
        plugins: [
          owner as Plugin,
          workspace,
          nitroPlugin({ preset, hooks: { "build:before": (nitro) => {
            instance = nitro
            throw configured
          } } }),
        ],
      }, "serve")).rejects.toBe(configured)
      const plugin = await readFile(join(root, ".vitehub", "nitro", "workspace", "plugin.ts"), "utf8")
      const marker = join(root, "node_modules", "content-store", "loaded")
      if (source === "Node") {
        const resolved = hook<(config: Record<string, unknown>) => Promise<void>>(workspace.configResolved)
        await resolved({ command: "serve", plugins: [workspace, owner], root })
        const [inspector] = await collectViteHubDefinitionInspectors([workspace])
        await expect(inspector!.list()).resolves.toContainEqual(expect.objectContaining({ name: "content" }))
        await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
        expect(instance?.options.cloudflare?.wrangler?.artifacts).toBeUndefined()
        expect(plugin).not.toContain("setActiveCloudflareEnv")
      }
      else {
        await expect(readFile(marker, "utf8")).resolves.toBe("loaded")
        expect(instance?.options.preset).toBe("cloudflare-dev")
        expect(instance?.options.cloudflare?.wrangler?.artifacts).toEqual([{ binding: "CONTENT_FILES", namespace: "content" }])
        expect(plugin).toContain("setActiveCloudflareEnv")
      }
    }
    finally {
      await instance?.close()
    }
  })

  it("loads contributed Definitions with package-imported memory stores at runtime in Node dev", async () => {
    const root = await createPackageStoreRoot([
      `import { writeFileSync } from "node:fs"`,
      `writeFileSync(new URL("./loaded", import.meta.url), "loaded")`,
      `export const store = { driver: "memory" }`,
      ``,
    ].join("\n"))
    const nitro = await createWorkspaceNitroConfig({
      command: "serve",
      nitro: { preset: "node-server" },
      plugins: [contributor([{ definition: { export: "contentWorkspace", module: "content-owner/workspace" }, name: "content" }])],
      viteRoot: root,
    })
    expect(nitro).not.toHaveProperty("cloudflare.wrangler.artifacts")
    const marker = join(root, "node_modules", "content-store", "loaded")
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    const { default: registry }: { default: Record<string, () => Promise<unknown>> } = await import(pathToFileURL(join(root, ".vitehub", "nitro", "workspace", "registry.js")).href)
    await expect(registry.content!()).resolves.toEqual({ default: { store: { driver: "memory" } } })
    await expect(readFile(marker, "utf8")).resolves.toBe("loaded")
  })

  it("adds contributed Workspaces to the Nitro registry, typegen, manifest, and inspection", async () => {
    const root = await createRoot()
    const owner = contributor(({ root: viteRoot }) => [{ definition: { export: "contentWorkspace", module: viteRoot === root ? "content-owner/workspace" : "wrong-root" }, name: "content" }])
    const plugin = hubWorkspace()
    const config = hook<(config: Record<string, unknown>, env: { command: "serve", mode: string }) => Promise<unknown>>(plugin.config)
    const configResolved = hook<(config: Record<string, unknown>) => Promise<void>>(plugin.configResolved)
    const resolveId = hook<(id: string) => string | undefined>(plugin.resolveId)
    const load = hook<(id: string) => string | undefined>(plugin.load)
    const userConfig = { nitro: {}, plugins: [[owner as Plugin]], root }

    await config(userConfig, { command: "serve", mode: "development" })
    expect(userConfig.nitro).toMatchObject({ plugins: [join(root, ".vitehub/nitro/workspace/plugin.ts")] })
    const registrySource = await readFile(join(root, ".vitehub", "nitro", "workspace", "registry.js"), "utf8")
    expect(registrySource).toContain("import(\"content-owner/workspace\")")

    await configResolved({ command: "serve", plugins: [plugin, owner], root })
    await expect(readFile(join(root, ".vitehub", "types", "workspace.d.ts"), "utf8")).resolves.toContain("\"content\": true")
    expect(plugin.api.getWorkspaces()).toEqual([{ name: "content" }, { name: "docs" }])
    expect(load(resolveId("#vitehub-workspace-registry")!)).toContain("import(\"content-owner/workspace\")")

    const inspect = plugin.vitehub!.inspect as () => Promise<{ definitions: Array<{ list: () => Promise<Array<{ name: string, source: string }>> }> }>
    const inspection = await inspect()
    await expect(inspection.definitions[0]!.list()).resolves.toEqual([
      expect.objectContaining({ name: "content", source: "vite-plugin-contribution" }),
      expect.objectContaining({ name: "docs" }),
    ])
  })

  it("fails the build when a contribution collides with a discovered Workspace", async () => {
    const root = await createRoot()
    const plugin = hubWorkspace()
    const config = hook<(config: Record<string, unknown>, env: { command: "build", mode: string }) => Promise<unknown>>(plugin.config)

    await expect(config({
      nitro: {},
      plugins: [contributor([{ definition: { module: "content-owner/workspace" }, name: "docs" }])],
      root,
    }, { command: "build", mode: "production" })).rejects.toMatchObject({ code: "WORKSPACE_B0003" })
  })

  it("adds contributed Workspaces to the Nuxt Nitro config", async () => {
    const root = await createRoot()
    await rm(join(root, "server", "workspaces", "docs.ts"))

    const nitro = await createWorkspaceNitroConfig({
      command: "build",
      nitro: {},
      plugins: [contributor([{ definition: { export: "contentWorkspace", module: "content-owner/workspace" }, name: "content" }])],
      viteRoot: root,
    })

    expect(nitro).toMatchObject({ plugins: [join(root, ".vitehub/nitro/workspace/plugin.ts")] })
    const { default: registry }: { default: Record<string, () => Promise<{ default: { label: string } }>> } = await import(pathToFileURL(join(root, ".vitehub", "nitro", "workspace", "registry.js")).href)
    expect(Object.keys(registry)).toEqual(["content"])
    await expect(registry.content!()).resolves.toEqual({ default: { label: "package content" } })
  })
})
