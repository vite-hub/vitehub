// @vitest-environment happy-dom

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { runInNewContext } from "node:vm"

import { ModuleKind, ScriptTarget, transpileModule } from "typescript"
import { expect, it } from "vitest"
import * as vue from "vue"
import { compileScript, parse } from "vue/compiler-sfc"
import * as serverRenderer from "vue/server-renderer"

function compile(): vue.Component {
  const filename = resolve(import.meta.dirname, "../runtime/app/components/content/ComarkHtml.vue")
  const { descriptor } = parse(readFileSync(filename, "utf8"), { filename })
  const source = compileScript(descriptor, { id: "comark-html", inlineTemplate: true }).content
  const { outputText } = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ESNext } })
  const exports: { default?: vue.Component } = {}
  // Nuxt auto-imports Vue's API, such as `ref` and `onMounted`, so the sandbox has it as globals.
  runInNewContext(outputText, { ...vue, document, exports, require: () => vue })
  return exports.default!
}

// A site with a nonce-based CSP, such as one using nuxt-security, blocks every inline script without the page's nonce.
it("gives the scripts it runs after hydration the page's nonce", async () => {
  // Under a CSP header, the browser empties the nonce attribute of every script and keeps the value only in the
  // `nonce` property, which happy-dom doesn't have.
  const entry = document.createElement("script")
  entry.setAttribute("nonce", "")
  Object.defineProperty(entry, "nonce", { value: "abc" })
  document.head.append(entry)
  const props = { html: "<script>window.ran = true</script>", block: "quiz" }
  const container = document.createElement("div")
  container.innerHTML = await serverRenderer.renderToString(vue.createSSRApp(compile(), props))
  document.body.append(container)

  vue.createSSRApp(compile(), props).mount(container)

  expect(container.querySelector("script")!.nonce).toBe("abc")
})
