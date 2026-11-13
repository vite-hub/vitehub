import { describe, expectTypeOf, it } from "vitest"
import type { AccessAuthorizeOption } from "@vite-hub/runtime"
import * as v from "valibot"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

import {
  type CollectionQuery,
  createSource,
  defineCollection,
  defineSource,
  registerSources,
  sourceIgnores,
  type Source,
  type FileSource,
  type SourceFile,
  type SourceContext,
  type SourceReader,
  type SourceData,
  type SourceItem,
  type SourceMetadata,
  type SourceRevision,
  useSource,
} from "../src/index.ts"
import { file, github, glob } from "../src/index.ts"
import { mcpResources, type McpResourcesClient, type McpResourcesTransport } from "../src/mcp.ts"

interface Meal {
  analysis: {
    costUsd: number
    model: string
  }
  calories: number
  name: string
  photo: {
    key: string
    mediaType: string
  }
}

interface MealMetadata {
  revision: string
}

declare global {
  interface ViteHubSourceMap {
    articles: Source
    custom: Source
    dbt: FileSource
    docs: FileSource<"README.md" | "guide/setup.md">
    dynamic: FileSource
    github: FileSource
    meals: Source<`meal_${string}`, Meal, MealMetadata>
    readme: FileSource<"README.md">
  }
}

describe("@vite-hub/source types", () => {
  it("infers direct reader records and restricts file methods to readable items", async () => {
    const records = defineSource({
      name: "records",
      async getKeys() { return ["article_1"] },
      async getItem(key: `article_${number}`) {
        return { key, data: { title: "One", count: 1 }, metadata: { revision: "1" } }
      },
      async getMeta() { return { revision: "1" } },
    })
    const reader = createSource(records)
    const item = await reader.get("article_1")
    expectTypeOf(item.data).toEqualTypeOf<{ title: string; count: number }>()
    expectTypeOf(item.metadata).toEqualTypeOf<{ revision: string }>()
    expectTypeOf<SourceData<typeof records>>().toEqualTypeOf<{ title: string; count: number }>()
    expectTypeOf<SourceMetadata<typeof records>>().toEqualTypeOf<{ revision: string }>()
    expectTypeOf(reader).toEqualTypeOf<SourceReader<typeof records>>()
    expectTypeOf(await reader.items()).toEqualTypeOf<Array<typeof item>>()
    // @ts-expect-error Record readers have no readable content guarantee.
    reader.read("article_1")
    // @ts-expect-error Record keys are not filesystem directories.
    reader.list()
    // @ts-expect-error The reader retains the definition's key type.
    reader.get("other")

    const docs = createSource(file("README.md"))
    expectTypeOf(await docs.read("README.md")).toBeString()
    expectTypeOf(await docs.read("README.md", { encoding: "binary" })).toEqualTypeOf<Uint8Array>()
    // @ts-expect-error File keys stay inferred without a global map.
    docs.read("missing.md")
    // @ts-expect-error Definitions describe loaders; keyed readers are plain objects.
    defineSource({ get: async (key: string) => key })
    // @ts-expect-error createSource opens a definition, not an arbitrary reader factory.
    createSource(() => ({ get: async (key: string) => key }))
  })

  it("accepts only shared keys when a direct definition is a union", async () => {
    const definition = Math.random() > 0.5 ? file("a.md") : file("b.md")
    const reader = createSource(definition)
    expectTypeOf(await reader.keys()).toEqualTypeOf<"a.md"[] | "b.md"[]>()
    // @ts-expect-error A key must be valid for every possible definition.
    reader.get("a.md")
    // @ts-expect-error File helpers retain the same safe input keys.
    reader.read("b.md")
  })

  it("preserves optional bulk and metadata implementations", async () => {
    const source = defineSource({
      name: "records",
      async getKeys() { return ["one"] },
      async getItem(key: string) { return { key, data: { title: "One" } } },
      ...(Math.random() > 0.5 ? {
        async getItems() { return [{ key: "one", data: { count: 1 } }] },
        async getMeta() { return { revision: "1" } },
      } : {}),
    })
    const reader = createSource(source)
    expectTypeOf(await reader.items()).toEqualTypeOf<
      Array<{ key: string; data: { title: string } }> | Array<{ key: string; data: { count: number } }>
    >()
    expectTypeOf(await reader.meta("one")).toEqualTypeOf<{ revision: string } | undefined>()
    const noMeta = createSource(defineSource({
      name: "records",
      async getKeys() { return ["one"] },
      async getItem(key: string) { return { key, data: { title: "One" } } },
    }))
    expectTypeOf(await noMeta.meta("one")).toEqualTypeOf<undefined>()
  })

  it("infers Collection source rows, transformed items, cursors, and queries", async () => {
    const collection = defineCollection(
      async ({ cursor, limit, query }) => {
        expectTypeOf(cursor).toEqualTypeOf<[number, string] | undefined>()
        expectTypeOf(limit).toBeNumber()
        expectTypeOf(query).toEqualTypeOf<{ day?: string }>()
        return [{ createdAt: 1, id: "meal_1", photoPath: "private/original" }]
      },
      {
        authorize: false,
        cursor: row => [row.createdAt, row.id] as const,
        cursorSchema: v.tuple([v.number(), v.string()]),
        querySchema: v.object({ day: v.optional(v.string()) }),
        transform(row) {
          return { createdAt: new Date(row.createdAt).toISOString(), id: row.id }
        },
      },
    )

    const page = await collection.page({ query: { day: "2026-08-21" } })
    expectTypeOf(page.items).toEqualTypeOf<Array<{ createdAt: string; id: string }>>()
    expectTypeOf(await collection.parseQuery({ day: "2026-08-21" })).toEqualTypeOf<{
      day?: string
    }>()

    const transformedQuery = defineCollection(
      async ({ query }) => {
        expectTypeOf(query).toEqualTypeOf<{ search: string }>()
        return [{ id: query.search }]
      },
      {
        authorize: false,
        cursor: row => row.id,
        cursorSchema: v.string(),
        querySchema: v.pipe(
          v.object({ q: v.string() }),
          v.transform(({ q }) => ({ search: q })),
        ),
      },
    )
    expectTypeOf<CollectionQuery<typeof transformedQuery>>().toEqualTypeOf<{ q: string }>()

    defineCollection(
      async ({ cursor }) => {
        expectTypeOf(cursor).toEqualTypeOf<number | undefined>()
        return [{ id: "2" }]
      },
      {
        cursor: row => row.id,
        cursorSchema: v.pipe(v.string(), v.transform(Number), v.number()),
        route: false,
      },
    )
  })

  it("types Collection authorize callbacks", () => {
    const collection = defineCollection(async () => [{ id: 1 }], {
      authorize: ({ request, session, user }) => {
        expectTypeOf(request.url).toBeString()
        expectTypeOf(session).toEqualTypeOf<Record<string, unknown>>()
        expectTypeOf(user.id).toBeString()
        return user.role === "admin" || new Response("Admin access required", { status: 403 })
      },
      cursor: row => row.id,
      cursorSchema: v.number(),
    })
    expectTypeOf(collection.authorize).toEqualTypeOf<AccessAuthorizeOption | false | undefined>()
    defineCollection(async () => [{ id: 1 }], { authorize: true, cursor: row => row.id, cursorSchema: v.number() })
    defineCollection(async () => [{ id: 1 }], { authorize: false, cursor: row => row.id, cursorSchema: v.number() })
    defineCollection(async () => [{ id: 1 }], { cursor: row => row.id, cursorSchema: v.number(), route: false })
    // @ts-expect-error A routed Collection must set authorize.
    defineCollection(async () => [{ id: 1 }], { cursor: row => row.id, cursorSchema: v.number() })
    // @ts-expect-error A server-only Collection has no public route to open.
    defineCollection(async () => [{ id: 1 }], { authorize: false, cursor: row => row.id, cursorSchema: v.number(), route: false })
  })

  it("accepts SDK clients and transports without exposing SDK types", () => {
    const client = new Client({ name: "test", version: "1.0.0" })
    const transport = new StreamableHTTPClientTransport(new URL("https://example.com/mcp"))

    expectTypeOf(client).toMatchTypeOf<McpResourcesClient>()
    expectTypeOf(transport).toMatchTypeOf<McpResourcesTransport>()
    expectTypeOf(mcpResources({ server: client })).toMatchTypeOf<Source>()
    expectTypeOf(mcpResources({ server: { transport } })).toMatchTypeOf<Source>()
  })

  it("types registered source names and keys", async () => {
    const staticSource = file({ content: "# Docs\n", workspacePath: "README.md" })
    expectTypeOf(file({ content: "# Docs\n", workspacePath: "README.md" })).toMatchTypeOf<Source<"README.md">>()
    expectTypeOf(github({ auth: false, repo: "acme/app" })).toMatchTypeOf<Source>()
    expectTypeOf(github({ ignore: sourceIgnores.defaults, repo: "acme/app" })).toMatchTypeOf<Source>()
    expectTypeOf(glob({ ignore: sourceIgnores.generated, include: "**/*.md" })).toMatchTypeOf<Source>()
    expectTypeOf(
      mcpResources({
        server: {
          async listResources() {
            return { resources: [] }
          },
          async readResource() {
            return { contents: [] }
          },
        },
      }),
    ).toMatchTypeOf<Source<string>>()
    expectTypeOf(
      mcpResources({ server: { transport: { type: "http", url: "https://example.com/mcp" } } }),
    ).toMatchTypeOf<Source<string>>()
    expectTypeOf(
      mcpResources({ ignore: sourceIgnores.media, server: { transport: { type: "http", url: "https://example.com/mcp" } } }),
    ).toMatchTypeOf<Source<string>>()
    const sources = {
      docs: staticSource,
      dynamic: github({ auth: false, repo: "acme/app" }),
    }

    registerSources(sources)

    const docs = useSource("docs")
    const dynamic = useSource("dynamic")

    expectTypeOf(await docs.keys()).toEqualTypeOf<Array<"README.md" | "guide/setup.md">>()
    expectTypeOf(await docs.get("README.md")).toEqualTypeOf<SourceFile<"README.md" | "guide/setup.md">>()
    expectTypeOf(await docs.read("README.md")).toEqualTypeOf<string>()
    expectTypeOf(await docs.read("README.md", { encoding: "binary" })).toEqualTypeOf<Uint8Array>()
    expectTypeOf(await docs.exists("guide/setup.md")).toEqualTypeOf<boolean>()
    expectTypeOf(await docs.meta("README.md")).toEqualTypeOf<Record<string, unknown> | undefined>()
    expectTypeOf(await docs.revision()).toEqualTypeOf<SourceRevision | undefined>()
    expectTypeOf(await dynamic.keys()).toEqualTypeOf<string[]>()
    expectTypeOf<SourceData<ViteHubSourceMap["meals"]>>().toEqualTypeOf<Meal>()
    expectTypeOf<SourceMetadata<ViteHubSourceMap["meals"]>>().toEqualTypeOf<MealMetadata>()

    const meal = await useSource("meals").get("meal_123")
    expectTypeOf(meal).toEqualTypeOf<SourceItem<`meal_${string}`, Meal, MealMetadata>>()
    expectTypeOf(meal.data).toEqualTypeOf<Meal | undefined>()
    expectTypeOf(meal.metadata).toEqualTypeOf<MealMetadata | undefined>()
    expectTypeOf(await useSource("meals").meta("meal_123")).toEqualTypeOf<MealMetadata | undefined>()
    expectTypeOf(await useSource("meals").items()).toEqualTypeOf<
      Array<SourceItem<`meal_${string}`, Meal, MealMetadata>>
    >()

    // @ts-expect-error source names are inferred from the global source map
    useSource("missing")
    // @ts-expect-error known source keys are narrowed
    await docs.read("missing.md")
  })

  it("preserves explicit source key generics", async () => {
    const source = defineSource(
      {
        name: "typed",
        async getKeys() {
          return ["one.md", "two.md"]
        },
        async getItem(key: "one.md" | "two.md") {
          return { key, content: "# Doc\n" }
        },
      } satisfies Source<"one.md" | "two.md">,
    )

    expectTypeOf(source).toMatchTypeOf<Source<"one.md" | "two.md">>()
  })

  it("preserves record and metadata types from a custom source", async () => {
    const source: Source<"meal_123", Meal, MealMetadata> = defineSource(
      {
        name: "meals",
        async getKeys() {
          return ["meal_123"] as const
        },
        async getItem(key: "meal_123") {
          return {
            data: {
              analysis: { costUsd: 0.002, model: "google/gemini-3-flash" },
              calories: 720,
              name: "Post-workout meal",
              photo: { key: "meals/meal_123/original", mediaType: "image/png" },
            },
            key,
            metadata: { revision: "1" },
          }
        },
      } satisfies Source<"meal_123", Meal, MealMetadata>,
    )

    expectTypeOf(await source.getItem("meal_123", { rootDir: "." })).toEqualTypeOf<
      SourceItem<"meal_123", Meal, MealMetadata>
    >()
  })
})
