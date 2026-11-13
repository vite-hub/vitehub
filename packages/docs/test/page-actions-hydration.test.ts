// @vitest-environment happy-dom

import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"
import { runInNewContext } from "node:vm"

import { CopyButton, useCopy } from "@vite-hub/ui"
import { ModuleKind, ScriptTarget, transpileModule } from "typescript"
import { afterEach, expect, it, vi } from "vitest"
import * as vue from "vue"
import { compileScript, parse } from "vue/compiler-sfc"
import { renderToString } from "vue/server-renderer"

import { resolveDocsTheme } from "../runtime/app/utils/docs-theme.ts"

// Vue captures these at import time. Hold idle hydration until the test releases it.
const { idleCallbacks } = vi.hoisted(() => {
  const idleCallbacks: Array<() => void> = []
  vi.stubGlobal("requestIdleCallback", (callback: () => void) => idleCallbacks.push(callback))
  vi.stubGlobal("cancelIdleCallback", vi.fn())
  return { idleCallbacks }
})

function evaluate(source: string, imports: Record<string, unknown>, globals = {}) {
  const { outputText } = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ESNext } })
  const exports: Record<string, unknown> = {}
  runInNewContext(outputText, {
    ...vue, Element, MouseEvent, KeyboardEvent, ...globals, exports,
    require: (name: string) => {
      if (name in imports) return imports[name]
      throw new Error(`Unexpected import: ${name}`)
    },
  })
  return exports
}

const filename = resolve(import.meta.dirname, "../runtime/app/components/DocsPageHeaderLinks.vue")
const { descriptor } = parse(readFileSync(filename, "utf8"), { filename })
const source = compileScript(descriptor, { id: "page-actions", inlineTemplate: true }).content
const Header = evaluate(source, {
  vue,
  "@vite-hub/ui": { CopyButton, useCopy },
  "#docs/navigation": {
    findDocsPage: () => ({}),
    docsMarkdownLinks: () => ({ markdownPath: "/docs/page.md" }),
    docsMcpInstallLinks: () => ({}),
  },
}, {
  useRoute: () => ({ path: "/docs/page" }),
  useToast: () => ({ add: vi.fn() }),
  useDocsManifest: () => ({}),
  useDocsConfig: () => ({ site: {}, appBase: "/" }),
}).default as vue.Component

// Use Nuxt's actual nested async boundary, including its `hydrated` event.
const require = createRequire(import.meta.url)
const lazyRuntime = readFileSync(resolve(dirname(require.resolve("nuxt/package.json")), "dist/components/runtime/lazy-hydrated-component.js"), "utf8")
const { createLazyIdleComponent } = evaluate(lazyRuntime.replaceAll("import.meta.server", "false"), {
  vue,
  "#app/nuxt": {},
  "#app/composables/lazy-hydration": {},
}) as { createLazyIdleComponent: (id: string, loader: () => Promise<vue.Component>) => vue.Component }

// Stand in for the dropdown UI. Opening is controlled, and a hydrated trigger toggles it like Reka.
const menuMounted = vi.fn()
const Menu = vue.defineComponent({
  inheritAttrs: false,
  props: { open: { type: Boolean, default: undefined } },
  emits: ["update:open"],
  setup(props, { slots, emit }) {
    const localOpen = vue.ref(false)
    const open = vue.computed(() => props.open ?? localOpen.value)
    vue.onMounted(menuMounted)
    return () => [
      vue.cloneVNode(slots.default!()[0]!, { onClick: () => {
        localOpen.value = !open.value
        emit("update:open", localOpen.value)
      } }),
      ...open.value ? [vue.h("div", { role: "menu" }, "Page actions")] : [],
    ]
  },
})

function app(loader: () => Promise<vue.Component>) {
  const app = vue.createSSRApp(Header)
    .component("UFieldGroup", vue.defineComponent({ setup: (_, { attrs, slots }) => () => vue.h("div", attrs, slots.default?.()) }))
    .component("UButton", vue.defineComponent({ setup: (_, { attrs, slots }) => () => vue.h("button", attrs, slots.default?.()) }))
    .component("LazyUDropdownMenu", createLazyIdleComponent("test-menu", loader))
  // Nuxt auto-imports the shell's composables into templates. This standalone harness supplies the same helper,
  // with the empty scope a docs-only site gets, while exercising the real lazy hydration boundary below.
  app.config.globalProperties.withDocsTheme = evaluate(
    readFileSync(resolve(import.meta.dirname, "../runtime/app/composables/docs-theme.ts"), "utf8"),
    {
      "#docs/theme": { __esModule: true, default: { ui: {}, props: {} } },
      "../utils/docs-theme": { resolveDocsTheme },
    },
  ).withDocsTheme
  return app
}

const cleanups: Array<() => void> = []
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup())
  idleCallbacks.length = 0
  menuMounted.mockClear()
})

async function mount() {
  const container = document.createElement("div")
  container.innerHTML = await renderToString(app(async () => Menu))
  document.body.append(container)
  const chunk = Promise.withResolvers<vue.Component>()
  const load = vi.fn(() => chunk.promise)
  const client = app(load)
  client.mount(container)
  cleanups.push(() => { client.unmount(); container.remove() })
  await vi.waitFor(() => expect(idleCallbacks).toHaveLength(1))
  return { container, chunk, load, trigger: container.querySelector<HTMLButtonElement>('[aria-label="More page actions"]')! }
}

it.each(["click", "touch", "Enter", " ", "ArrowDown"])("preserves the first %s before idle hydration and chunk loading", async (activation) => {
  const { container, chunk, load, trigger } = await mount()
  expect(load).not.toHaveBeenCalled()
  trigger.dispatchEvent(activation === "click" || activation === "touch"
    ? new PointerEvent("click", { pointerType: activation === "touch" ? "touch" : "mouse", bubbles: true, cancelable: true })
    : new KeyboardEvent("keydown", { key: activation, bubbles: true, cancelable: true }))
  await vi.waitFor(() => expect(load).toHaveBeenCalledOnce())
  expect(container.querySelector('[role="menu"]')).toBeNull()
  chunk.resolve(Menu)
  await vi.waitFor(() => expect(container.querySelector('[role="menu"]')).not.toBeNull())
  container.querySelector<HTMLButtonElement>('[aria-label="More page actions"]')!.click()
  await vi.waitFor(() => expect(container.querySelector('[role="menu"]')).toBeNull())
})

it("preserves a click while the idle-started chunk is still loading", async () => {
  const { container, chunk, load, trigger } = await mount()
  idleCallbacks[0]!()
  await vi.waitFor(() => expect(load).toHaveBeenCalledOnce())
  trigger.click()
  await vue.nextTick()
  chunk.resolve(Menu)
  await vi.waitFor(() => expect(container.querySelector('[role="menu"]')).not.toBeNull())
})

it("leaves a fully hydrated menu closed until its trigger is activated", async () => {
  const { container, chunk, load, trigger } = await mount()
  idleCallbacks[0]!()
  await vi.waitFor(() => expect(load).toHaveBeenCalledOnce())
  chunk.resolve(Menu)
  await vi.waitFor(() => expect(menuMounted).toHaveBeenCalledOnce())
  expect(container.querySelector('[role="menu"]')).toBeNull()
  trigger.click()
  await vi.waitFor(() => expect(container.querySelector('[role="menu"]')).not.toBeNull())
})
