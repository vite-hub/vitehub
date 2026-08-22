import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"

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

function configResolved(plugin: Plugin) {
  return plugin.configResolved as (config: {
    root: string
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
      writeFile(join(root, ".vitehub/types/templates.d.ts"), "declare module \"#vitehub/templates\" {}\n"),
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
      `/// <reference path="./types/templates.d.ts" />`,
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
      writeFile(join(root, "server/collections/meals.ts"), "export const meals = {}\n"),
      writeFile(join(root, "server/collections/admin/history.ts"), "export const history = {}\n"),
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

  it("discovers Collections from configured server directories", async () => {
    const { root } = await createNestedProject()
    const firstServerDir = join(root, "api")
    const secondServerDir = join(root, "admin")
    await Promise.all([
      mkdir(join(firstServerDir, "collections"), { recursive: true }),
      mkdir(join(secondServerDir, "collections"), { recursive: true }),
    ])
    await Promise.all([
      writeFile(join(firstServerDir, "collections/meals.ts"), "export const meals = {}\n"),
      writeFile(join(secondServerDir, "collections/audit.ts"), "export const audit = {}\n"),
    ])

    const plugin = viteHubTypesPlugin()
    const handlers = await plugin.api.prepareTypes({
      projectRoot: root,
      serverDirs: [firstServerDir, secondServerDir],
    })

    expect(handlers.map((handler: { route: string }) => handler.route)).toEqual(["/api/audit", "/api/meals"])
    await expect(readFile(join(root, ".vitehub/source/collections.d.ts"), "utf8"))
      .resolves.toContain(JSON.stringify(join(firstServerDir, "collections/meals.ts")))

    await writeFile(join(secondServerDir, "collections/meals.ts"), "export const meals = {}\n")
    await expect(plugin.api.prepareTypes({
      projectRoot: root,
      serverDirs: [firstServerDir, secondServerDir],
    })).rejects.toThrow('Collection name "meals" is defined in more than one server directory')
  })

  it("preserves configured server directories across Vite lifecycle refreshes", async () => {
    const { root, viteRoot } = await createNestedProject()
    const serverDir = join(root, "api")
    await mkdir(join(serverDir, "collections"), { recursive: true })
    await writeFile(join(serverDir, "collections/meals.ts"), "export const meals = {}\n")

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
