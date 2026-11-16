import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { runInNewContext } from "node:vm"

import { ModuleKind, ScriptTarget, transpileModule } from "typescript"
import { expect, it } from "vitest"

const source = readFileSync(resolve(import.meta.dirname, "../runtime/app/plugins/comark-css.ts"), "utf8")

function link(names: string[]) {
  const { outputText } = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ESNext } })
  const heads: Array<{ link: Array<Record<string, string>> }> = []
  const exports: { default?: () => void } = {}
  runInNewContext(outputText, {
    exports,
    require: (id: string) => {
      if (id === "#docs/comark-css") return { __esModule: true, default: "comark-0123456789.css", names }
      if (id === "#imports") return {
        defineNuxtPlugin: (plugin: () => void) => plugin,
        useHead: (input: { link: Array<Record<string, string>> }) => heads.push(input),
        useRuntimeConfig: () => ({ app: { baseURL: "/docs", cdnURL: "" } }),
      }
      throw new Error(`Unexpected plugin import: ${id}`)
    },
  })
  exports.default!()
  return heads[0]!.link[0]!
}

it("links comark-ui's styles after the app's CSS, marked for each package so no component adds them again", () => {
  expect(link(["zoom", "mermaid", "issues"])).toEqual({
    "rel": "stylesheet",
    "href": "/docs/_docs/comark-0123456789.css",
    "tagPriority": "low",
    "data-comark-zoom": "",
    "data-comark-mermaid": "",
    "data-comark-issues": "",
  })
})
