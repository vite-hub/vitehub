import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { runInNewContext } from "node:vm"

import { MarkdownDocument } from "@comark/vue"
import comarkUi from "comark-ui/vue"
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

function renderer(content: Record<string, () => Promise<{ default: vue.Component }>> = {}, custom: Record<string, vue.Component> = {}) {
  const exports: { default?: vue.Component } = {}
  runInNewContext(outputText, {
    ...vue,
    exports,
    require: (id: string) => {
      if (id === "vue") return vue
      if (id === "@comark/vue") return { MarkdownDocument }
      if (id === "comark-ui/vue") return { __esModule: true, default: comarkUi }
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
  it.each(["callout", "note", "tip", "github-callout", "tabs-item"])("loads an app's %s content component before the built-in block", async (tag) => {
    const load = vi.fn(async () => ({ default: block("app") }))
    const component = renderer({ [tag]: load })
    expect(load).not.toHaveBeenCalled()

    const document = { nodes: [[tag, { title: "App title" }, "App content"]], toc: [] }
    const html = await renderToString(vue.createSSRApp(component, { document }))

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
