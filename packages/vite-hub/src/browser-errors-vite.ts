import { join } from "node:path"

import { ownModule } from "@vite-hub/internal/build/paths"
import { viteHubPageToolsBase } from "@vite-hub/internal/build/page-tools"
import { writeFileIfChanged } from "@vite-hub/internal/definition-catalog"
import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"

import type { HtmlTagDescriptor, Plugin } from "vite"

/** Below the app base. */
export const browserErrorsRoute = "/_vitehub/browser-errors"

/**
 * The browser code that reports uncaught errors to `endpoint`, a JavaScript expression. It defines `report(kind, error)`
 * and listens to the window `error` and `unhandledrejection` events. It sends each message once and at most 10 reports
 * per page load, with the page path but never its query, and it never throws.
 */
export function browserErrorsReporterSource(endpoint: string): string {
  return [
    `const endpoint = ${endpoint}`,
    `const sent = new Set()`,
    `const report = (kind, error) => {`,
    `  try {`,
    `    const failure = error instanceof Error ? error : new Error(typeof error === "string" ? error : String(error?.message ?? error))`,
    // Leaving a page aborts its requests. That is not a failure.
    `    if (failure.name === "AbortError") return`,
    `    const key = failure.name + ":" + failure.message`,
    `    if (sent.has(key) || sent.size >= 10) return`,
    `    sent.add(key)`,
    `    const body = { kind, path: location.pathname, name: failure.name, message: failure.message.slice(0, 1000), stack: failure.stack?.slice(0, 4000) }`,
    `    fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), keepalive: true }).catch(() => {})`,
    `  }`,
    // A report must not cause a second error.
    `  catch {}`,
    `}`,
    // A failed <img> or <script> load has no error object, and a script of another origin shows only "Script error.".
    `addEventListener("error", event => { if (event.error) report("error", event.error) })`,
    `addEventListener("unhandledrejection", event => report("unhandledrejection", event.reason))`,
  ].join("\n")
}

/** The Nuxt client plugin: the window events, and the Vue and Nuxt errors that Nuxt catches before they reach them. */
export function browserErrorsNuxtPluginSource(): string {
  return [
    `import { defineNuxtPlugin, useRuntimeConfig } from "#imports"`,
    ``,
    `export default defineNuxtPlugin({`,
    `  name: "vite-hub:browser-errors",`,
    `  enforce: "pre",`,
    `  setup(nuxtApp) {`,
    browserErrorsReporterSource(`useRuntimeConfig().app.baseURL.replace(/\\/$/, "") + ${JSON.stringify(browserErrorsRoute)}`).replace(/^/gm, "    "),
    `    nuxtApp.hook("vue:error", error => report("vue", error))`,
    `    nuxtApp.hook("app:error", error => report("nuxt", error))`,
    `  },`,
    `})`,
    ``,
  ].join("\n")
}

/**
 * `observability.browserErrors`: the route `POST <base>/_vitehub/browser-errors`, and in a Vite app the reporter
 * script in `index.html`. Nuxt renders its own HTML, so `installBrowserErrorsNuxt()` adds a client plugin instead.
 */
export function browserErrorsVitePlugin(): Plugin & { config: (config: object) => void, transformIndexHtml: () => HtmlTagDescriptor[] } {
  let base = ""
  return {
    name: "vite-hub/browser-errors",
    config(config: object) {
      const { base: appBase, mount } = viteHubPageToolsBase(config)
      base = appBase
      const kit = createNitroServerKit(Reflect.get(config, "nitro"))
      kit.addHandler({ handler: ownModule(import.meta.url, "_internal/runtime/browser-errors"), method: "POST", route: `${mount}${browserErrorsRoute}` })
      Reflect.set(config, "nitro", kit.config)
    },
    transformIndexHtml: (): HtmlTagDescriptor[] => [{
      tag: "script",
      attrs: { type: "module" },
      children: browserErrorsReporterSource(JSON.stringify(`${base}${browserErrorsRoute}`)),
      injectTo: "head-prepend",
    }],
  }
}

interface BrowserErrorsNuxt {
  options: { plugins?: Array<string | { src: string }> }
}

/** Adds the client plugin of `observability.browserErrors` to a Nuxt app. */
export async function installBrowserErrorsNuxt(nuxt: BrowserErrorsNuxt, projectRoot: string): Promise<void> {
  // Nuxt clears its build directory after modules run, so the plugin goes to `.vitehub/`.
  const plugin = join(projectRoot, ".vitehub/browser-errors/nuxt-plugin.client.mjs")
  await writeFileIfChanged(plugin, browserErrorsNuxtPluginSource())
  const plugins = (nuxt.options.plugins ??= [])
  if (!plugins.some(entry => (typeof entry === "string" ? entry : entry.src) === plugin)) plugins.push(plugin)
}

