import { describe, expectTypeOf, it } from "vitest"

import { createSource, defineSource, splitSource } from "../src/index.ts"
import { glob } from "../src/glob.ts"

describe("splitSource() types", () => {
  it("infers part keys, data, and file methods", async () => {
    const pages = defineSource({
      name: "pages",
      async getKeys() { return ["a.md" as const] },
      async getItem(key: "a.md") { return { key, content: "# A" } },
    })
    const sections = createSource(splitSource({
      source: pages,
      split: item => [{ key: "intro", data: { title: String(item.content) } }],
    }))
    const section = await sections.get("a.md#intro")
    expectTypeOf(section.key).toEqualTypeOf<`a.md#${string}`>()
    expectTypeOf(section.data).toEqualTypeOf<{ title: string }>()
    // @ts-expect-error A part key starts with a parent key.
    void sections.get("b.md#intro")

    const blocks = createSource(splitSource({
      source: glob({ include: "**/*.md" }),
      split: item => [{ key: "first", content: String(item.content) }],
    }))
    expectTypeOf(await blocks.read("a.md#first")).toEqualTypeOf<string>()
  })
})
