import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { VITEHUB_NITRO_CONFIG_CONTEXT, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"

import { viteHubTypesPlugin } from "../src/internal/types.ts"

import type { ViteHubCliContext, ViteHubCliContributingPlugin } from "@vite-hub/internal/cli"
import type { Plugin } from "vite"

const tempDirectories: string[] = []

async function createNestedProject() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-generated-types-"))
  tempDirectories.push(root)
  await Promise.all([
    mkdir(join(root, "frontend"), { recursive: true }),
    mkdir(join(root, ".vitehub/env"), { recursive: true }),
    mkdir(join(root, ".vitehub/data/blob"), { recursive: true }),
    mkdir(join(root, ".vitehub/sandbox/runtime"), { recursive: true }),
    mkdir(join(root, ".vitehub/types"), { recursive: true }),
    writeFile(join(root, "package.json"), JSON.stringify({ name: "generated-types-test" })),
  ])
  return { root, viteRoot: join(root, "frontend") }
}

function collectionModule(name: string): string {
  return [
    `export const ${name} = {`,
    `  async page() { return { items: [], nextCursor: null } },`,
    `  async parseQuery(input: object) { return input },`,
    `}`,
    ``,
  ].join("\n")
}

function configResolved(plugin: Plugin) {
  return plugin.configResolved as (config: {
    root: string
    [VITEHUB_SERVER_DIRS]?: string[]
  }) => Promise<void>
}

function config(plugin: Plugin) {
  return plugin.config as (config: {
    nitro?: Record<string, unknown>
    root?: string
    [VITEHUB_NITRO_CONFIG_CONTEXT]?: boolean
    [VITEHUB_SERVER_DIRS]?: string[]
  }) => Promise<void>
}

function buildStart(plugin: Plugin) {
  return plugin.buildStart as () => Promise<void>
}

function buildEnd(plugin: Plugin) {
  return plugin.buildEnd as () => Promise<void>
}

function prepareFeature(plugin: Plugin & ViteHubCliContributingPlugin) {
  const contributor = plugin.vitehub?.cli
  if (!contributor || typeof contributor === "function") throw new TypeError("Expected static CLI metadata.")
  const feature = contributor.namespaces.find(namespace => namespace.name === "types")?.features
    .find(candidate => candidate.name === "prepare")
  if (!feature) throw new TypeError("Expected the types prepare feature.")
  return feature
}

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(directory => rm(directory, { force: true, recursive: true })))
})

describe("framework generated types", () => {
  it("writes a sorted self-excluding entry at the ViteHub project root", async () => {
    const { root, viteRoot } = await createNestedProject()
    await Promise.all([
      writeFile(join(root, ".vitehub/types/markdown-template.d.ts"), "declare module \"*.template.md\" {}\n"),
      writeFile(join(root, ".vitehub/env/env.d.ts"), "interface ImportMetaEnv {}\n"),
      writeFile(join(root, ".vitehub/data/blob/upload.d.ts"), "invalid uploaded declaration\n"),
      writeFile(join(root, ".vitehub/sandbox/runtime/sandbox.d.ts"), "declare module \"#vitehub/sandbox\" {}\n"),
      writeFile(join(root, ".vitehub/types.d.ts"), "stale self reference\n"),
    ])

    const plugin = viteHubTypesPlugin()
    await configResolved(plugin)({ root: viteRoot })

    await expect(readFile(join(root, ".vitehub/types.d.ts"), "utf8")).resolves.toBe([
      `/// <reference path="./env/env.d.ts" />`,
      `/// <reference path="./sandbox/runtime/sandbox.d.ts" />`,
      `/// <reference path="./types/markdown-template.d.ts" />`,
      ``,
      `export {}`,
      ``,
    ].join("\n"))
    await expect(readFile(join(viteRoot, ".vitehub/types.d.ts"), "utf8")).rejects.toThrow()
  })

  it("refreshes build output and exposes the prepare lifecycle", async () => {
    const { root, viteRoot } = await createNestedProject()
    await writeFile(join(root, ".vitehub/types/env.d.ts"), "interface ImportMetaEnv {}\n")

    const plugin = viteHubTypesPlugin()
    await configResolved(plugin)({ root: viteRoot })
    await writeFile(join(root, ".vitehub/types/workspace.d.ts"), "declare module \"#vitehub/workspace\" {}\n")
    await buildEnd(plugin)()

    await expect(readFile(join(root, ".vitehub/types.d.ts"), "utf8")).resolves.toContain("./types/workspace.d.ts")

    await rm(join(root, ".vitehub/types.d.ts"))
    const stdout = { write: vi.fn() }
    const context = {
      rootDir: viteRoot,
      stdout,
    } as unknown as ViteHubCliContext
    await prepareFeature(viteHubTypesPlugin()).run([], context)

    await expect(readFile(join(root, ".vitehub/types.d.ts"), "utf8")).resolves.toContain("./types/env.d.ts")
    expect(stdout.write).toHaveBeenCalledWith("types: prepared .vitehub/types.d.ts\n")
  })

  it("registers server Collections by filename", async () => {
    const { root, viteRoot } = await createNestedProject()
    await mkdir(join(root, "server/collections/admin"), { recursive: true })
    await Promise.all([
      writeFile(join(root, "server/collections/meals.ts"), collectionModule("meals")),
      writeFile(join(root, "server/collections/admin/history.ts"), collectionModule("history")),
    ])

    const plugin = viteHubTypesPlugin()
    await configResolved(plugin)({ root: viteRoot })
    const handlers = await plugin.api.prepareTypes(root)

    await expect(readFile(join(root, ".vitehub/source/collections.d.ts"), "utf8")).resolves.toBe([
      `declare global {`,
      `  interface ViteHubCollectionMap {`,
      `    "admin/history": typeof import(${JSON.stringify(join(root, "server/collections/admin/history.ts"))})["history"]`,
      `    "meals": typeof import(${JSON.stringify(join(root, "server/collections/meals.ts"))})["meals"]`,
      `  }`,
      `}`,
      ``,
      `export {}`,
      ``,
    ].join("\n"))
    await expect(readFile(join(root, ".vitehub/types.d.ts"), "utf8")).resolves.toContain(
      `./source/collections.d.ts`,
    )
    expect(handlers).toEqual([
      {
        handler: join(root, ".vitehub/source/routes/admin/history.mjs"),
        method: "get",
        route: "/api/admin/history",
      },
      {
        handler: join(root, ".vitehub/source/routes/meals.mjs"),
        method: "get",
        route: "/api/meals",
      },
    ])
    await expect(readFile(join(root, ".vitehub/source/routes/meals.mjs"), "utf8")).resolves.toBe([
      `import { defineCollectionHandler } from "vite-hub/source/server"`,
      `import { meals as collection } from ${JSON.stringify(join(root, "server/collections/meals.ts"))}`,
      ``,
      `export default defineCollectionHandler(collection)`,
      ``,
    ].join("\n"))
  })

  it("registers generated Collection handlers in plain Vite Nitro config", async () => {
    const { root } = await createNestedProject()
    await mkdir(join(root, "server/collections"), { recursive: true })
    await writeFile(join(root, "server/collections/meals.ts"), collectionModule("meals"))
    const existing = { handler: "server/health.ts", method: "get", route: "/api/health" }
    const userConfig: {
      nitro: { handlers: typeof existing[], modules?: Array<{ name?: string }> }
      root: string
    } = { nitro: { handlers: [existing] }, root }

    await config(viteHubTypesPlugin())(userConfig)

    expect(userConfig.nitro.handlers).toEqual([
      existing,
      {
        handler: join(root, ".vitehub/source/routes/meals.mjs"),
        method: "get",
        route: "/api/meals",
      },
    ])
    expect(userConfig.nitro.modules)
      .toContainEqual(expect.objectContaining({ name: "vite-hub/collection-route-guard" }))
  })

  it("rejects a conflicting plain Vite Nitro handler", async () => {
    const { root } = await createNestedProject()
    await mkdir(join(root, "server/collections"), { recursive: true })
    await writeFile(join(root, "server/collections/meals.ts"), collectionModule("meals"))

    await expect(config(viteHubTypesPlugin())({
      nitro: { handlers: [{ handler: "server/api/meals.ts", route: "/api/meals" }] },
      root,
    })).rejects.toThrow('Generated Collection route "/api/meals" conflicts with an existing GET handler')
  })

  it.each([
    "export const publicMeals = {}\n",
    "export type meals = {}\nexport const publicMeals = {}\n",
  ])("rejects a Collection module without its filename-matching runtime export", async (source) => {
    const { root } = await createNestedProject()
    await mkdir(join(root, "server/collections"), { recursive: true })
    await writeFile(join(root, "server/collections/meals.ts"), source)

    const plugin = viteHubTypesPlugin()
    await expect(plugin.api.prepareTypes(root)).rejects.toThrow(
      'Collection file "server/collections/meals.ts" must export a Collection named "meals" to match its filename',
    )
    await expect(readFile(join(root, ".vitehub/source/collections.d.ts"), "utf8")).rejects.toThrow()
    await expect(readFile(join(root, ".vitehub/source/routes/meals.mjs"), "utf8")).rejects.toThrow()
  })

  it("discovers Collections from configured server directories", async () => {
    const { root } = await createNestedProject()
    const firstServerDir = join(root, "api")
    const secondServerDir = join(root, "admin")
    await Promise.all([
      mkdir(join(firstServerDir, "collections"), { recursive: true }),
      mkdir(join(secondServerDir, "collections"), { recursive: true }),
    ])
    await Promise.all([
      writeFile(join(firstServerDir, "collections/meals.ts"), collectionModule("meals")),
      writeFile(join(secondServerDir, "collections/audit.ts"), collectionModule("audit")),
    ])

    const plugin = viteHubTypesPlugin()
    const handlers = await plugin.api.prepareTypes({
      projectRoot: root,
      serverDirs: [firstServerDir, secondServerDir],
    })

    expect(handlers.map((handler: { route: string }) => handler.route)).toEqual(["/api/audit", "/api/meals"])
    await expect(readFile(join(root, ".vitehub/source/collections.d.ts"), "utf8"))
      .resolves.toContain(JSON.stringify(join(firstServerDir, "collections/meals.ts")))

    await writeFile(join(secondServerDir, "collections/meals.ts"), collectionModule("meals"))
    await expect(plugin.api.prepareTypes({
      projectRoot: root,
      serverDirs: [firstServerDir, secondServerDir],
    })).rejects.toThrow('Collection name "meals" is defined in more than one server directory')
  })

  it("preserves an explicitly empty server directory selection", async () => {
    const { root } = await createNestedProject()
    await mkdir(join(root, "server/collections"), { recursive: true })
    await writeFile(join(root, "server/collections/meals.ts"), collectionModule("meals"))

    const plugin = viteHubTypesPlugin()
    const handlers = await plugin.api.prepareTypes({
      projectRoot: root,
      serverDirs: [],
    })

    expect(handlers).toEqual([])
    await expect(readFile(join(root, ".vitehub/source/collections.d.ts"), "utf8")).rejects.toThrow()
    await expect(readFile(join(root, ".vitehub/source/routes/meals.mjs"), "utf8")).rejects.toThrow()
  })

  it("preserves configured server directories across Vite lifecycle refreshes", async () => {
    const { root, viteRoot } = await createNestedProject()
    const serverDir = join(root, "api")
    await mkdir(join(serverDir, "collections"), { recursive: true })
    await writeFile(join(serverDir, "collections/meals.ts"), collectionModule("meals"))

    const plugin = viteHubTypesPlugin()
    await configResolved(plugin)({
      root: viteRoot,
      [VITEHUB_SERVER_DIRS]: [serverDir],
    })
    await buildStart(plugin)()

    await expect(readFile(join(root, ".vitehub/source/routes/meals.mjs"), "utf8"))
      .resolves.toContain(JSON.stringify(join(serverDir, "collections/meals.ts")))
  })
})
