import { expect, it } from "vitest"
import { parse } from "yaml"

import { docsFrontmatter, docsPageSchema } from "../../docs/src/schema.ts"
import { movePage } from "../src/docus/content.ts"

it("converts flow YAML and validates it with the Docs schema", () => {
  const { code } = movePage("content/usage.md", "---\n\ntitle: Usage\nseo: { ogImage: /card.png } # share\nnavigation: { icon: i-lucide-book }\ndescription: |-\n  First\n  Second\n---\n\nContent.\n", 2)
  expect(docsPageSchema.parse(docsFrontmatter(parse(code.split("---")[1])))).toMatchObject({
    title: "Usage", description: "First\nSecond", seo: { image: "/card.png" }, icon: "i-lucide-book", navigation: { order: 2 },
  })
})
