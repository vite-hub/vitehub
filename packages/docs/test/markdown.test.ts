import { describe, expect, it } from "vitest"

import { textContent } from "comark/utils"

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

  it("highlights code with the GitHub themes for light and dark mode", async () => {
    const { nodes } = await parse(source)
    const pre = find(nodes, "pre")

    expect(String(pre?.[1].class)).toContain("github-light-default")
    expect(JSON.stringify(pre)).toContain("--shiki-dark:")
    expect(JSON.stringify(pre)).not.toMatch(/material-theme/)
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

describe("comark-ui blocks", () => {
  function find(nodes: ComarkNode[], tag: string): Extract<ComarkNode, unknown[]> | undefined {
    for (const node of nodes) {
      if (typeof node === "string" || node[0] === null) continue
      if (node[0] === tag) return node
      const found = find(node.slice(2) as ComarkNode[], tag)
      if (found) return found
    }
    return undefined
  }

  it("turns a GitHub alert into comark-ui's callout", async () => {
    const { nodes } = await parse("> [!WARNING]\n> Rotate the key first.\n")

    expect(find(nodes, "github-callout")?.[1]).toMatchObject({ type: "warning" })
  })

  it("gives each tab its label", async () => {
    const { nodes } = await parse("::tabs\n:::tabs-item{label=\"npm\"}\nnpm i\n:::\n:::tabs-item{label=\"pnpm\"}\npnpm add\n:::\n::\n")

    expect(find(nodes, "tabs")?.[1]).toMatchObject({ labels: ["npm", "pnpm"] })
  })

  it("keeps the site's plugin when it has a built-in name", async () => {
    const own = { name: "alert", markdownItPlugins: [] }
    const { nodes } = await createDocsParser({ plugins: [own] })("> [!WARNING]\n> Rotate the key first.\n")

    expect(find(nodes, "github-callout")).toBeUndefined()
  })
})

describe("docs examples", () => {
  const example = ["::example{label=\"Bold\"}", "```md", "Some **bold** text.", "```", "::"].join("\n")

  it("renders the Markdown of an example before its source", async () => {
    const { nodes } = await parse(example)
    const block = find(nodes, "example")
    const [preview, pre] = (block?.slice(2) ?? []) as Array<Extract<ComarkNode, unknown[]>>

    expect(block?.[1]).toMatchObject({ label: "Bold" })
    expect(preview?.[0]).toBe("example-preview")
    expect(find(preview?.slice(2) as ComarkNode[], "strong")?.[2]).toBe("bold")
    expect(pre?.[0]).toBe("pre")
    expect(pre?.[1]).toMatchObject({ language: "md" })
  })

  it("parses the preview with the page's own plugins", async () => {
    const withPlugin = createDocsParser({
      plugins: [{ name: "shout", post: (state) => { state.tree.nodes.push(["p", {}, "added"]) } }],
    })
    const { nodes } = await withPlugin(example)

    expect(JSON.stringify(find(nodes, "example-preview"))).toContain("added")
  })

  it("leaves an example of another language as its code alone", async () => {
    const { nodes } = await parse(["::example", "```ts", "export const answer = 42", "```", "::"].join("\n"))

    expect(find(nodes, "example-preview")).toBeUndefined()
  })

  it("gives a named example the highlighted source of its Vue file", async () => {
    const withExamples = createDocsParser({ examples: { ButtonExample: "<template>\n  <UButton label=\"Save\" />\n</template>\n" } })
    const { nodes } = await withExamples("::example{name=\"ButtonExample\"}\n::")
    const pre = find(nodes, "pre")

    expect(find(nodes, "example")?.[1]).toMatchObject({ name: "ButtonExample" })
    expect(pre?.[1]).toMatchObject({ language: "vue" })
    expect(JSON.stringify(pre)).toContain("UButton")
  })

  it("keeps a named example whole when its source has a code fence", async () => {
    const source = "<template>\n  <Markdown :value=\"'```ts\\nconst a = 1\\n```'\" />\n</template>"
    const { nodes } = await createDocsParser({ examples: { FenceExample: source } })("::example{name=\"FenceExample\"}\n::")

    expect(textContent(find(nodes, "pre")!)).toBe(source)
  })

  it("renders a lint rule's correct and incorrect examples like an example", async () => {
    const { nodes } = await parse(["::incorrect", "```md", "A [link](./missing.md).", "```", "::", "", "::correct", "```md", "A [link](./ducks.md).", "```", "::"].join("\n"))

    expect(find(find(nodes, "incorrect")?.slice(2) as ComarkNode[], "example-preview")).toBeDefined()
    expect(find(find(nodes, "correct")?.slice(2) as ComarkNode[], "example-preview")).toBeDefined()
  })

  it("shows only the source of an example whose Markdown doesn't parse", async () => {
    const { nodes } = await parse(["::incorrect", "````md", "---", "title: [unclosed", "---", "````", "::"].join("\n"))

    expect(find(nodes, "example-preview")).toBeUndefined()
    expect(find(nodes, "pre")).toBeDefined()
  })

  it("names the missing file of an unknown example", async () => {
    await expect(parse("::example{name=\"MissingExample\"}\n::")).rejects.toThrow("no MissingExample.vue")
  })

  it("leaves an example's preview out of search, which reads its source", async () => {
    const { nodes } = await parse(example)
    const [page] = docsSearchSections("/docs/bold", "Bold", nodes)

    expect(page?.content).toBe("Some **bold** text.")
  })
})
