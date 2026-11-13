import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, it } from "vitest"

import { inspectCollectionModule, mergeGeneratedSourceNitroConfig, prepareSourceGeneration } from "../src/vite.ts"

async function generatedRoutes(files: Record<string, string>) {
  const projectRoot = await mkdtemp(join(tmpdir(), "source-routes-"))
  try {
    for (const [file, source] of Object.entries(files)) {
      await mkdir(join(projectRoot, file, ".."), { recursive: true })
      await writeFile(join(projectRoot, file), source)
    }
    const handlers = await prepareSourceGeneration({ projectRoot })
    const contentRoute = await access(join(projectRoot, ".vitehub/content/route.mjs")).then(() => true, () => false)
    const preview = join(projectRoot, ".vitehub/content/preview.mjs")
    const contentPreview = handlers.some(handler => handler.plugin && handler.handler === preview)
      ? await readFile(preview, "utf8")
      : ""
    const collectionTypes = await readFile(join(projectRoot, ".vitehub/types/source/collections.d.ts"), "utf8").catch((error: unknown) => {
      if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") return ""
      throw error
    })
    return { collectionTypes, contentRoute, contentPreview, routes: handlers.flatMap(handler => handler.route ?? []) }
  }
  finally {
    await rm(projectRoot, { recursive: true, force: true })
  }
}

it.each([
  "export const articles = defineCollection({ source: glob('docs/**/*.md'), route: false })",
  "export const articles = defineCollection(load, { route: false })",
  "export const articles =\n defineCollection(load, { route: false })",
  "export const articles = defineCollection(load, { ...unknownOptions, route: false })",
  "export const articles = defineCollection(load, { route: false } as const) satisfies Collection<Row>",
  "export { articles }; const articles: Collection<Row> = defineCollection(load, { route: false })",
  "const $articles = ((defineCollection(load, { route: false }))); export { $articles as articles }",
  "import { defineCollection } from 'vite-hub/source'; export const articles = defineCollection(load, { route: false })",
  "import { defineCollection } from '@vite-hub/source'; export const articles = defineCollection(load, { route: false })",
])("skips the route of a literal route: false in %s", async (source) => {
  expect((await generatedRoutes({ "server/collections/articles.ts": source })).routes).toEqual([])
})

it("reads TypeScript syntax in a .mjs Collection file", async () => {
  const source = "type Row = { id: number }\nexport const articles: Collection<Row> = defineCollection(load, { route: false } as const)"
  expect((await generatedRoutes({ "server/collections/articles.mjs": source })).routes).toEqual([])
})

it.each([
  "export const articles = defineCollection(load, {})",
  "function make(route?: false) { return defineCollection(load, { route }) }; export const articles = make()",
  "const options = {}; function unused() { options.route = false }; export const articles = defineCollection(load, options)",
  "let route = undefined; function unused() { route = false }; export const articles = defineCollection(load, { route })",
  "const options = {}; if (false) options.route = false; export const articles = defineCollection(load, options)",
  "const options = { route: false }; if (true) options.route = undefined; export const articles = defineCollection(load, options)",
  "function make(options = { route: false }) { return defineCollection(load, options) }; export const articles = make({})",
  "const options = {}; function publicA() { options.route = undefined }; function publicB() { options.route = undefined }; function make() { dynamic ? publicA() : publicB(); return defineCollection(load, options) }; export const articles = make()",
  "const options: { route?: false } = { route: false }; options.route = undefined; export const articles = defineCollection(load, options)",
  "const { route } = { route: undefined }; export const articles = defineCollection(load, { route })",
  "const usePrivate = false; export const articles = usePrivate ? defineCollection(load, { route: false }) : defineCollection(load, {})",
  "export const articles = ((first, second) => second)(defineCollection(load, { route: false }), defineCollection(load, {}))",
  "export const articles = (() => { const unused = defineCollection(load, { route: false }); return defineCollection(load, {}) })()",
  "let route: false | undefined = false; route = undefined; export const articles = defineCollection(load, { route })",
  "var route = false; route = undefined; export const articles = defineCollection(load, { route })",
  "const options = { route: false }; export const articles = (() => { const options = {}; return defineCollection(load, options) })()",
  "const route = false; export const articles = ((route) => defineCollection(load, { route }))(undefined)",
  "const route = false; export const articles = (() => { let route = false; route = undefined; return defineCollection(load, { route }) })()",
  "const options = { route: false }; function make() { const options = {}; return defineCollection(load, options) }; export const articles = make()",
  "const prefix = 'rou'; export const articles = defineCollection(load, { [`${prefix}${prefix}`]: false })",
  "export const articles = defineCollection(load, { route: false, ...{ route: undefined } })",
  "const key = 'cache'; export const articles = defineCollection(load, { [key]: false })",
  "export const articles = other; const unrelated = defineCollection(load, { route: false })",
  "export const articles = other\nconst unrelated = defineCollection(load, { route: false })",
  "export const articles = other, unrelated = defineCollection(load, { route: false })",
  "const articles = other; export { articles }; const unrelated = defineCollection(load, { route: false })",
  "export const articles = other\ndefineCollection(load, { route: false })",
])("keeps the route of %s", async (source) => {
  expect((await generatedRoutes({ "server/collections/articles.ts": source })).routes).toEqual(["/api/articles"])
})

// The build reads the file and does not run it. When it cannot see a literal `route: false`, it writes the route, and
// `defineCollectionHandler()` answers 404 at request time.
it.each([
  "import { defineCollection as makeCollection } from 'vite-hub/source'; export const articles = makeCollection(load, { route: false })",
  "import * as source from '@vite-hub/source'; export const articles = source.defineCollection(load, { route: false })",
  "const hidden = { route: false }; export const articles = defineCollection(load, hidden)",
  "const options = {}; options.route = false; export const articles = defineCollection(load, options)",
  "const route = false; export const articles = defineCollection(load, { route })",
  "const key = 'route'; export const articles = defineCollection(load, { [key]: false })",
  "export const articles = (() => defineCollection(load, { route: false }))()",
  "const usePrivate = true; export const articles = usePrivate ? defineCollection(load, { route: false }) : defineCollection(load, {})",
  // A local factory with the same name can return a public Collection.
  "import { defineCollection as base } from '@vite-hub/source'; function defineCollection(load, options) { return base(load, { ...options, route: undefined }) }; export const articles = defineCollection(load, { route: false })",
  "const defineCollection = (load, options) => base(load, {}); export const articles = defineCollection(load, { route: false })",
  "import { defineCollection } from './collection-helpers'; export const articles = defineCollection(load, { route: false })",
  // Only a `const` keeps its initializer: a later `var` declaration exports another Collection.
  "export var articles = defineCollection(load, { route: false }); var articles = defineCollection(load, {})",
  "export let articles = defineCollection(load, { route: false })",
])("writes the route when route: false is not a literal in the exported call: %s", async (source) => {
  expect((await generatedRoutes({ "server/collections/articles.ts": source })).routes).toEqual(["/api/articles"])
})

it.each([
  "const { defineCollection } = helpers",
  "const { make: defineCollection } = { make: helpers.defineCollection }",
  "const { nested: { defineCollection } } = { nested: helpers }",
  "const [defineCollection] = [helpers.defineCollection]",
  "const { defineCollection = helpers.defineCollection } = {}",
  "const [defineCollection = helpers.defineCollection] = []",
  "const [...[defineCollection]] = [helpers.defineCollection]",
])("keeps a destructured helper's route and registry entry: %s", async (binding) => {
  const source = `
    import { defineCollection as baseCollection } from '@vite-hub/source'
    const load = async () => ({ items: [{ id: 1 }], nextCursor: null })
    const helpers = {
      defineCollection(load, options) {
        return baseCollection(load, { ...options, route: undefined })
      },
    }
    ${binding}
    export const articles = defineCollection(load, { pagination: 'provider', route: false })
  `
  const generated = await generatedRoutes({ "server/collections/articles.mjs": source })
  expect(generated.routes).toEqual(["/api/articles"])
  expect(generated.collectionTypes).toContain('"articles": typeof import(')
  expect(inspectCollectionModule("articles.mjs", source, "articles")).toEqual({ exported: true, routeEnabled: true })
})

it.each([
  "sources: {}",
  "sources: {}, collections: {}",
  "sources: {}, route: false",
])("installs cache isolation for Content without collections: %s", async (options) => {
  const generated = await generatedRoutes({
    "server/content.ts": `import { defineContent } from '@vite-hub/content'\nexport default defineContent({ ${options} })`,
  })
  expect(generated.contentPreview).toContain('import { defineContentPreviewPlugin } from "@vite-hub/content/preview"')
  expect(generated.contentPreview).toContain("export default defineContentPreviewPlugin(() => import(")
})

// The call shape of joyandmaxi `server/content.ts`.
it("skips the Content route for defineContent({ route: false, ... })", async () => {
  const generated = await generatedRoutes({
    "server/content.ts": [
      "import { defineContent, documents, image, optional, type DocumentComponent } from 'vite-hub/content'",
      "import cms from 'vite-hub/cms'",
      "import { guideFields, guidePath } from '../shared/guide'",
      "import { isEditor } from './utils/editors'",
      "",
      "const fields = { ...guideFields, icon: image({ store: 'media' }), hero: optional(image({ store: 'media' })) }",
      "const components = { note: { label: 'Wedding note' } } satisfies Record<string, DocumentComponent>",
      "",
      "export default defineContent({",
      "  route: false,",
      "  extends: cms,",
      "  collections: {",
      "    en: documents({ path: 'content/en/**/*.md', fields, components, label: 'English', url: ({ id }) => guidePath(id) }),",
      "    es: documents({ path: 'content/es/**/*.md', fields, components, label: 'Español', url: ({ id }) => `/es${guidePath(id)}` }),",
      "  },",
      "  authorize: ({ user }) => isEditor(user),",
      "  seo: { site: 'https://joyandmaxi.com', sitemap: false, robots: { disallow: ['/_vitehub', '/api', '/login', '/admin'] } },",
      "})",
      "",
    ].join("\n"),
  })

  expect(generated.contentRoute).toBe(false)
  expect(generated.routes).toEqual(["/robots.txt"])
})

it.each([
  ["vite-hub/source", ["/_vitehub/content/github", "/api/content/**"]],
  ["@vite-hub/source", ["/_vitehub/content/github", "/api/content/**"]],
])("adds the GitHub push webhook route when server/content.ts imports github from %s", async (module, routes) => {
  const generated = await generatedRoutes({
    "server/content.ts": `import { defineContent } from "vite-hub/content"\nimport { github } from "${module}"\n\nexport default defineContent({ sources: { docs: github({ repo: "acme/docs" }) } })\n`,
  })
  expect(generated.routes).toEqual(routes)
})

it.each([
  ["previews: true", true],
  ["previews: { source: \"docs\" }", true],
  ["previews: false", false],
  ["route: true", false],
])("generates the preview routes plugin for %s", async (option, generated) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "source-routes-"))
  try {
    await mkdir(join(projectRoot, "server"), { recursive: true })
    await writeFile(join(projectRoot, "server/content.ts"), `import { defineContent } from "vite-hub/content"\nimport { github } from "vite-hub/source"\n\nexport default defineContent({ sources: { docs: github({ repo: "acme/docs" }) }, ${option} })\n`)
    const handlers = await prepareSourceGeneration({ projectRoot, contentImportBase: "vite-hub/content" })
    const plugin = join(projectRoot, ".vitehub/content/preview-routes.mjs")
    expect(handlers.some(handler => handler.plugin && handler.handler === plugin)).toBe(generated)
    // A plugin, so no route of the app can conflict with the preview URLs.
    expect(handlers.flatMap(handler => handler.route ?? [])).toEqual(["/_vitehub/content/github", "/api/content/**"])
    if (generated) {
      expect(await readFile(plugin, "utf8")).toContain('import { defineContentPreviewRoutesPlugin } from "vite-hub/content/preview"')
      const config = mergeGeneratedSourceNitroConfig({ plugins: ["async.mjs"] }, handlers)
      expect(config.plugins![0]).toBe(plugin)
      expect(config.plugins).toContain("async.mjs")
      expect(mergeGeneratedSourceNitroConfig(config, handlers).plugins).toEqual(config.plugins)
    }
    else await expect(access(plugin)).rejects.toMatchObject({ code: "ENOENT" })
  }
  finally {
    await rm(projectRoot, { recursive: true, force: true })
  }
})

it("keeps preview interception, RSS, and LLMs routes together, then removes both artifacts", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "source-routes-"))
  try {
    await mkdir(join(projectRoot, "server"), { recursive: true })
    const entry = join(projectRoot, "server/content.ts")
    await writeFile(entry, 'import { defineContent } from "vite-hub/content"\nexport default defineContent({ previews: true, seo: { rss: true, llms: true } })')
    const handlers = await prepareSourceGeneration({ projectRoot })
    const plugin = join(projectRoot, ".vitehub/content/preview-routes.mjs")
    const llms = join(projectRoot, ".vitehub/content/llms.mjs")
    expect(mergeGeneratedSourceNitroConfig({ plugins: ["async.mjs"] }, handlers).plugins![0]).toBe(plugin)
    expect(handlers.filter(handler => handler.handler === llms).map(handler => handler.route)).toEqual(["/llms-full.txt", "/llms.txt", "/sitemap.md"])
    expect(handlers.some(handler => handler.handler === join(projectRoot, ".vitehub/content/markdown.mjs"))).toBe(true)
    await access(plugin)
    await access(llms)
    expect(handlers.some(handler => handler.route === "/rss.xml")).toBe(true)
    await access(join(projectRoot, ".vitehub/content/rss.mjs"))
    await rm(entry)
    await prepareSourceGeneration({ projectRoot })
    await expect(access(plugin)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(access(llms)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(access(join(projectRoot, ".vitehub/content/rss.mjs"))).rejects.toMatchObject({ code: "ENOENT" })
  }
  finally {
    await rm(projectRoot, { recursive: true, force: true })
  }
})

it("adds no GitHub push webhook route without a github() Source", async () => {
  const generated = await generatedRoutes({
    "server/content.ts": `import { defineContent } from "vite-hub/content"\nimport { glob } from "vite-hub/source"\n\nexport default defineContent({ sources: { docs: glob("docs/**/*.md") } })\n`,
  })
  expect(generated.routes).toEqual(["/api/content/**"])
})

it("removes the Collection types wrapper that earlier versions wrote", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "source-routes-"))
  try {
    const wrapper = join(projectRoot, ".vitehub/types/source/vitehub-source-registry.d.ts")
    await mkdir(join(projectRoot, ".vitehub/types/source"), { recursive: true })
    await writeFile(wrapper, '/// <reference path="./collections.d.ts" />\n')
    expect(await prepareSourceGeneration({ projectRoot })).toEqual([])
    await expect(access(wrapper)).rejects.toMatchObject({ code: "ENOENT" })
  }
  finally {
    await rm(projectRoot, { recursive: true, force: true })
  }
})
