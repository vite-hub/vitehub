import { describe, expect, it } from "vitest"

import { contentSearchSections, defineContent } from "../src/index.ts"

const guide = `---
title: Guide
---

Read this first.

## Install

- one
- two

::my-box
### In a box
Box text.
::

:::agent-only
Only agents read this.
:::

## Use

Use it.
`

describe("content.searchSections()", () => {
  it("splits each document by h2 and h3, inside components too, with its Source and key", async () => {
    const content = defineContent({
      route: false,
      live: false,
      sources: {
        docs: { items: async () => [{ key: "guide.md", content: guide }, { key: "empty.md", content: "---\ntitle: Empty\n---\n" }] },
      },
    })
    const sections = await content.searchSections("docs", { ignore: ["agent-only"] })
    expect(sections.filter(section => section.key === "docs/guide.md")).toEqual([
      { source: "docs", key: "docs/guide.md", id: "/guide", title: "Guide", titles: [], level: 1, content: "Read this first." },
      { source: "docs", key: "docs/guide.md", id: "/guide#install", title: "Install", titles: ["Guide"], level: 2, content: "one two" },
      { source: "docs", key: "docs/guide.md", id: "/guide#in-a-box", title: "In a box", titles: ["Guide", "Install"], level: 3, content: "Box text." },
      { source: "docs", key: "docs/guide.md", id: "/guide#use", title: "Use", titles: ["Guide"], level: 2, content: "Use it." },
    ])
  })

  it("reads the same documents as content.list()", async () => {
    const content = defineContent({ route: false, live: false, sources: { docs: { items: async () => [{ key: "a.md", content: "# A" }, { key: "b.md", content: "# B" }] } } })
    const keys = (await content.list("docs")).map(file => file.meta.key)
    expect([...new Set((await content.searchSections()).map(section => section.key))]).toEqual(keys)
  })
})

describe("contentSearchSections()", () => {
  it("nests a heading under the level before it in the chosen levels", () => {
    const nodes = [["h2", { id: "a" }, "A"], ["h4", { id: "b" }, "B"], ["p", {}, "text"]] as const
    expect(contentSearchSections({ path: "/p", title: "P", nodes: nodes.map(node => [...node]) }, { headings: [2, 4] })).toEqual([
      { id: "/p", title: "P", titles: [], level: 1, content: "" },
      { id: "/p#a", title: "A", titles: ["P"], level: 2, content: "" },
      { id: "/p#b", title: "B", titles: ["P", "A"], level: 4, content: "text" },
    ])
  })
})
