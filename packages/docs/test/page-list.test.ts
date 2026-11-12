import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { runInNewContext } from "node:vm"

import { ModuleKind, ScriptTarget, transpileModule } from "typescript"
import { describe, expect, it } from "vitest"
import * as vue from "vue"
import { compileScript, parse } from "vue/compiler-sfc"
import { renderToString } from "vue/server-renderer"

import { createDocsManifest } from "../src/manifest.ts"
import { docsPageIcon, type DocsIcons } from "../src/navigation.ts"

const filename = resolve(import.meta.dirname, "../runtime/app/components/content/PageList.vue")
const { descriptor } = parse(readFileSync(filename, "utf8"), { filename })
const script = compileScript(descriptor, { id: "page-list", inlineTemplate: true }).content
const { outputText } = transpileModule(script, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ESNext } })
const manifest = await createDocsManifest({ dir: resolve(import.meta.dirname, "fixtures/content"), base: "/docs" })
const section = manifest.sections.find(candidate => candidate.id === "kv")!
const page = section.pages.find(candidate => candidate.id === "api")!
const icons: DocsIcons = {
  rail: {},
  sections: {},
  pages: { "/docs/kv/mapped": "i-ph-gear-light" },
  aliases: { "i-lucide-database": "i-ph-database-light" },
  family: "i-ph-",
  page: "i-ph-file-light",
  section: "i-ph-folder-light",
  stroke: 1.5,
}

describe("PageList", () => {
  it.each([
    { id: "mapped", icon: "i-lucide-code", expected: "i-ph-gear-light" },
    { id: "aliased", icon: "i-lucide-database", expected: "i-ph-database-light" },
    { id: "outside-family", icon: "i-lucide-code", expected: "i-ph-file-light" },
    { id: "default", icon: null, expected: "i-ph-file-light" },
    { id: "inside-family", icon: "i-ph-code-light", expected: "i-ph-code-light" },
  ])("renders the configured icon for $id pages", async ({ id, icon, expected }) => {
    const current = { ...section, pages: [{ ...page, id, path: `/docs/kv/${id}`, icon }] }
    const exports: { default?: vue.Component } = {}
    runInNewContext(outputText, {
      ...vue,
      exports,
      require: (name: string) => {
        if (name === "vue") return vue
        throw new Error(`Unexpected component import: ${name}`)
      },
      useDocsManifest: () => ({ ...manifest, sections: [current] }),
      useDocsSection: () => vue.ref(current),
      useDocsPage: () => vue.ref(null),
      useDocsIcons: () => ({ page: (item: typeof page) => docsPageIcon(icons, item) }),
    })
    const app = vue.createSSRApp(exports.default!)
    app.component("NuxtLink", vue.defineComponent({
      props: ["to"],
      setup: (props, { slots }) => () => vue.h("a", { href: props.to }, slots.default?.()),
    }))
    app.component("UIcon", vue.defineComponent({
      props: ["name"],
      setup: props => () => vue.h("span", { "data-icon": props.name }),
    }))

    const html = await renderToString(app)
    expect(html).toContain(`href="/docs/kv/${id}"`)
    expect(html).toContain(`data-icon="${expected}"`)
  })
})
