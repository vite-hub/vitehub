import { existsSync, readdirSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { runInNewContext } from "node:vm"

import { ModuleKind, ScriptTarget, transpileModule } from "typescript"
import { expect, it } from "vitest"
import * as vue from "vue"
import { compileScript, parse } from "vue/compiler-sfc"
import { renderToString } from "vue/server-renderer"

import { docsThemeScope, docsUi, type DocsThemeUi } from "../src/theme.ts"

const uiRequire = createRequire(import.meta.resolve("@nuxt/ui"))
const uiDist = dirname(fileURLToPath(import.meta.resolve("@nuxt/ui")))
// Use the installed Nuxt UI theme generator, components, prop resolution, and class merger.
const sharedFile = readdirSync(resolve(uiDist, "shared")).find(file => file.endsWith(".mjs"))!
const shared = uiRequire(resolve(uiDist, "shared", sharedFile)) as {
  d: object
  e: (options: object, config: object) => Array<{ filename: string, getContents: () => string | Promise<string> }>
}
const headerTheme = await shared.e(shared.d, {}).find(template => template.filename === "ui/page-header.ts")!.getContents()

function harness(ui: DocsThemeUi, embedded = true) {
  const route = {
    path: "/docs",
    fullPath: "/docs",
    name: undefined,
    params: {},
    query: {},
    hash: "",
    matched: [],
    meta: { header: false },
    redirectedFrom: undefined,
  }
  const appConfig = vue.reactive({ ui })
  const design = embedded ? docsThemeScope(docsUi("Acme")) : { ui: {}, props: {} }
  const cache = new Map<string, Record<string, unknown>>()
  const imports: Record<string, unknown> = {
    vue,
    "#imports": { useAppConfig: () => appConfig },
    "#build/app.config": { __esModule: true, default: appConfig },
    "#docs/theme": { __esModule: true, default: design },
    "#docs/shell": { ownsApp: !embedded },
    "#docs/navigation": { docsAppPath: (path: string) => path, normalizeDocsPath: (path: string) => path },
    "../utils": uiRequire(resolve(uiDist, "runtime/utils/index.js")),
    "../utils/index.js": uiRequire(resolve(uiDist, "runtime/utils/index.js")),
    "./Button.vue": { __esModule: true, default: vue.defineComponent(() => () => null) },
  }
  function evaluate(source: string, filename: string): Record<string, unknown> {
    const exports: Record<string, unknown> = {}
    cache.set(filename, exports)
    const { outputText } = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ESNext } })
    runInNewContext(outputText, {
      ...vue, exports,
      useAppConfig: () => appConfig,
      useRoute: () => route,
      useDocsConfig: () => ({ site: { name: "Acme" }, appBase: "/" }),
      useHead: () => {}, useSeoMeta: () => {},
      require: (name: string) => {
        if (name in imports) return imports[name]
        if (!name.startsWith(".")) return uiRequire(name)
        const path = resolve(dirname(filename), name)
        return load([path, `${path}.ts`, `${path}.js`].find(existsSync)!)
      },
    })
    return exports
  }
  function load(filename: string): Record<string, unknown> {
    if (cache.has(filename)) return cache.get(filename)!
    const source = readFileSync(filename, "utf8")
    return evaluate(filename.endsWith(".vue")
      ? compileScript(parse(source, { filename }).descriptor, { id: filename, inlineTemplate: true }).content
      : source, filename)
  }
  imports["#build/ui/page-header"] = evaluate(headerTheme, "page-header-theme.ts")
  const propModule = load(resolve(uiDist, "runtime/composables/useComponentProps.js"))
  const useComponentProps = propModule.useComponentProps as (name: string, props: Record<string, unknown>) => Record<string, unknown>
  const Button = vue.defineComponent({
    props: { color: String, size: String },
    setup(props) {
      const defaults = useComponentProps("button", props)
      return () => vue.h("button", { "data-color": defaults.color, "data-size": defaults.size })
    },
  })
  const Theme = load(resolve(uiDist, "runtime/components/Theme.vue")).default as vue.Component
  const Header = load(resolve(uiDist, "runtime/components/PageHeader.vue")).default as vue.Component
  const Shell = load(resolve(import.meta.dirname, "../runtime/app/components/DocsAppShell.vue")).default as vue.Component
  const { withDocsTheme } = load(resolve(import.meta.dirname, "../runtime/app/composables/docs-theme.ts")) as {
    withDocsTheme: (component: string, ui: Record<string, string>) => Record<string, string>
  }
  async function render(scoped = true, shellUi = false) {
    const content = () => [vue.h(Header, { title: "Guide", ...shellUi ? { ui: withDocsTheme("pageHeader", { title: "tracking-tight" }) } : {} }), vue.h(Button)]
    const app = vue.createSSRApp({ render: () => scoped ? vue.h(Shell, null, { default: content }) : content() })
    app.component("UTheme", Theme)
    app.component("AppHeader", vue.defineComponent(() => () => null))
    app.component("AppSearch", vue.defineComponent(() => () => null))
    app.component("ClientOnly", vue.defineComponent(() => () => null))
    app.component("DocsAssistant", vue.defineComponent(() => () => null))
    app.config.globalProperties.$route = route
    return renderToString(app)
  }
  return { appConfig, render }
}

it.each([false, true])("preserves runtime app-config slots and default props inside the docs shell (shell UI=%s)", async (shellUi) => {
  const { appConfig, render } = harness({
    pageHeader: { slots: { title: "text-red-500 text-5xl" } },
    button: { defaultVariants: { color: "primary", size: "lg" } },
  })
  const html = await render(true, shellUi)
  expect(html).toMatch(/<h1[^>]*text-red-500[^>]*text-5xl/)
  expect(html).toContain('data-color="primary" data-size="lg"')
  expect(html).toContain("Guide")
  // Runtime updates must also win over the static generated design.
  appConfig.ui.pageHeader = { slots: { title: "text-blue-500 text-6xl" } }
  expect(await render(true, shellUi)).toMatch(/<h1[^>]*text-blue-500[^>]*text-6xl/)
})

it("applies docs defaults only inside the docs shell", async () => {
  const { render } = harness({})
  expect(await render()).toContain('data-color="neutral" data-size="sm"')
  const outside = await render(false)
  expect(outside).not.toContain('data-color="neutral"')
  expect(outside).not.toContain('data-size="sm"')
  expect(outside).not.toContain("text-[2rem]")
})

it("keeps a standalone site's app-config theme", async () => {
  const { render } = harness({
    pageHeader: { slots: { title: "text-red-500 text-5xl" } },
    button: { defaultVariants: { color: "primary", size: "lg" } },
  }, false)
  const html = await render()
  expect(html).toMatch(/<h1[^>]*text-red-500[^>]*text-5xl/)
  expect(html).toContain('data-color="primary" data-size="lg"')
})
