import { describe, expect, it } from "vitest"

import { createDocsParser, docsSearchSections } from "../src/markdown.ts"

import type { ComarkPlugin, Node as ComarkNode } from "comark"

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
  it("keeps example headings out of page search and the outline", async () => {
    const { nodes, toc } = await parse("## Install\n\n::examples\n:::example{label=First}\n```md\n## Install\n\n### Preview details\n```\n:::\n:::example{label=Second}\n```md\n## Install\n```\n:::\n::\n\n## Continue\n")

    expect(docsSearchSections("/guide", "Guide", nodes).map(section => section.id)).toEqual(["/guide", "/guide#install", "/guide#continue"])
    expect(toc.map(link => link.id)).toEqual(["install", "continue"])
  })

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

  it.each(["md", "markdown", "mdc", "comark"])("renders an example's %s source with the default parser", async (language) => {
    const { nodes } = await parse(`::examples\n:::example{label="Note" play="/play"}\n\`\`\`${language}\n> [!NOTE]\n> Keep a backup.\n\`\`\`\n:::\n::\n`)
    const example = find(nodes, "example")
    const preview = find(nodes, "example-preview")

    expect(example?.[1]).toMatchObject({ label: "Note", play: "/play" })
    expect(example?.[2]).toBe(preview)
    expect(find([preview!], "github-callout")?.[1]).toMatchObject({ type: "note" })
    expect(find([preview!], "pre")).toBeUndefined()
    const source = example?.[3] as ComarkNode
    expect(find([source], "pre")?.[1]).toMatchObject({ language })
    expect(JSON.stringify(source)).toContain("Keep a backup.")
  })

  it("preserves a preview supplied by the site's plugin", async () => {
    const plugin: ComarkPlugin = {
      name: "site-examples",
      post({ tree }) {
        find(tree.nodes, "example")?.splice(2, 0, ["example-preview", {}, ["p", {}, "Site preview"]])
      },
    }
    const { nodes } = await createDocsParser({ plugins: [plugin] })("::example\n```md\nSource\n```\n::\n")
    const example = find(nodes, "example")

    expect(example).toHaveLength(4)
    expect(example?.[2]).toEqual(["example-preview", {}, ["p", {}, "Site preview"]])
    expect(find([example?.[3] as ComarkNode], "pre")?.[1]).toMatchObject({ language: "md" })
  })

  it("isolates a site's preview headings and keeps fragment links inside that preview", async () => {
    const plugin: ComarkPlugin = {
      name: "site-examples",
      post({ tree }) {
        find(tree.nodes, "example")?.splice(2, 0, ["example-preview", {},
          ["h2", { id: "install" }, "Preview install"],
          ["p", {}, ["a", { href: "#install" }, "Jump to install"]],
        ])
      },
    }
    const { nodes } = await createDocsParser({ plugins: [plugin] })("::example\n```md\nSource\n```\n::\n\n## Install\n\n## Reserved {#docs-example-1-install}\n")
    const preview = find(nodes, "example-preview")!
    const heading = find([preview], "h2")!

    expect(heading[1].id).not.toBe("install")
    expect(heading[1].id).not.toBe("docs-example-1-install")
    expect(find([preview], "a")?.[1].href).toBe(`#${heading[1].id}`)
    expect(docsSearchSections("/guide", "Guide", nodes).map(section => section.id)).toEqual(["/guide", "/guide#install", "/guide#docs-example-1-install"])
  })

  it("keeps the site's plugin when it has a built-in name", async () => {
    const own = { name: "alert", markdownItPlugins: [] }
    const { nodes } = await createDocsParser({ plugins: [own] })("> [!WARNING]\n> Rotate the key first.\n")

    expect(find(nodes, "github-callout")).toBeUndefined()
  })
})
