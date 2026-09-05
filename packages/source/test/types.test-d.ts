import { describe, expectTypeOf, it } from "vitest"
import * as v from "valibot"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

import {
  combineSources,
  type CollectionQuery,
  createSource,
  defineCollection,
  defineSource,
  defineSources,
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
import { file } from "../src/file.ts"
import { github } from "../src/github.ts"
import { glob } from "../src/glob.ts"
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
  it("infers Collection aliases, keys, values, and enumerable items", async () => {
    function reader<const TKey extends string, TData>(key: TKey, data: TData) {
      return {
        async get(requested: TKey) {
          return { data, key: requested }
        },
        async items() {
          return [{ data, key }]
        },
      }
    }

    const keyedDefinition = (context: SourceContext) => ({
      async get(month: "2026-07") {
        return { month, rootDir: context.rootDir }
      },
    })
    const collection = combineSources({
      sources: {
        count: reader("same", 1),
        keyed: keyedDefinition({ rootDir: "/recaps" }),
        title: reader("same", "Title"),
      },
    })

    expectTypeOf(await collection.get(["count", "same"])).toEqualTypeOf<{
      data: number
      key: "same"
    }>()
    expectTypeOf(await collection.get(["keyed", "2026-07"])).toEqualTypeOf<{
      month: "2026-07"
      rootDir: string
    }>()
    // @ts-expect-error A get-only input cannot enumerate.
    collection.items()

    const variants = combineSources({
      sources: {
        variant: {
          async get(key: "a" | "b") {
            return key
          },
          async items(): Promise<Array<{ key: "a"; a: number } | { key: "b"; b: string }>> {
            return [{ key: "a", a: 1 }]
          },
        },
      },
    })
    const variant = (await variants.items())[0]!
    if (variant.key === "a") expectTypeOf(variant.a).toBeNumber()
    else expectTypeOf(variant.b).toBeString()

    // @ts-expect-error Collection aliases are inferred
    await collection.get(["missing", "same"])
    // @ts-expect-error Source keys are inferred per alias
    await collection.get(["count", "different"])
    // SAFETY: This widens a known alias to exercise correlation across a union.
    const source = "count" as "count" | "keyed"
    // @ts-expect-error A union alias must remain correlated with its Source key
    await collection.get([source, "2026-07"])
    const conditionalReader =
      Math.random() > 0.5
        ? {
            async get(key: "a" | "shared") {
              return key
            },
          }
        : {
            async get(key: "b" | "shared") {
              return key
            },
          }
    const conditionalCollection = combineSources({ sources: { conditional: conditionalReader } })
    await conditionalCollection.get(["conditional", "shared"])
    // @ts-expect-error A key must be accepted by every possible reader variant
    await conditionalCollection.get(["conditional", "a"])
    const enumerableUnion =
      Math.random() > 0.5
        ? {
            async get(key: "a" | "shared") {
              return key
            },
            async items() {
              return [{ key: "shared" as const }]
            },
          }
        : {
            async get(key: "b" | "shared") {
              return key
            },
            async items() {
              return [{ key: "shared" as const }]
            },
          }
    const enumerableCollection = combineSources({ sources: { enumerable: enumerableUnion } })
    const emittedIdentity = (await enumerableCollection.items())[0]!.identity
    await enumerableCollection.get(emittedIdentity)
    combineSources({
      // @ts-expect-error Enumerable union readers cannot emit a variant-only key
      sources: { invalidUnion: Math.random() > 0.5 ? reader("a", 1) : reader("b", 2) },
    })
    const mixedUnion =
      Math.random() > 0.5
        ? {
            async get(key: "a" | "shared") {
              return key
            },
            async items() {
              return [{ key: "shared" as const }]
            },
          }
        : {
            async get(key: "b" | "shared") {
              return key
            },
          }
    const mixedCollection = combineSources({ sources: { mixed: mixedUnion } })
    // @ts-expect-error Every possible reader variant must support enumeration.
    mixedCollection.items()
    combineSources({
      sources: {
        // @ts-expect-error Mixed reader unions cannot emit a variant-only key either
        invalidMixed:
          Math.random() > 0.5
            ? reader("a", 1)
            : {
                async get(key: "b") {
                  return key
                },
              },
      },
    })
    interface OverloadedReader {
      get(key: "a"): Promise<{ a: number }>
      get(key: "b"): Promise<{ b: string }>
    }
    const overloadedReader: OverloadedReader = undefined!
    // @ts-expect-error Overloaded get methods have an ambiguous Collection contract
    combineSources({ sources: { overloaded: overloadedReader } })
    const conditionalGeneric: {
      get<TKey extends string>(key: TKey): Promise<TKey extends "a" ? { a: number } : never>
    } = undefined!
    // @ts-expect-error Generic key-dependent get methods cannot be represented by the Collection return type
    combineSources({ sources: { conditionalGeneric } })
    interface GenericItems {
      a: { a: number }
      b: { b: string }
    }
    const indexedGeneric: {
      get<TKey extends keyof GenericItems>(key: TKey): Promise<GenericItems[TKey]>
    } = undefined!
    // @ts-expect-error Generic key-dependent get methods must use an explicit union-parameter contract
    combineSources({ sources: { indexedGeneric } })
    combineSources({
      sources: {
        // @ts-expect-error enumerable item keys must be accepted by the Source reader
        invalid: {
          async get(_key: "one") {},
          async items() {
            return [{ key: "two" as const }]
          },
        },
      },
    })
    // @ts-expect-error Collection aliases must be strings
    combineSources({ sources: { 0: reader("same", 1) } })
  })

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
      },
    )
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
    const sources = defineSources({
      docs: staticSource,
      dynamic: github({ auth: false, repo: "acme/app" }),
    })

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
