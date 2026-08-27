import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { IncomingMessage, ServerResponse } from "node:http"
import { Socket } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { afterEach, describe, expect, it, vi } from "vitest"
import { createEvent } from "h3-v1"

import { VITEHUB_NITRO_CONFIG_CONTEXT, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { hubSource, toRuntimeModuleSpecifier, toTypeModuleSpecifier } from "@vite-hub/source/vite"

import { viteHubTypesPlugin } from "../src/internal/types.ts"
import {
  hubSource as frameworkHubSource,
  prepareSourceGeneration as prepareFrameworkSourceGeneration,
} from "../src/source/vite.ts"

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

function contentModule(): string {
  return [
    `export const content = {`,
    `  async handler(request: Request) {`,
    `    return Response.json({`,
    `      aborted: request.signal.aborted,`,
    `      body: await request.text(),`,
    `      header: request.headers.get("x-content-test"),`,
    `      method: request.method,`,
    `      url: request.url,`,
    `    })`,
    `  },`,
    `}`,
    ``,
  ].join("\n")
}

function configResolved(plugin: Plugin) {
  // SAFETY: This fixture invokes the documented Vite configResolved hook signature.
  return plugin.configResolved as (config: { root: string; [VITEHUB_SERVER_DIRS]?: string[] }) => Promise<void>
}

function sourcePlugin() {
  return hubSource({ importBase: "vite-hub/source" })
}

function config(plugin: Plugin) {
  // SAFETY: This fixture invokes the documented Vite config hook signature.
  return plugin.config as (config: {
    base?: string
    define?: Record<string, string>
    nitro?: Record<string, unknown>
    root?: string
    [VITEHUB_NITRO_CONFIG_CONTEXT]?: boolean
    [VITEHUB_SERVER_DIRS]?: string[]
  }) => Promise<void>
}

function buildStart(plugin: Plugin) {
  if (plugin.buildStart && !(plugin.buildStart instanceof Function)) {
    // SAFETY: This fixture invokes the documented Vite buildStart hook signature.
    return plugin.buildStart.handler as () => Promise<void>
  }
  // SAFETY: This fixture invokes the documented Vite buildStart hook signature.
  return plugin.buildStart as () => Promise<void>
}

function buildEnd(plugin: Plugin) {
  if (plugin.buildEnd && !(plugin.buildEnd instanceof Function)) {
    // SAFETY: This fixture invokes the documented Vite buildEnd hook signature.
    return plugin.buildEnd.handler as () => Promise<void>
  }
  // SAFETY: This fixture invokes the documented Vite buildEnd hook signature.
  return plugin.buildEnd as () => Promise<void>
}

function prepareFeature(plugin: Plugin & ViteHubCliContributingPlugin) {
  const contributor = plugin.vitehub?.cli
  if (!contributor || contributor instanceof Function) throw new TypeError("Expected static CLI metadata.")
  const feature = contributor.namespaces
    .find(namespace => namespace.name === "types")
    ?.features.find(candidate => candidate.name === "prepare")
  if (!feature) throw new TypeError("Expected the types prepare feature.")
  return feature
}

function contributesCli(plugin: Plugin): plugin is Plugin & ViteHubCliContributingPlugin {
  return "vitehub" in plugin
}

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(directory => rm(directory, { force: true, recursive: true })))
})

describe("framework generated types", () => {
  it("defines the Collection client base URL for plain Vite", async () => {
    const { viteRoot } = await createNestedProject()
    const viteConfig = {
      base: "/portal/",
      define: { EXISTING: "true" },
      root: viteRoot,
    }

    await config(sourcePlugin())(viteConfig)

    expect(viteConfig.define).toEqual({
      EXISTING: "true",
      __VITEHUB_APP_BASE_URL__: JSON.stringify("/portal/"),
    })
  })

  it.each([undefined, "", "./", "../", "https://cdn.example.com/", "//cdn.example.com/"])(
    "normalizes the non-root-relative Vite base %j to the application origin",
    async base => {
      const { viteRoot } = await createNestedProject()
      const viteConfig = { base, root: viteRoot }

      await config(sourcePlugin())(viteConfig)

      expect(viteConfig).toMatchObject({
        define: { __VITEHUB_APP_BASE_URL__: JSON.stringify("/") },
      })
    },
  )

  it("normalizes POSIX and Windows Collection files to ESM file URLs", () => {
    expect(toRuntimeModuleSpecifier("/repo/server/collections/meals.ts")).toBe(
      "file:///repo/server/collections/meals.ts",
    )
    expect(toRuntimeModuleSpecifier(String.raw`C:\repo\server\collections\meals.ts`)).toBe(
      "file:///C:/repo/server/collections/meals.ts",
    )
    expect(toTypeModuleSpecifier(String.raw`C:\repo\server\collections\meals.ts`)).toBe(
      "C:/repo/server/collections/meals.ts",
    )
  })

  it("writes a sorted self-excluding entry at the ViteHub project root", async () => {
    const { root, viteRoot } = await createNestedProject()
    await Promise.all([
      writeFile(join(root, ".vitehub/types/markdown-template.d.ts"), 'declare module "*.template.md" {}\n'),
      writeFile(join(root, ".vitehub/env/env.d.ts"), "interface ImportMetaEnv {}\n"),
      writeFile(join(root, ".vitehub/data/blob/upload.d.ts"), "invalid uploaded declaration\n"),
      writeFile(join(root, ".vitehub/sandbox/runtime/sandbox.d.ts"), 'declare module "#vitehub/sandbox" {}\n'),
      writeFile(join(root, ".vitehub/types.d.ts"), "stale self reference\n"),
    ])

    const plugin = viteHubTypesPlugin()
    await configResolved(plugin)({ root: viteRoot })

    await expect(readFile(join(root, ".vitehub/types.d.ts"), "utf8")).resolves.toBe(
      [
        `/// <reference path="./env/env.d.ts" />`,
        `/// <reference path="./sandbox/runtime/sandbox.d.ts" />`,
        `/// <reference path="./types/markdown-template.d.ts" />`,
        ``,
        `export {}`,
        ``,
      ].join("\n"),
    )
    await expect(readFile(join(viteRoot, ".vitehub/types.d.ts"), "utf8")).rejects.toThrow()
  })

  it("refreshes build output and exposes the prepare lifecycle", async () => {
    const { root, viteRoot } = await createNestedProject()
    await mkdir(join(root, "server/collections"), { recursive: true })
    await Promise.all([
      writeFile(join(root, ".vitehub/types/env.d.ts"), "interface ImportMetaEnv {}\n"),
      writeFile(join(root, "server/collections/meals.ts"), collectionModule("meals")),
    ])

    const plugin = viteHubTypesPlugin()
    await configResolved(plugin)({ root: viteRoot })
    await writeFile(join(root, ".vitehub/types/workspace.d.ts"), 'declare module "#vitehub/workspace" {}\n')
    await buildEnd(plugin)()

    await expect(readFile(join(root, ".vitehub/types.d.ts"), "utf8")).resolves.toContain("./types/workspace.d.ts")

    await rm(join(root, ".vitehub/types.d.ts"))
    const stdout = { write: vi.fn() }
    const rawContext: unknown = {
      rootDir: viteRoot,
      stdout,
    }
    // SAFETY: The feature uses only the rootDir and stdout fields supplied by this focused fixture.
    const context = rawContext as ViteHubCliContext
    await prepareFeature(viteHubTypesPlugin()).run([], context)

    await expect(readFile(join(root, ".vitehub/types.d.ts"), "utf8")).resolves.toContain("./types/env.d.ts")
    await expect(readFile(join(root, ".vitehub/types.d.ts"), "utf8")).resolves.toContain("./source/collections.d.ts")
    await expect(readFile(join(root, ".vitehub/source/collections.d.ts"), "utf8")).resolves.toContain(
      `"meals": typeof import(${JSON.stringify(join(root, "server/collections/meals.ts"))})["meals"]`,
    )
    expect(stdout.write).toHaveBeenCalledWith("types: prepared .vitehub/types.d.ts\n")
  })

  it("uses configured server directories during CLI preparation", async () => {
    const { root, viteRoot } = await createNestedProject()
    const serverDir = join(root, "api")
    await mkdir(join(serverDir, "collections"), { recursive: true })
    await writeFile(join(serverDir, "collections/meals.ts"), collectionModule("meals"))

    const plugin = viteHubTypesPlugin()
    await configResolved(plugin)({ root: viteRoot, [VITEHUB_SERVER_DIRS]: [serverDir] })
    const rawContext: unknown = { rootDir: viteRoot, stdout: { write: vi.fn() } }
    // SAFETY: The feature uses only the rootDir and stdout fields supplied by this focused fixture.
    const context = rawContext as ViteHubCliContext
    await prepareFeature(plugin).run([], context)

    await expect(readFile(join(root, ".vitehub/source/collections.d.ts"), "utf8")).resolves.toContain(
      JSON.stringify(join(serverDir, "collections/meals.ts")),
    )
  })

  it("binds the framework Source plugin to framework imports", async () => {
    const { root } = await createNestedProject()
    await mkdir(join(root, "server/collections"), { recursive: true })
    await writeFile(join(root, "server/collections/meals.ts"), collectionModule("meals"))

    const [source, types] = frameworkHubSource()
    await configResolved(source!)({ root })
    await configResolved(types!)({ root })

    await expect(readFile(join(root, ".vitehub/source/routes/meals.mjs"), "utf8")).resolves.toContain(
      'from "vite-hub/source/server"',
    )
    await expect(readFile(join(root, ".vitehub/types.d.ts"), "utf8")).resolves.toContain(
      `./source/collections.d.ts`,
    )
  })

  it("binds direct framework Source preparation to framework imports", async () => {
    const { root } = await createNestedProject()
    await mkdir(join(root, "server/collections"), { recursive: true })
    await writeFile(join(root, "server/collections/meals.ts"), collectionModule("meals"))

    await prepareFrameworkSourceGeneration({ projectRoot: root })

    await expect(readFile(join(root, ".vitehub/source/routes/meals.mjs"), "utf8")).resolves.toContain(
      'from "vite-hub/source/server"',
    )
  })

  it("preserves a custom framework import base during CLI preparation", async () => {
    const { root, viteRoot } = await createNestedProject()
    await mkdir(join(root, "server/collections"), { recursive: true })
    await writeFile(join(root, "server/collections/meals.ts"), collectionModule("meals"))

    const [source, types] = frameworkHubSource({ importBase: "custom-source" })
    await configResolved(source!)({ root: viteRoot })
    await configResolved(types!)({ root: viteRoot })
    const rawContext: unknown = { rootDir: viteRoot, stdout: { write: vi.fn() } }
    // SAFETY: The feature uses only the rootDir and stdout fields supplied by this focused fixture.
    const context = rawContext as ViteHubCliContext
    if (!types || !contributesCli(types)) throw new TypeError("Expected a CLI-contributing types plugin.")
    await prepareFeature(types).run([], context)

    await expect(readFile(join(root, ".vitehub/source/routes/meals.mjs"), "utf8")).resolves.toContain(
      'from "custom-source/server"',
    )
  })

  it("registers server Collections by filename", async () => {
    const { root, viteRoot } = await createNestedProject()
    await mkdir(join(root, "server/collections/admin"), { recursive: true })
    await Promise.all([
      writeFile(join(root, "server/collections/meals.ts"), collectionModule("meals")),
      writeFile(join(root, "server/collections/admin/history.ts"), collectionModule("history")),
    ])

    const plugin = sourcePlugin()
    await configResolved(plugin)({ root: viteRoot })
    const handlers = await plugin.api.prepareSources({ projectRoot: root })
    await viteHubTypesPlugin().api.prepareTypes({ projectRoot: root })

    await expect(readFile(join(root, ".vitehub/source/collections.d.ts"), "utf8")).resolves.toBe(
      [
        `declare global {`,
        `  interface ViteHubCollectionMap {`,
        `    "admin/history": typeof import(${JSON.stringify(join(root, "server/collections/admin/history.ts"))})["history"]`,
        `    "meals": typeof import(${JSON.stringify(join(root, "server/collections/meals.ts"))})["meals"]`,
        `  }`,
        `}`,
        ``,
        `export {}`,
        ``,
      ].join("\n"),
    )
    await expect(readFile(join(root, ".vitehub/types.d.ts"), "utf8")).resolves.toContain(`./source/collections.d.ts`)
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
    await expect(readFile(join(root, ".vitehub/source/routes/meals.mjs"), "utf8")).resolves.toBe(
      [
        `import { defineCollectionHandler } from "vite-hub/source/server"`,
        `import { meals as collection } from ${JSON.stringify(pathToFileURL(join(root, "server/collections/meals.ts")).href)}`,
        ``,
        `export default defineCollectionHandler(collection)`,
        ``,
      ].join("\n"),
    )
  })

  it("serves server/content.ts through the Comark Content runtime", async () => {
    const { root } = await createNestedProject()
    await Promise.all([
      mkdir(join(root, "server"), { recursive: true }),
      symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir"),
    ])
    await writeFile(join(root, "server/content.ts"), contentModule())

    const handlers = await sourcePlugin().api.prepareSources({ projectRoot: root })

    expect(handlers).toEqual([{
      handler: join(root, ".vitehub/content/route.mjs"),
      route: "/api/content/**",
    }])
    await expect(readFile(join(root, ".vitehub/content/route.mjs"), "utf8")).resolves.toBe(
      [
        `import { defineContentHandler } from "vite-hub/source/content"`,
        `import { content } from ${JSON.stringify(pathToFileURL(join(root, "server/content.ts")).href)}`,
        ``,
        `export default defineContentHandler(content)`,
        ``,
      ].join("\n"),
    )
    const generatedModule: unknown = await import(pathToFileURL(handlers[0]!.handler).href)
    const generatedHandler = Reflect.get(Object(generatedModule), "default")
    if (!(generatedHandler instanceof Function)) throw new TypeError("Expected a generated Content handler.")
    const nodeRequest = new IncomingMessage(new Socket())
    nodeRequest.url = "/api/content/custom"
    nodeRequest.method = "POST"
    nodeRequest.headers = {
      host: "internal.test",
      "x-content-test": "preserved",
      "x-forwarded-host": "example.test",
      "x-forwarded-proto": "https",
    }
    nodeRequest.push("content body")
    nodeRequest.push(null)
    // SAFETY: This fixture models the state Node's HTTP parser sets before emitting the completed request body.
    Object.defineProperty(nodeRequest, "complete", { value: true })
    const response: unknown = await generatedHandler(createEvent(nodeRequest, new ServerResponse(nodeRequest)))
    if (!(response instanceof Response)) throw new TypeError("Expected the Content handler to return a response.")
    await expect(response.json()).resolves.toEqual({
      aborted: false,
      body: "content body",
      header: "preserved",
      method: "POST",
      url: "https://example.test/api/content/custom",
    })

    const abortedRequest = new IncomingMessage(new Socket())
    abortedRequest.url = "/api/content/aborted"
    abortedRequest.headers = { host: "example.test" }
    Object.defineProperty(abortedRequest, "aborted", { value: true })
    const abortedResponse: unknown = await generatedHandler(
      createEvent(abortedRequest, new ServerResponse(abortedRequest)),
    )
    if (!(abortedResponse instanceof Response)) throw new TypeError("Expected an aborted Content response.")
    await expect(abortedResponse.json()).resolves.toMatchObject({ aborted: true })
  })

  it("rejects Content definitions that ViteHub cannot serve unambiguously", async () => {
    const { root } = await createNestedProject()
    const firstServerDir = join(root, "api")
    const secondServerDir = join(root, "admin")
    await Promise.all([mkdir(firstServerDir), mkdir(secondServerDir)])
    await Promise.all([
      writeFile(join(firstServerDir, "content.ts"), contentModule()),
      writeFile(join(secondServerDir, "content.ts"), contentModule()),
    ])

    await expect(sourcePlugin().api.prepareSources({
      projectRoot: root,
      serverDirs: [firstServerDir, secondServerDir],
    })).rejects.toThrow("Content is defined in more than one server directory")

    await rm(join(secondServerDir, "content.ts"))
    await writeFile(join(firstServerDir, "content.ts"), "export const other = {}\n")
    await expect(sourcePlugin().api.prepareSources({
      projectRoot: root,
      serverDirs: [firstServerDir],
    })).rejects.toThrow('must export a Comark Content instance named "content"')
  })

  it("rejects a manual route that bypasses generated Content serving", async () => {
    const { root } = await createNestedProject()
    await mkdir(join(root, "server"), { recursive: true })
    await writeFile(join(root, "server/content.ts"), contentModule())

    await expect(config(sourcePlugin())({
      nitro: { handlers: [{ handler: "server/api/content.post.ts", method: "post", route: "/api/content/**" }] },
      root,
    })).rejects.toThrow('Generated Content route "/api/content/**" conflicts with an existing handler')
  })

  it.each([
    ["meals.mjs", "meals.d.mts"],
    ["meals.cjs", "meals.d.cts"],
  ])("ignores declaration files next to %s Collections", async (moduleFile, declarationFile) => {
    const { root } = await createNestedProject()
    const collectionsDirectory = join(root, "server/collections")
    await mkdir(collectionsDirectory, { recursive: true })
    await Promise.all([
      writeFile(join(collectionsDirectory, moduleFile), collectionModule("meals")),
      writeFile(join(collectionsDirectory, declarationFile), "export declare const meals: object\n"),
    ])

    const handlers = await sourcePlugin().api.prepareSources({ projectRoot: root })
    const collectionTypes = await readFile(join(root, ".vitehub/source/collections.d.ts"), "utf8")

    expect(handlers).toEqual([
      {
        handler: join(root, ".vitehub/source/routes/meals.mjs"),
        method: "get",
        route: "/api/meals",
      },
    ])
    expect(collectionTypes).toContain(JSON.stringify(join(collectionsDirectory, moduleFile)))
    expect(collectionTypes).not.toContain(declarationFile)
  })

  it("loads a generated Collection handler through its normalized module specifier", async () => {
    const { root } = await createNestedProject()
    await Promise.all([
      mkdir(join(root, "server/collections"), { recursive: true }),
      symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir"),
    ])
    await writeFile(join(root, "server/collections/meals.ts"), collectionModule("meals"))

    const [handler] = await sourcePlugin().api.prepareSources({ projectRoot: root })

    await expect(import(pathToFileURL(handler!.handler).href)).resolves.toHaveProperty("default", expect.any(Function))
  })

  it("registers generated Collection handlers in plain Vite Nitro config", async () => {
    const { root } = await createNestedProject()
    await mkdir(join(root, "server/collections"), { recursive: true })
    await writeFile(join(root, "server/collections/meals.ts"), collectionModule("meals"))
    const existing = { handler: "server/health.ts", method: "get", route: "/api/health" }
    const userConfig: {
      nitro: { handlers: (typeof existing)[]; modules?: Array<{ name?: string }> }
      root: string
    } = { nitro: { handlers: [existing] }, root }

    await config(sourcePlugin())(userConfig)

    expect(userConfig.nitro.handlers).toEqual([
      existing,
      {
        handler: join(root, ".vitehub/source/routes/meals.mjs"),
        method: "get",
        route: "/api/meals",
      },
    ])
    expect(userConfig.nitro.modules).toContainEqual(
      expect.objectContaining({ name: "vite-hub/generated-route-guard" }),
    )
  })

  it("rejects a conflicting plain Vite Nitro handler", async () => {
    const { root } = await createNestedProject()
    await mkdir(join(root, "server/collections"), { recursive: true })
    await writeFile(join(root, "server/collections/meals.ts"), collectionModule("meals"))

    await expect(
      config(sourcePlugin())({
        nitro: { handlers: [{ handler: "server/api/meals.ts", route: "/api/meals" }] },
        root,
      }),
    ).rejects.toThrow('Generated Collection route "/api/meals" conflicts with an existing GET handler')
  })

  it.each(["export const publicMeals = {}\n", "export type meals = {}\nexport const publicMeals = {}\n"])(
    "rejects a Collection module without its filename-matching runtime export",
    async source => {
      const { root } = await createNestedProject()
      await mkdir(join(root, "server/collections"), { recursive: true })
      await writeFile(join(root, "server/collections/meals.ts"), source)

      const plugin = sourcePlugin()
      await expect(plugin.api.prepareSources({ projectRoot: root })).rejects.toThrow(
        'Collection file "server/collections/meals.ts" must export a Collection named "meals" to match its filename',
      )
      await expect(readFile(join(root, ".vitehub/source/collections.d.ts"), "utf8")).rejects.toThrow()
      await expect(readFile(join(root, ".vitehub/source/routes/meals.mjs"), "utf8")).rejects.toThrow()
    },
  )

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

    const plugin = sourcePlugin()
    const handlers = await plugin.api.prepareSources({
      projectRoot: root,
      serverDirs: [firstServerDir, secondServerDir],
    })

    expect(handlers.map((handler: { route: string }) => handler.route)).toEqual(["/api/audit", "/api/meals"])
    await expect(readFile(join(root, ".vitehub/source/collections.d.ts"), "utf8")).resolves.toContain(
      JSON.stringify(join(firstServerDir, "collections/meals.ts")),
    )

    await writeFile(join(secondServerDir, "collections/meals.ts"), collectionModule("meals"))
    await expect(
      plugin.api.prepareSources({
        projectRoot: root,
        serverDirs: [firstServerDir, secondServerDir],
      }),
    ).rejects.toThrow('Collection name "meals" is defined in more than one server directory')
  })

  it("rejects case-only Collection route-module collisions across server directories", async () => {
    const { root } = await createNestedProject()
    const firstServerDir = join(root, "api")
    const secondServerDir = join(root, "admin")
    await Promise.all([
      mkdir(join(firstServerDir, "collections"), { recursive: true }),
      mkdir(join(secondServerDir, "collections"), { recursive: true }),
    ])
    await Promise.all([
      writeFile(join(firstServerDir, "collections/Meals.ts"), collectionModule("Meals")),
      writeFile(join(secondServerDir, "collections/meals.ts"), collectionModule("meals")),
    ])

    await expect(
      sourcePlugin().api.prepareSources({
        projectRoot: root,
        serverDirs: [firstServerDir, secondServerDir],
      }),
    ).rejects.toThrow(
      'Collection names "Meals" and "meals" generate the same route module on case-insensitive filesystems',
    )
  })

  it("preserves an explicitly empty server directory selection", async () => {
    const { root } = await createNestedProject()
    await mkdir(join(root, "server/collections"), { recursive: true })
    await Promise.all([
      writeFile(join(root, "server/collections/meals.ts"), collectionModule("meals")),
      writeFile(join(root, "server/content.ts"), contentModule()),
    ])

    const plugin = sourcePlugin()
    await plugin.api.prepareSources({ projectRoot: root })
    const collectionTypes = join(root, ".vitehub/source/collections.d.ts")
    const collectionRoute = join(root, ".vitehub/source/routes/meals.mjs")
    const contentRoute = join(root, ".vitehub/content/route.mjs")
    const timestamps = await Promise.all([collectionTypes, collectionRoute, contentRoute].map(async file => (await stat(file)).mtimeMs))
    await plugin.api.prepareSources({ projectRoot: root })
    await expect(Promise.all([collectionTypes, collectionRoute, contentRoute].map(async file => (await stat(file)).mtimeMs))).resolves.toEqual(timestamps)

    const handlers = await plugin.api.prepareSources({
      projectRoot: root,
      serverDirs: [],
    })

    expect(handlers).toEqual([])
    await expect(readFile(collectionTypes, "utf8")).rejects.toThrow()
    await expect(readFile(collectionRoute, "utf8")).rejects.toThrow()
    await expect(readFile(contentRoute, "utf8")).rejects.toThrow()
  })

  it("preserves configured server directories across Vite lifecycle refreshes", async () => {
    const { root, viteRoot } = await createNestedProject()
    const serverDir = join(root, "api")
    await mkdir(join(serverDir, "collections"), { recursive: true })
    await writeFile(join(serverDir, "collections/meals.ts"), collectionModule("meals"))

    const plugin = sourcePlugin()
    await configResolved(plugin)({
      root: viteRoot,
      [VITEHUB_SERVER_DIRS]: [serverDir],
    })
    await buildStart(plugin)()

    await expect(readFile(join(root, ".vitehub/source/routes/meals.mjs"), "utf8")).resolves.toContain(
      JSON.stringify(pathToFileURL(join(serverDir, "collections/meals.ts")).href),
    )
  })

  it("prepares Source declarations before lifecycle aggregation without a global hook barrier", async () => {
    const { root, viteRoot } = await createNestedProject()
    const generatedDeclaration = join(root, ".vitehub/source/delayed.d.ts")
    const prepareSources = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 10))
      await mkdir(join(root, ".vitehub/source"), { recursive: true })
      await writeFile(generatedDeclaration, "export {}\n")
    })
    const typesPlugin = viteHubTypesPlugin({ prepareSources })
    await configResolved(typesPlugin)({ root: viteRoot })

    expect(typesPlugin.buildEnd).toBeTypeOf("function")
    await buildEnd(typesPlugin)()

    expect(prepareSources).toHaveBeenCalledWith({ projectRoot: root, serverDirs: undefined })
    await expect(readFile(join(root, ".vitehub/types.d.ts"), "utf8")).resolves.toContain(
      "./source/delayed.d.ts",
    )
  })
})
