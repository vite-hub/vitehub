import { describe, expectTypeOf, it } from "vitest"

import {
  custom,
  defineSource,
  defineSources,
  file,
  github,
  mcpResources,
  registerSources,
  source,
  type Source,
  type SourceItem,
  useSource,
} from "../src/index.ts"

declare global {
  interface ViteHubSourceMap {
    custom: Source
    dbt: Source
    docs: Source<"README.md" | "guide/setup.md">
    dynamic: Source
    github: Source
    readme: Source<"README.md">
  }
}

describe("@vite-hub/source types", () => {
  it("types registered source names and keys", async () => {
    const staticSource = file({ content: "# Docs\n", workspacePath: "README.md" })
    expectTypeOf(source.file({ content: "# Docs\n", workspacePath: "README.md" })).toMatchTypeOf<Source<"README.md">>()
    expectTypeOf(source.mcpResources({ server: {
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
      dynamic: github({ repo: "acme/app" }),
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
})
