import { describe, expect, it } from "vitest"

import { textContent } from "comark/utils"

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
  it("keeps HTML-only block text in search content and heading titles", async () => {
    const { nodes } = await parse('## Run :suggestion[npm]{to="pnpm"}\n\n::diff\n```ts\nconst before = 1\n```\n```ts\nconst after = 2\n```\n::\n\n::question{#callback}\nWhich callback runs first?\n\n- [x] A promise\n- [ ] A timer\n::\n')
    const sections = docsSearchSections("/docs/blocks", "Blocks", nodes)

    expect(sections[1]?.title).toContain("npm")
    expect(sections[1]?.content).toContain("const before = 1")
    expect(sections[1]?.content).toContain("const after = 2")
    expect(sections[1]?.content).toContain("Which callback runs first?")
    expect(sections[1]?.content).toContain("A promise")
    expect(sections[1]?.content).not.toContain("<style")
  })

  it("keeps preview headings from splitting page search sections", async () => {
    const { nodes } = await parse("## Install\n\n:::example\n```md\n## Preview heading\n\nExample text.\n```\n:::\n\nPage text.\n\n## Use\n\nReal section.\n")
    const sections = docsSearchSections("/docs/examples", "Examples", nodes)

    expect(sections.map(section => section.id)).toEqual(["/docs/examples", "/docs/examples#install", "/docs/examples#use"])
    expect(sections[1]?.content).toContain("Page text.")
    expect(sections[2]?.content).toBe("Real section.")
  })

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

  it.each(["site-examples", "docs-examples"])("preserves a preview supplied by the site's %s plugin", async (name) => {
    const plugin: ComarkPlugin = {
      name,
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

  it("keeps named Vue sources with configured preview tags and playground links", async () => {
    const withExamples = createDocsParser({
      exampleSources: { ButtonExample: "<template><button>Save</button></template>" },
      examples: { tags: ["example", "demo"], play: (source, tag) => `/play?tag=${tag}#${encodeURIComponent(source)}` },
    })
    const { nodes } = await withExamples('::example{name="ButtonExample"}\n::\n\n:::demo\n```md\n**Bold**\n```\n:::\n')

    expect(textContent(find(nodes, "pre")!)).toContain("<button>Save</button>")
    expect(tagOf(find(nodes, "demo")?.[2])).toBe("example-preview")
    expect(find(nodes, "demo")?.[1].play).toBe(`/play?tag=demo#${encodeURIComponent("**Bold**")}`)
  })

  it("keeps the playground link for deliberately invalid frontmatter", async () => {
    const { nodes } = await createDocsParser({ examples: { play: () => "/play" } })(example("---\ntitle: [\n---"))

    expect(find(nodes, "example-preview")).toBeUndefined()
    expect(find(nodes, "example")?.[1].play).toBe("/play")
  })

  it("shows only the source of Markdown that doesn't parse", async () => {
    const { nodes } = await parse(example("---\ntitle: [\n---\n# Broken"))
    const node = find(nodes, "example")

    expect(find(nodes, "example-preview")).toBeUndefined()
    expect(tagOf(node?.[2])).toBe("pre")
  })
})

describe("HTML-only blocks", () => {
  it("emits shared assets once per page, including example previews", async () => {
    const diff = "::diff\n```ts\nconst a = 1\n```\n```ts\nconst a = 2\n```\n::\n"
    const quiz = "::question{#callback}\nWhich callback runs first?\n\n- [x] A promise\n- [ ] A timer\n::\n"
    const source = `${diff}\n:::example\n\`\`\`\`md\n${diff}\`\`\`\`\n:::\n\n${quiz}\n${quiz.replace("callback", "next-callback")}\nRun :suggestion[npm]{to="pnpm" mark="pen"} and :suggestion[yarn]{to="pnpm" mark="pen"}.\n`
    const htmlOf = (nodes: ComarkNode[]): string => nodes.map(node => typeof node === "string" ? "" : node[0] === "comark-html" ? String(node[1].html) : htmlOf(node.slice(2) as ComarkNode[])).join("")

    // Reusing the parser, also concurrently, must give each page its own complete assets.
    for (const { nodes } of await Promise.all([parse(source), parse(source)])) {
      const html = htmlOf(nodes)
      for (const asset of ["diff", "quiz", "comments", "comments-font"]) {
        expect(html.match(new RegExp(`<style data-comark-${asset}>`, "g"))).toHaveLength(1)
      }
      expect(html.match(/<script\b/g)).toHaveLength(1)
      expect(html.match(/data-quiz-id=/g)).toHaveLength(2)
    }
  })

  it("draws a diff as HTML named after its block", async () => {
    const { nodes } = await parse("::diff\n```ts\nconst a = 1\n```\n```ts\nconst a = 2\n```\n::\n")
    const node = find(nodes, "comark-html")

    expect(find(nodes, "diff")).toBeUndefined()
    expect(node?.[1]).toMatchObject({ block: "diff" })
    expect(node?.[1].html).toContain("class=\"cd")
  })

  it("draws a block inside a paragraph inline", async () => {
    const { nodes } = await parse("Run :suggestion[npm]{to=\"pnpm\"} first.\n")

    expect(find(nodes, "p")?.[3]).toMatchObject(["comark-html", { block: "suggestion", inline: true }, "npm"])
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

  it.each(["example", "correct", "incorrect"])("reports a missing named example inside a %s preview", async (tag) => {
    const markdown = [`::${tag}`, "```md", '::example{name="MissingExample"}', "::", "```", "::"].join("\n")

    await expect(parse(markdown)).rejects.toThrow("no MissingExample.vue")
  })

  it.each(["example", "correct", "incorrect"])("keeps a parser plugin's original error inside a %s preview", async (tag) => {
    const error = new Error("Preview plugin failed")
    const withPlugin = createDocsParser({ plugins: [{
      name: "failing-preview",
      pre(state) {
        if (state.markdown.trim() === "Preview content") throw error
      },
    }] })
    const markdown = [`::${tag}`, "```md", "Preview content", "```", "::"].join("\n")

    await expect(withPlugin(markdown)).rejects.toBe(error)
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
