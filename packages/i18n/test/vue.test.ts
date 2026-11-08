import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { setupI18n } from "@lingui/core"
import { linguiTemplateTransform } from "@lingui/vue/compiler"
import { compileScript, parse } from "@vue/compiler-sfc"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createSSRApp } from "vue"

import { createLinguiConfig } from "../src/lingui.ts"
import { resolveI18nLocaleConfig } from "../src/locales.ts"
import { transformMacros } from "../src/macros.ts"
import { configureI18n, getI18n } from "../src/runtime.ts"
import { i18nPlugin, useLocale } from "../src/vue.ts"

import type { ComputedRef, VNode } from "vue"

vi.mock("virtual:vite-hub/i18n/client", () => ({}))

const temporaryRoots: string[] = []
interface ComponentState {
  title: ComputedRef<string>
  click: () => string
}

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function compileComponent() {
  const packageRoot = fileURLToPath(new URL("..", import.meta.url))
  await mkdir(join(packageRoot, "test/.tmp"), { recursive: true })
  const root = await mkdtemp(join(packageRoot, "test/.tmp/instance-"))
  temporaryRoots.push(root)
  const { descriptor } = parse(`
<script setup>
import { computed } from "vue"
import { t } from "@vite-hub/i18n"
import { moduleMessage } from "./message.mjs"
const title = computed(() => t({ message: "Hello" }))
const click = () => t({ message: "Hello" })
defineExpose({ title, click })
</script>
<template><p>{{ t\`Hello\` }}|{{ title }}|{{ click() }}|{{ moduleMessage() }}</p></template>
`, { filename: "Instance.vue" })
  const script = compileScript(descriptor, {
    id: "instance",
    inlineTemplate: true,
    templateOptions: { compilerOptions: { nodeTransforms: [linguiTemplateTransform()] } },
  })
  const config = createLinguiConfig({ rootDir: root, locale: resolveI18nLocaleConfig({ locales: ["en", "es"] }), importBase: "@vite-hub/i18n" })
  const module = await transformMacros('import { t } from "@vite-hub/i18n"; export const moduleMessage = () => t({ message: "Hello" })', "message.js", config, "@vite-hub/i18n", "all")
  const runtimePath = JSON.stringify(fileURLToPath(new URL("../src/runtime.ts", import.meta.url)))
  await writeFile(join(root, "message.mjs"), module!.code.replaceAll('"@vite-hub/i18n/runtime"', runtimePath))
  const transformed = await transformMacros(script.content, "Instance.vue", config, "@vite-hub/i18n", "all")
  const code = transformed!.code.replaceAll('"@vite-hub/i18n/runtime"', runtimePath)
    .replaceAll('"@vite-hub/i18n/vue"', JSON.stringify(fileURLToPath(new URL("../src/vue.ts", import.meta.url))))
  const file = join(root, "component.mjs")
  await writeFile(file, code)
  const component = (await import(/* @vite-ignore */ file)).default as {
    setup: (props: object, context: { expose: (state: ComponentState) => void }) => (context: object, cache: unknown[]) => VNode
  }
  const messages = Object.fromEntries([...code.matchAll(/id: "([^"]+)"/g)].map(match => [match[1], "Hola"]))
  return { component, messages }
}

describe("Vue locale state", () => {
  it("switches the plugin instance without changing another app or the runtime instance", async () => {
    const { component, messages } = await compileComponent()
    configureI18n({
      ...resolveI18nLocaleConfig({ locales: ["en", "es"] }),
      catalogs: { es: async () => ({ messages: { ...messages, greeting: "Hola" } }) },
    })
    const runtime = getI18n()
    const runtimeLocale = runtime.locale
    const first = setupI18n({ locale: "en", messages: { en: { greeting: "Hello" } } })
    const second = setupI18n({ locale: "en", messages: { en: { greeting: "Hello" } } })
    const firstApp = createSSRApp({}).use(i18nPlugin({ i18n: first }))
    const secondApp = createSSRApp({}).use(i18nPlugin({ i18n: second }))
    const firstState = firstApp.runWithContext(useLocale)
    const secondState = secondApp.runWithContext(useLocale)
    const exposed: ComponentState[] = []
    const firstRender = firstApp.runWithContext(() => component.setup({}, { expose: state => exposed.push(state) }))
    const secondRender = secondApp.runWithContext(() => component.setup({}, { expose: state => exposed.push(state) }))
    const render = (app: typeof firstApp, render: typeof firstRender) => app.runWithContext(() => render({}, []).children)
    expect(render(firstApp, firstRender)).toBe("Hello|Hello|Hello|Hello")
    expect(render(secondApp, secondRender)).toBe("Hello|Hello|Hello|Hello")
    expect(exposed.map(state => state.click())).toEqual(["Hello", "Hello"])
    const page = { cookie: "", documentElement: { lang: "en" } }
    vi.stubGlobal("document", page)

    expect(await firstState.setLocale("ES")).toEqual([undefined, "es"])
    expect(firstState.locale.value).toBe("es")
    expect(first._("greeting")).toBe("Hola")
    expect(exposed.map(state => state.title.value)).toEqual(["Hola", "Hello"])
    expect(exposed.map(state => state.click())).toEqual(["Hola", "Hello"])
    expect(render(firstApp, firstRender)).toBe("Hola|Hola|Hola|Hola")
    expect(render(secondApp, secondRender)).toBe("Hello|Hello|Hello|Hello")
    expect(page.cookie).toContain("locale=es;")
    expect(page.documentElement.lang).toBe("es")
    expect(secondState.locale.value).toBe("en")
    expect(second._("greeting")).toBe("Hello")
    expect(runtime.locale).toBe(runtimeLocale)
  })
})
