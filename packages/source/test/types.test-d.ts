import { describe, expectTypeOf, it } from "vitest"

import {
  custom,
  defineSource,
  defineSources,
  file,
  github,
  mcpResources,
  registerSources,
  type Source,
  type SourceData,
  type SourceItem,
  type SourceMetadata,
  useSource,
} from "../src/index.ts"

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
    dbt: Source
    docs: Source<"README.md" | "guide/setup.md">
    dynamic: Source
    github: Source
    meals: Source<`meal_${string}`, Meal, MealMetadata>
    readme: Source<"README.md">
  }
}

describe("@vite-hub/source types", () => {
  it("types registered source names and keys", async () => {
    const staticSource = file({ content: "# Docs\n", workspacePath: "README.md" })
    expectTypeOf(file({ content: "# Docs\n", workspacePath: "README.md" })).toMatchTypeOf<Source<"README.md">>()
    expectTypeOf(github({ auth: false, repo: "acme/app" })).toMatchTypeOf<Source>()
    expectTypeOf(mcpResources({ server: {
      async listResources() {
        return { resources: [] }
      },
      async readResource() {
        return { contents: [] }
      },
    } })).toMatchTypeOf<Source<string>>()
    expectTypeOf(mcpResources({ server: { transport: { type: "http", url: "https://example.com/mcp" } } })).toMatchTypeOf<Source<string>>()
    const sources = defineSources({
      docs: staticSource,
      dynamic: github({ auth: false, repo: "acme/app" }),
    })

    registerSources(sources)

    const docs = useSource("docs")
    const dynamic = useSource("dynamic")

    expectTypeOf(await docs.keys()).toEqualTypeOf<Array<"README.md" | "guide/setup.md">>()
    expectTypeOf(await docs.get("README.md")).toEqualTypeOf<SourceItem<"README.md" | "guide/setup.md">>()
    expectTypeOf(await docs.read("README.md")).toEqualTypeOf<string>()
    expectTypeOf(await docs.read("README.md", { encoding: "binary" })).toEqualTypeOf<Uint8Array>()
    expectTypeOf(await docs.exists("guide/setup.md")).toEqualTypeOf<boolean>()
    expectTypeOf(await docs.meta("README.md")).toEqualTypeOf<Record<string, unknown> | undefined>()
    expectTypeOf(await dynamic.keys()).toEqualTypeOf<string[]>()
    expectTypeOf<SourceData<"meals">>().toEqualTypeOf<Meal>()
    expectTypeOf<SourceMetadata<"meals">>().toEqualTypeOf<MealMetadata>()

    const meal = await useSource("meals").get("meal_123")
    expectTypeOf(meal).toEqualTypeOf<SourceItem<`meal_${string}`, Meal, MealMetadata>>()
    expectTypeOf(meal.data).toEqualTypeOf<Meal | undefined>()
    expectTypeOf(meal.metadata).toEqualTypeOf<MealMetadata | undefined>()
    expectTypeOf(await useSource("meals").meta("meal_123")).toEqualTypeOf<MealMetadata | undefined>()
    expectTypeOf(await useSource("meals").items())
      .toEqualTypeOf<Array<SourceItem<`meal_${string}`, Meal, MealMetadata>>>()

    // @ts-expect-error source names are inferred from the global source map
    useSource("missing")
    // @ts-expect-error known source keys are narrowed
    await docs.read("missing.md")
  })

  it("preserves explicit source key generics", async () => {
    const source = defineSource(custom({
      name: "typed",
      async getKeys() {
        return ["one.md", "two.md"]
      },
      async getItem(key: "one.md" | "two.md") {
        return { key, content: "# Doc\n" }
      },
    } satisfies Source<"one.md" | "two.md">))

    expectTypeOf(source).toMatchTypeOf<Source<"one.md" | "two.md">>()
  })

  it("preserves record and metadata types from a custom source", async () => {
    const source: Source<"meal_123", Meal, MealMetadata> = defineSource(custom({
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
    } satisfies Source<"meal_123", Meal, MealMetadata>))

    expectTypeOf(await source.getItem("meal_123", { rootDir: "." }))
      .toEqualTypeOf<SourceItem<"meal_123", Meal, MealMetadata>>()
  })
})
