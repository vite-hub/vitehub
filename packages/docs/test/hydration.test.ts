import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { runInNewContext } from "node:vm"

import { ModuleKind, ScriptTarget, transpileModule } from "typescript"
import { expect, it } from "vitest"
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
  const script = descriptor.script ? compileScript(descriptor, { id: "test", isProd: true }).content : "export default {}"
  const template = descriptor.template
    ? compileTemplate({ source: descriptor.template.content, filename, id: "test", ssr, isProd: true, compilerOptions: { comments: false } }).code
    : ""
  const source = `${script.replace("export default", "const component =")}\n${template}\nexport default component`
  const { outputText } = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ESNext } })
  const exports: { default?: vue.ComponentOptions, render?: vue.ComponentOptions["render"], ssrRender?: vue.ComponentOptions["ssrRender"] } = {}
  runInNewContext(outputText, { exports, require: (id: string) => id === "vue/server-renderer" ? serverRenderer : vue })
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
