import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { runInNewContext } from "node:vm"

import { MarkdownDocument } from "@comark/vue"
import { components as blocks } from "comark-ui/vue"
import { ModuleKind, ScriptTarget, transpileModule } from "typescript"
import { describe, expect, it, vi } from "vitest"
import * as vue from "vue"
import { compileScript, parse } from "vue/compiler-sfc"
import { renderToString } from "vue/server-renderer"

import { createDocsParser } from "../src/markdown.ts"
import { docsSeoProblems, readDocsSeoPage } from "../src/seo-audit.ts"

const filename = resolve(import.meta.dirname, "../runtime/app/components/DocsMarkdown.vue")
const { descriptor } = parse(readFileSync(filename, "utf8"), { filename })
const script = compileScript(descriptor, { id: "docs-markdown", inlineTemplate: true }).content
const { outputText } = transpileModule(script, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ESNext } })
const parseMarkdown = createDocsParser()

function renderer(content: Record<string, () => Promise<{ default: vue.Component }>> = {}, custom: Record<string, vue.Component> = {}, blockMap: Record<string, vue.Component> = blocks) {
  const exports: { default?: vue.Component } = {}
  runInNewContext(outputText, {
    ...vue,
    exports,
    require: (id: string) => {
      if (id === "vue") return vue
      if (id === "@comark/vue/components/MarkdownDocument") return { MarkdownDocument }
      if (id === "#docs/blocks") return { __esModule: true, default: blockMap }
      if (id === "#docs/components") return { __esModule: true, default: content }
      if (id === "#docs/custom-components") return { __esModule: true, default: custom }
      throw new Error(`Unexpected component import: ${id}`)
    },
  })
  return exports.default!
}

function block(name: string) {
  return vue.defineComponent({
    setup: (_, { attrs, slots }) => () => vue.h("aside", { ...attrs, "data-component": name }, slots.default?.()),
  })
}

describe("DocsMarkdown", () => {
  it.each(["callout", "note", "tip", "github-callout", "tabs-item", "code-tree"])("loads an app's %s content component before the built-in block", async (tag) => {
    const load = vi.fn(async () => ({ default: block("app") }))
    const component = renderer({ [tag]: load })
    expect(load).not.toHaveBeenCalled()

    const document = { nodes: [[tag, { title: "App title" }, "App content"]], toc: [] }
    const app = vue.createSSRApp(component, { document })
    app.component("ProseCodeTree", block("nuxt-ui"))
    const html = await renderToString(app)

    expect(load).toHaveBeenCalledOnce()
    expect(html).toContain('data-component="app"')
    expect(html).toContain('title="App title"')
    expect(html).toContain("App content")
  })

  it("keeps configured and direct component maps ahead of app content components", async () => {
    const document = { nodes: [["note", {}, "Content"]], toc: [] }
    const load = vi.fn(async () => ({ default: block("app") }))
    const component = renderer({ note: load }, { note: block("configured") })
    expect(await renderToString(vue.createSSRApp(component, { document }))).toContain('data-component="configured"')
    expect(await renderToString(vue.createSSRApp(component, { document, components: { note: block("direct") } }))).toContain('data-component="direct"')
    expect(load).not.toHaveBeenCalled()
  })

  it.each(["content", "configured", "direct"])("uses a %s override for a parsed HTML-only block", async (source) => {
    const document = await parseMarkdown('::diff{title="App title"}\n```ts\nconst before = 1\n```\n```ts\nconst after = 2\n```\n::\n')
    const load = vi.fn(async () => ({ default: block("app") }))
    const component = renderer({ diff: load }, source === "configured" ? { Diff: block("configured") } : {})
    const components = source === "direct" ? { diff: block("direct") } : undefined
    const html = await renderToString(vue.createSSRApp(component, { document, components }))

    expect(html).toContain(`data-component="${source === "content" ? "app" : source}"`)
    expect(html).toContain('title="App title"')
    expect(html.replace(/<[^>]*>/g, "")).toContain("const before = 1")
    expect(html.replace(/<[^>]*>/g, "")).toContain("const after = 2")
    expect(load).toHaveBeenCalledTimes(source === "content" ? 1 : 0)
  })

  it.each([
    ["suggestion", 'Run :suggestion[npm]{to="pnpm"} first.\n', 'mark="track"', "npm"],
    ["question", "::question{#callback}\nWhich callback runs first?\n\n- [x] A promise\n- [ ] A timer\n::\n", 'id="callback"', "Which callback runs first?"],
  ])("preserves the props and children of a %s override", async (tag, markdown, attribute, text) => {
    const document = await parseMarkdown(markdown)
    const original = JSON.stringify(document)
    const html = await renderToString(vue.createSSRApp(renderer({}, { [tag]: block("custom") }), { document }))

    expect(html).toContain('data-component="custom"')
    expect(html).toContain(attribute)
    expect(html).toContain(text)
    expect(JSON.stringify(document)).toBe(original)
  })

  it("keeps nested HTML fallbacks and shared assets when a quiz is overridden", async () => {
    const document = await parseMarkdown('::question{#callback}\nWhich :suggestion[callback]{to="function"} runs first?\n\n- [x] A promise\n- [ ] A timer\n::\n\n::poll{#pick}\nPick an option.\n\n- First\n- Second\n::\n')
    const fallback = vue.defineComponent({
      props: ["html", "block", "blockProps", "inline"],
      setup: props => () => vue.h(props.inline ? "span" : "div", { "data-block": props.block, innerHTML: props.html }),
    })
    const html = await renderToString(vue.createSSRApp(renderer({}, { Question: block("custom"), ComarkHtml: fallback }), { document }))

    expect(html).toContain('data-component="custom"')
    expect(html).toContain('data-block="suggestion"')
    expect(html).toContain('class="cr-sg')
    expect(html).toContain('data-quiz-id="pick"')
    expect(html.match(/<style data-comark-quiz>/g)).toHaveLength(1)
    expect(html.match(/<style data-comark-comments>/g)).toHaveLength(1)
    expect(html.match(/<script\b/g)).toHaveLength(1)
  })

  it("renders the same HTML when each block loads on first use", async () => {
    const document = await parseMarkdown("# Page\n\n::tabs\n:::tabs-item{label=One}\n```ts [one.ts]\nconst one = 1\n```\n:::\n:::tabs-item{label=Two}\nSecond\n:::\n::\n\n::note\nA note.\n::\n")
    const lazy = Object.fromEntries(Object.entries(blocks).map(([tag, block]) => [tag, vue.defineAsyncComponent(async () => block)]))
    // An async component adds a level to the ids that `useId()` makes. The server and the client both render it.
    const render = async (map: Record<string, vue.Component>) => (await renderToString(vue.createSSRApp(renderer({}, {}, map), { document }))).replace(/\bv-[\d-]+/g, "v-id")
    const eager = await render(blocks)
    expect(eager).toContain('class="ct-tab"')
    expect(eager).toContain('class="cgc" data-type="note"')
    expect(await render(lazy)).toBe(eager)
  })

  it("lets a tutorial replace the built-in pre block by its Markdown tag", async () => {
    const document = await parseMarkdown("```ts [index.ts]\nexport const answer = 42\n```\n")
    const html = await renderToString(vue.createSSRApp(renderer(), { document, components: { pre: block("tutorial-code") } }))
    expect(html).toContain('data-component="tutorial-code"')
  })

  it("keeps preview headings out of the page audit, including headings in inactive panels", async () => {
    const document = await parseMarkdown("# Page\n\n## Examples\n\n::examples\n:::example{label=First}\n```md\n# Demo\n\n### Nested preview\n```\n:::\n:::example{label=Second}\n```md\n# Other demo\n```\n:::\n::\n\n## After examples\n")
    const preview = vue.defineComponent({ setup: (_, { slots }) => () => vue.h("div", { class: "docs-example-preview" }, slots.default?.()) })
    const html = await renderToString(vue.createSSRApp(renderer({}, { ExamplePreview: preview }), { document }))
    expect(html).toContain("Demo")
    expect(html).toContain("Other demo")
    const page = readDocsSeoPage("/", html, "https://docs.example.com")
    expect(page.h1).toBe(1)
    expect(page.headingSkip).toBeNull()
    expect(docsSeoProblems([page], [])).not.toEqual(expect.arrayContaining([expect.stringMatching(/h1 headings|skips a heading/)]))
  })

  it("renders example headings without duplicating page anchors", async () => {
    const document = await parseMarkdown("## Install\n\n::example\n```md\n## Install\n\n### Preview details\n```\n::\n\n::example\n```md\n## Install\n```\n::\n")
    const html = await renderToString(vue.createSSRApp(renderer(), { document }))

    expect(html.match(/id="install"/g)).toHaveLength(1)
    expect(html.match(/href="#install"/g)).toHaveLength(1)
    expect(html.match(/<h2\b/g)).toHaveLength(3)
    expect(html).toMatch(/<h3\b[^>]*>Preview details<\/h3>/)
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1])
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe("diagrams", () => {
  const page = readFileSync(resolve(import.meta.dirname, "fixtures/diagrams.md"), "utf8")
  const disabled = [
    { name: "default options", options: undefined },
    { name: "diagrams: false", options: { comarkUi: { diagrams: false } } },
    { name: "diagrams: { draw: false }", options: { comarkUi: { diagrams: { draw: false } } } },
  ] as const

  it.each(disabled)("rejects authored diagram SVG with $name", async ({ options }) => {
    const fetch = vi.spyOn(globalThis, "fetch")
    try {
      const document = await createDocsParser(options)(`::diagram
---
svg: '<svg xmlns="http://www.w3.org/2000/svg" onload="globalThis.__diagramOnload=1"><script>globalThis.__diagramScript=1</script></svg>'
---
::`)
      const html = await renderToString(vue.createSSRApp(renderer(), { document }))
      expect(html).not.toContain("__diagram")
      expect(html).not.toContain("<svg")
      expect(document.nodes.find(node => typeof node !== "string" && node[0] === "diagram")?.[1]).not.toHaveProperty("svg")
      expect(fetch).not.toHaveBeenCalled()
    }
    finally {
      fetch.mockRestore()
    }
  })

  it("draws a Mermaid fence as an SVG on the server, without a network request", async () => {
    const fetch = vi.spyOn(globalThis, "fetch")
    try {
      const document = await parseMarkdown(page)
      expect(document.nodes.find(node => typeof node !== "string" && node[0] === "pele")).toEqual(["pele", { language: "mermaid", content: expect.stringContaining("Router --> Handler") }])

      const html = await renderToString(vue.createSSRApp(renderer(), { document }))
      const diagram = html.slice(html.indexOf('class="cmm"'))
      expect(diagram).toMatch(/^class="cmm" data-source="graph LR[^"]*"><div class="[^"]*" data-diagram="flowchart"[^>]*><svg/)
      expect(diagram).toContain(">Handler<")
      expect(fetch).not.toHaveBeenCalled()
    }
    finally {
      fetch.mockRestore()
    }
  })

  it.each(disabled)("keeps a D2 fence as code without a request with $name", async ({ options }) => {
    const fetch = vi.spyOn(globalThis, "fetch")
    try {
      const document = await createDocsParser(options)(page)
      expect(document.nodes.find(node => typeof node !== "string" && node[0] === "pre")?.[1]).toMatchObject({ language: "d2" })
      expect(fetch).not.toHaveBeenCalled()
    }
    finally {
      fetch.mockRestore()
    }
  })

  it.each([
    { name: "kroki.io", diagrams: true, server: "https://kroki.io" },
    { name: "a custom server", diagrams: { server: "https://kroki.example.com" }, server: "https://kroki.example.com" },
  ])("sends a D2 fence to $name when a site opts in", async ({ diagrams, server }) => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('<svg viewBox="0 0 10 10"><text>server</text></svg>'))
    try {
      const document = await createDocsParser({ comarkUi: { diagrams } })(page)
      expect(fetch).toHaveBeenCalledWith(`${server}/d2/svg`, expect.objectContaining({ method: "POST" }))
      expect(document.nodes.find(node => typeof node !== "string" && node[0] === "diagram")?.[1]).toMatchObject({ type: "d2", svg: expect.stringContaining("<svg") })
    }
    finally {
      fetch.mockRestore()
    }
  })
})
