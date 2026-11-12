import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { runInNewContext } from "node:vm"

import { ModuleKind, ScriptTarget, transpileModule } from "typescript"
import { expect, it, vi } from "vitest"
import * as vue from "vue"
import { compileScript, compileTemplate, parse } from "vue/compiler-sfc"
import * as serverRenderer from "vue/server-renderer"

/**
 * One shell component as a production build compiles it for the server or for the browser. Production drops template
 * comments, and the server gets its own `ssrRender`.
 */
function compile(file: string, ssr: boolean): vue.ComponentOptions {
  const filename = resolve(import.meta.dirname, "../runtime/app", file)
  const { descriptor } = parse(readFileSync(filename, "utf8"), { filename })
  const script = descriptor.script || descriptor.scriptSetup ? compileScript(descriptor, { id: "test", isProd: true }) : undefined
  const template = descriptor.template
    ? compileTemplate({ source: descriptor.template.content, filename, id: "test", ssr, isProd: true, compilerOptions: { comments: false, bindingMetadata: script?.bindings } }).code
    : ""
  const source = `${(script?.content ?? "export default {}").replace("export default", "const component =")}\n${template}\nexport default component`
  const { outputText } = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ESNext } })
  const exports: { default?: vue.ComponentOptions, render?: vue.ComponentOptions["render"], ssrRender?: vue.ComponentOptions["ssrRender"] } = {}
  // Nuxt auto-imports Vue's API, such as `ref` and `onMounted`, so the sandbox has it as globals.
  runInNewContext(outputText, { ...vue, exports, require: (id: string) => id === "vue/server-renderer" ? serverRenderer : vue })
  return { ...exports.default, ...exports.render && { render: exports.render }, ...exports.ssrRender && { ssrRender: exports.ssrRender } }
}

// `app.vue` renders `<DocsAssistant />` on every page. With the assistant off, the server HTML must be what the browser
// renders, or every page fails hydration with "Hydration completed but contains mismatches".
it("renders the same empty placeholder on the server and in the browser when the assistant is off", async () => {
  const server = await serverRenderer.renderToString(vue.createSSRApp(compile("assistant/DocsAssistantOff.vue", true)))
  // A component without `ssrRender` renders its client vnodes, which is what hydration compares the server HTML with.
  const browser = await serverRenderer.renderToString(vue.createSSRApp({ ...compile("assistant/DocsAssistantOff.vue", false), ssrRender: undefined }))
  expect(server).toBe(browser)
})

// Annotated screenshots, diffs, quizzes, and comments reach the page as server-drawn HTML in `ComarkHtml`. If the server
// HTML leaves it out, the block is empty without JavaScript and the browser fails hydration when it fills it in.
it.each([false, true])("renders an HTML-only block's HTML on the server the same as in the browser (inline=%s)", async (inline) => {
  const props = { html: '<mark class="cr-sg">npm</mark>', block: "suggestion", inline }
  const server = await serverRenderer.renderToString(vue.createSSRApp(compile("components/content/ComarkHtml.vue", true), props))
  const browser = await serverRenderer.renderToString(vue.createSSRApp({ ...compile("components/content/ComarkHtml.vue", false), ssrRender: undefined }, props))
  const tag = inline ? "span" : "div"
  expect(server).toBe(`<${tag} class="comark-html" data-block="suggestion"><mark class="cr-sg">npm</mark></${tag}>`)
  expect(server).toBe(browser)
})

it.each([true, false])("loads only the first example when rendering a tab group (ssr=%s)", async (ssr) => {
  const filename = resolve(import.meta.dirname, "../runtime/app/components/content/Examples.vue")
  const { descriptor } = parse(readFileSync(filename, "utf8"), { filename })
  const script = compileScript(descriptor, { id: "examples", isProd: true, inlineTemplate: true, templateOptions: { ssr } }).content
  const { outputText } = transpileModule(script, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ESNext } })
  const exports: { default?: vue.Component } = {}
  runInNewContext(outputText, { ...vue, exports, require: (id: string) => id === "vue/server-renderer" ? serverRenderer : vue })
  const first = vi.fn(async () => ({ render: () => vue.h("p", "First preview") }))
  const second = vi.fn(async () => ({ render: () => vue.h("p", "Second preview") }))
  const examples = [vue.defineAsyncComponent(first), vue.defineAsyncComponent(second)]
  const app = vue.createSSRApp({ render: () => vue.h(exports.default!, null, { default: () => examples.map(example => vue.h(example)) }) })

  const html = await serverRenderer.renderToString(app)
  expect(html).toContain("First preview")
  expect(html).not.toContain("Second preview")
  expect(first).toHaveBeenCalledOnce()
  expect(second).not.toHaveBeenCalled()
})
