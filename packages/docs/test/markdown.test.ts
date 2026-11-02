import { describe, expect, it } from "vitest"

import { createDocsParser, docsSearchSections } from "../src/markdown.ts"

import type { Node as ComarkNode } from "comark"

const parse = createDocsParser()

const source = [
  "# Page",
  "",
  "Intro text.",
  "",
  "## Install",
  "",
  "Run the command.",
  "",
  "```ts [server/api/kv.ts]",
  "export const answer = 42",
  "```",
  "",
  "### From npm",
  "",
  "Use pnpm.",
  "",
  "::agent-only",
  "Only agents read this.",
  "::",
  "",
  "## Use",
  "",
  "- One item",
  "- Two item",
].join("\n")

function find(nodes: ComarkNode[], tag: string): Extract<ComarkNode, unknown[]> | undefined {
  for (const node of nodes) {
    if (typeof node === "string") continue
    if (node[0] === tag) return node
    const found = find(node.slice(2) as ComarkNode[], tag)
    if (found) return found
  }
  return undefined
}

describe("docs parser", () => {
  it("keeps the text of loose list items out of paragraphs", async () => {
    const { nodes } = await parse("1. First step\n\n   ```bash\n   pnpm dev\n   ```\n\n2. Second step\n")
    const item = find(nodes, "li")
    expect(item?.[2]).toBe("First step")
    expect(find(nodes, "p")).toBeUndefined()
  })

  it("gives code blocks their language and file name", async () => {
    const { nodes } = await parse(source)
    const pre = find(nodes, "pre")

    expect(pre?.[1]).toMatchObject({ language: "ts", filename: "server/api/kv.ts" })
  })

  it("builds the outline from h2 and h3 headings", async () => {
    const { toc } = await parse(source)

    expect(toc).toEqual([
      { id: "install", text: "Install", depth: 2, children: [{ id: "from-npm", text: "From npm", depth: 3 }] },
      { id: "use", text: "Use", depth: 2 },
    ])
  })
})

describe("docs search sections", () => {
  it("splits a page by h2 and h3 and skips agent-only blocks", async () => {
    const { nodes } = await parse(source)
    const sections = docsSearchSections("/docs/kv", "KV", nodes)

    expect(sections.map(section => [section.id, section.title, section.titles, section.level])).toEqual([
      ["/docs/kv", "KV", [], 1],
      ["/docs/kv#install", "Install", ["KV"], 2],
      ["/docs/kv#from-npm", "From npm", ["KV", "Install"], 3],
      ["/docs/kv#use", "Use", ["KV"], 2],
    ])
    expect(sections[1]?.content).toContain("Run the command.")
    expect(sections[1]?.content).toContain("export const answer = 42")
    expect(sections[2]?.content).toBe("Use pnpm.")
    expect(sections[3]?.content).toBe("One item Two item")
    expect(sections.some(section => section.content.includes("Only agents"))).toBe(false)
  })
})
