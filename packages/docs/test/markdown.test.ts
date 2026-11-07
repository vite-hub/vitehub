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

describe("examples", () => {
  const tagOf = (node: ComarkNode | undefined) => Array.isArray(node) ? node[0] : undefined
  const example = (markdown: string, attributes = "") => `:::example${attributes}\n\`\`\`md\n${markdown}\n\`\`\`\n:::\n`

  it("renders an example's Markdown before its source", async () => {
    const { nodes } = await parse(example("> [!NOTE]\n> Lumen caches every page."))
    const node = find(nodes, "example")

    expect(tagOf(node?.[2])).toBe("example-preview")
    expect(find([node![2]], "github-callout")?.[1]).toMatchObject({ type: "note" })
    expect(find(node!.slice(3) as ComarkNode[], "pre")).toBeDefined()
    expect(node?.[1].play).toBeUndefined()
  })

  it("writes the playground link that play returns", async () => {
    const play = async (source: string, tag: string) => `/play?tag=${tag}#${encodeURIComponent(source)}`
    const { nodes } = await createDocsParser({ examples: { play } })(example("**Bold**"))

    expect(find(nodes, "example")?.[1].play).toBe(`/play?tag=example#${encodeURIComponent("**Bold**")}`)
  })

  it("previews the blocks that tags names", async () => {
    const { nodes } = await createDocsParser({ examples: { tags: ["correct"] } })(":::correct\n```md\n**Bold**\n```\n:::\n")

    expect(tagOf(find(nodes, "correct")?.[2])).toBe("example-preview")
  })

  it("shows only the source of Markdown that doesn't parse", async () => {
    const { nodes } = await parse(example("---\ntitle: [\n---\n# Broken"))
    const node = find(nodes, "example")

    expect(find(nodes, "example-preview")).toBeUndefined()
    expect(tagOf(node?.[2])).toBe("pre")
  })
})

describe("HTML-only blocks", () => {
  it("draws a diff as HTML named after its block", async () => {
    const { nodes } = await parse("::diff\n```ts\nconst a = 1\n```\n```ts\nconst a = 2\n```\n::\n")
    const node = find(nodes, "comark-html")

    expect(find(nodes, "diff")).toBeUndefined()
    expect(node?.[1]).toMatchObject({ block: "diff" })
    expect(node?.[1].html).toContain("class=\"cd")
  })

  it("draws a block inside a paragraph inline", async () => {
    const { nodes } = await parse("Run :suggestion[npm]{to=\"pnpm\"} first.\n")

    expect(find(nodes, "p")?.[3]).toMatchObject(["comark-html", { block: "suggestion", inline: true }])
  })

  it("draws the HTML-only blocks inside an example's preview", async () => {
    const { nodes } = await parse(":::example\n````md\n::diff\n```ts\nconst a = 1\n```\n```ts\nconst a = 2\n```\n::\n````\n:::\n")

    expect(find([find(nodes, "example-preview")!], "comark-html")?.[1]).toMatchObject({ block: "diff" })
  })
})

describe("comark-ui options", () => {
  it("links issue references to the repository in github.references", async () => {
    const own = createDocsParser({ comarkUi: { github: { references: { repo: "vite-hub/vitehub" } } } })
    const linked = find((await own("Fixed in #12.\n")).nodes, "a")

    expect(linked?.[1].href).toBe("https://github.com/vite-hub/vitehub/issues/12")
    expect(find((await parse("Fixed in #12.\n")).nodes, "a")).toBeUndefined()
  })
})
