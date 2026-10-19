import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { collectViteHubDefinitionInspectors } from "@vite-hub/internal/inspect"
import { resolveConfig } from "vite"
import { afterEach, describe, expect, it } from "vitest"

import { hubSource, inspectCollectionDefinitions } from "../src/vite.ts"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { force: true, recursive: true })))
})

async function createProject(files: Record<string, string>): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "source-inspect-"))
  directories.push(projectRoot)
  for (const [file, contents] of Object.entries(files)) {
    await mkdir(join(projectRoot, file, ".."), { recursive: true })
    await writeFile(join(projectRoot, file), contents)
  }
  return projectRoot
}

async function inspectOne(source: string) {
  const projectRoot = await createProject({ "server/collections/articles.ts": source })
  const [summary] = await inspectCollectionDefinitions({ projectRoot })
  return summary
}

describe("inspectCollectionDefinitions", () => {
  it("reads array() options", async () => {
    const summary = await inspectOne(`
      import * as v from "valibot"
      import { array, defineCollection } from "@vite-hub/source"

      export const articles = defineCollection({
        source: array(() => loadArticles(), {
          schema: v.object({ slug: v.string(), title: v.string(), ...extra }),
          filters: ["category", 'authors.name'],
          search: ["title"] as const,
          facets: ["category"],
          sort: { field: "publishedAt", direction: "desc" },
          key: "slug",
          defaultLimit: 25,
          maxLimit: 1_000,
        }),
        transform: article => ({ slug: article.slug }),
      })
    `)
    expect(summary).toEqual({
      fields: [
        { label: "Source", value: "array" },
        { label: "Schema", value: "v.object(...)" },
        { label: "Schema fields", value: "Dynamic" },
        { label: "Key", value: "slug" },
        { label: "Sort", value: "publishedAt desc" },
        { label: "Filters", value: "category, authors.name" },
        { label: "Search", value: "title" },
        { label: "Facets", value: "category" },
        { label: "Default limit", value: "25" },
        { label: "Max limit", value: "1000" },
        { label: "Transform", value: "Yes" },
        { label: "Route", value: "GET /api/articles" },
      ],
      file: "server/collections/articles.ts",
      name: "articles",
      source: "server-collections",
    })
  })

  it("lists top-level fields of an inline object schema", async () => {
    const summary = await inspectOne(`
      export const articles = defineCollection({
        source: array(load, { schema: z.object({ slug: z.string(), "title": z.string() }), sort: { field: "title" } }),
      })
    `)
    expect(summary?.fields).toEqual([
      { label: "Source", value: "array" },
      { label: "Schema", value: "z.object(...)" },
      { label: "Schema fields", value: "slug, title" },
      { label: "Sort", value: "title asc" },
      { label: "Transform", value: "No" },
      { label: "Route", value: "GET /api/articles" },
    ])
  })

  it("reads table() options", async () => {
    const summary = await inspectOne(`
      export const articles = defineCollection({
        source: table({
          db,
          table: schema.articles,
          orderBy: { column: schema.articles.createdAt, direction: "desc", tieBreaker: schema.articles.id },
          querySchema: articleQuery,
          where: ({ query, table }) => eq(table.author, query.author),
          defaultLimit: 10,
        }),
        authorize: true,
      })
    `)
    expect(summary?.fields).toEqual([
      { label: "Source", value: "table" },
      { label: "Table", value: "schema.articles" },
      { label: "Sort", value: "schema.articles.createdAt desc, then schema.articles.id" },
      { label: "Query schema", value: "articleQuery" },
      { label: "Where", value: "Callback" },
      { label: "Default limit", value: "10" },
      { label: "Transform", value: "No" },
      { label: "Authorize", value: "Signed-in session" },
      { label: "Route", value: "GET /api/articles" },
    ])
  })

  it("reads a custom source object", async () => {
    const summary = await inspectOne(`
      const querySchema = v.object({ author: v.optional(v.string()) })
      export const articles = defineCollection({
        source: { load: listArticles, pagination: "provider", querySchema, maxLimit: 50 },
        async authorize({ user }) { return user.role === "owner" },
      })
    `)
    expect(summary?.fields).toEqual([
      { label: "Source", value: "custom" },
      { label: "Pagination", value: "Provider" },
      { label: "Query schema", value: "querySchema" },
      { label: "Max limit", value: "50" },
      { label: "Transform", value: "No" },
      { label: "Authorize", value: "Callback" },
      { label: "Route", value: "GET /api/articles" },
    ])
  })

  it("reads the positional loader form and route: false", async () => {
    const summary = await inspectOne(`
      export const articles = defineCollection(async ({ cursor, limit }) => db.list({ cursor, limit }), {
        cursor: article => [article.createdAt, article.id] as const,
        cursorSchema: v.tuple([v.number(), v.string()]),
        querySchema: v.object({ author: v.optional(v.string()) }),
        transform: article => ({ id: article.id }),
        authorize: ({ user }) => Boolean(user),
        route: false,
      })
    `)
    expect(summary?.fields).toEqual([
      { label: "Source", value: "loader" },
      { label: "Pagination", value: "Cursor" },
      { label: "Cursor schema", value: "v.tuple(...)" },
      { label: "Query schema", value: "v.object(...)" },
      { label: "Query schema fields", value: "author" },
      { label: "Transform", value: "Yes" },
      { label: "Authorize", value: "Callback" },
      { label: "Route", value: "Disabled" },
    ])
  })

  it("shows values that are not static as Dynamic or unknown", async () => {
    const projectRoot = await createProject({
      "server/collections/articles.ts": `
        export const articles = defineCollection({
          source: array(load, { filters: fields, search: ["title", searchField], sort: sortOrder, key: keyName, defaultLimit: limit }),
          authorize: checkAccess,
        })
      `,
      "server/collections/authors.ts": "export const authors = defineCollection({ source: authorSource })",
      "server/collections/books.ts": "export const books = defineCollection(bookOptions)",
      "server/collections/tags.ts": "export const tags = createTags()",
      "server/collections/docs/guides.ts": "export const guides = defineCollection({ source: glob('docs/**/*.md'), route: false })",
    })
    const summaries = await inspectCollectionDefinitions({ projectRoot })
    expect(summaries.map(summary => [summary.name, summary.file, summary.fields])).toEqual([
      ["articles", "server/collections/articles.ts", [
        { label: "Source", value: "array" },
        { label: "Key", value: "Dynamic" },
        { label: "Sort", value: "Dynamic" },
        { label: "Filters", value: "Dynamic" },
        { label: "Search", value: "Dynamic" },
        { label: "Default limit", value: "Dynamic" },
        { label: "Transform", value: "No" },
        { label: "Authorize", value: "Dynamic" },
        { label: "Route", value: "GET /api/articles" },
      ]],
      ["authors", "server/collections/authors.ts", [
        { label: "Source", value: "unknown" },
        { label: "Transform", value: "No" },
        { label: "Route", value: "GET /api/authors" },
      ]],
      ["books", "server/collections/books.ts", [
        { label: "Source", value: "unknown" },
        { label: "Options", value: "Dynamic" },
        { label: "Route", value: "GET /api/books" },
      ]],
      ["docs/guides", "server/collections/docs/guides.ts", [
        { label: "Source", value: "glob" },
        { label: "Transform", value: "No" },
        { label: "Route", value: "Disabled" },
      ]],
      ["tags", "server/collections/tags.ts", [
        { label: "Source", value: "unknown" },
        { label: "Route", value: "GET /api/tags" },
      ]],
    ])
  })

  it("does not import the Collection module", async () => {
    const summary = await inspectOne(`
      throw new Error("Collection modules must not run during inspection")
      export const articles = defineCollection({ source: array(load, { key: "slug" }) })
    `)
    expect(summary?.fields).toContainEqual({ label: "Key", value: "slug" })
  })

  it("reads custom server directories", async () => {
    const projectRoot = await createProject({ "app/server/collections/articles.ts": "export const articles = defineCollection({ source: array(load) })" })
    const summaries = await inspectCollectionDefinitions({ projectRoot, serverDirs: ["app/server"] })
    expect(summaries.map(summary => summary.file)).toEqual(["app/server/collections/articles.ts"])
  })
})

describe("hubSource inspection metadata", () => {
  it("contributes a Collection inspector for the configured project", async () => {
    const projectRoot = await createProject({
      "server/collections/articles.ts": "export const articles = defineCollection({ source: array(load, { key: 'slug' }) })",
    })
    const plugin = hubSource()
    await resolveConfig({ configFile: false, logLevel: "silent", plugins: [plugin], root: projectRoot }, "build")

    const [inspector] = await collectViteHubDefinitionInspectors([plugin])
    expect(inspector).toMatchObject({ kind: "collection", label: "Collections" })
    expect(await inspector?.list()).toEqual([{
      fields: [
        { label: "Source", value: "array" },
        { label: "Key", value: "slug" },
        { label: "Transform", value: "No" },
        { label: "Route", value: "GET /api/articles" },
      ],
      file: "server/collections/articles.ts",
      name: "articles",
      source: "server-collections",
    }])
  })
})
