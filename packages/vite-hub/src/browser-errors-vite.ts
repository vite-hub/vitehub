import { join } from "node:path"

import { ownModule } from "@vite-hub/internal/build/paths"
import { viteHubPageToolsBase } from "@vite-hub/internal/build/page-tools"
import { writeFileIfChanged } from "@vite-hub/internal/definition-catalog"
import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"

import { browserErrorMaxBytes } from "./_internal/browser-error-limits.ts"

import type { HtmlTagDescriptor, Plugin } from "vite"

/** Below the app base. */
export const browserErrorsRoute = "/_vitehub/browser-errors"

/**
 * The browser code that reports errors to `endpoint`, a JavaScript expression. It defines `report(kind, error, options)`,
 * puts it on `globalThis` for `reportBrowserError()` of `vite-hub/logs/client`, and listens to the window `error`,
 * `unhandledrejection`, and `vite:preloadError` events. It sends each action and message once and at most 10 reports per
 * page load, with the page path but never its query, and it never throws.
 */
export function browserErrorsReporterSource(endpoint: string): string {
  return [
    `const endpoint = ${endpoint}`,
    `const seen = new Set()`,
    `let sent = 0`,
    `const flatFields = fields => {`,
    `  const kept = {}`,
    `  let count = 0`,
    `  let dropped = 0`,
    `  for (const [name, value] of Object.entries(fields !== null && typeof fields === "object" ? fields : {})) {`,
    `    const flat = typeof value === "string" || (typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean" || value === null`,
    `    if (count >= 20 || !/^[A-Za-z][\\w.-]{0,39}$/.test(name) || !flat) dropped++`,
    `    else {`,
    `      kept[name] = typeof value === "string" ? value.slice(0, 300) : value`,
    `      count++`,
    `    }`,
    `  }`,
    `  return { fields: count ? kept : undefined, droppedFields: dropped || undefined }`,
    `}`,
    `const encodeBody = body => {`,
    `  const encoder = new TextEncoder()`,
    `  const fits = json => encoder.encode(json).byteLength <= ${browserErrorMaxBytes}`,
    `  let json = JSON.stringify(body)`,
    `  if (fits(json)) return json`,
    `  if (!fits(JSON.stringify({ ...body, fields: undefined }))) body.stack = undefined`,
    `  json = JSON.stringify(body)`,
    `  for (const name of Object.keys(body.fields ?? {}).reverse()) {`,
    `    if (fits(json)) break`,
    `    delete body.fields[name]`,
    `    body.droppedFields = (body.droppedFields ?? 0) + 1`,
    `    if (Object.keys(body.fields).length === 0) body.fields = undefined`,
    `    json = JSON.stringify(body)`,
    `  }`,
    `  return json`,
    `}`,
    `const firstInTab = message => {`,
    `  try {`,
    `    const key = "vite-hub.browserErrors.chunk:" + message`,
    `    if (sessionStorage.getItem(key)) return false`,
    `    sessionStorage.setItem(key, "1")`,
    `  }`,
    `  catch {}`,
    `  return true`,
    `}`,
    `const report = (kind, error, options) => {`,
    `  try {`,
    `    const failure = error instanceof Error ? error : new Error(typeof error === "string" ? error : String(error?.message ?? error))`,
    // Leaving a page aborts its requests. That is not a failure.
    `    if (failure.name === "AbortError") return`,
    `    const action = typeof options?.action === "string" ? options.action.slice(0, 100) : undefined`,
    `    const key = (action ?? "") + "\\n" + failure.message`,
    `    if (seen.has(key) || sent >= 10) return`,
    `    seen.add(key)`,
    `    if (kind === "chunk" && !firstInTab(failure.message)) return`,
    `    const stack = error instanceof Error ? failure.stack?.slice(0, 4000) : undefined`,
    `    const level = options?.level === "warn" ? "warn" : undefined`,
    `    const name = typeof failure.name === "string" ? failure.name.slice(0, 120) : undefined`,
    `    const body = encodeBody({ kind, path: location.pathname.slice(0, 300), name, message: failure.message.slice(0, 1000), stack, action, level, ...flatFields(options?.fields) })`,
    `    sent++`,
    `    fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => {})`,
    `  }`,
    // A report must not cause a second error.
    `  catch {}`,
    `}`,
    `globalThis[Symbol.for("vite-hub.browserErrors")] = report`,
    // A failed <img> or <script> load has no error object, and a script of another origin shows only "Script error.".
    `addEventListener("error", event => { if (event.error) report("error", event.error) })`,
    `addEventListener("unhandledrejection", event => report("unhandledrejection", event.reason))`,
    `const reportPreloadError = error => {`,
    `  const message = error instanceof Error ? error.message : ""`,
    `  const loadFailed = (error instanceof TypeError && (/^(Failed to fetch dynamically imported module: |error loading dynamically imported module: )/.test(message) || message === "Importing a module script failed."))`,
    `    || message.startsWith("Unable to preload CSS for ")`,
    `  report(loadFailed ? "chunk" : "error", error)`,
    `}`,
    `addEventListener("vite:preloadError", event => reportPreloadError(event.payload))`,
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
    `    nuxtApp.hook("app:chunkError", ({ error }) => reportPreloadError(error))`,
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
