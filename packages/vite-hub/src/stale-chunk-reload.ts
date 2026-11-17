import { join } from "node:path"

import { writeFileIfChanged } from "@vite-hub/internal/definition-catalog"

import type { Plugin } from "vite"

/**
 * After a deploy, an open tab still asks for the chunks of the old build. The host no longer has them, so a lazy page,
 * component, or `import()` fails. Vite reports each failure as a `vite:preloadError` window event. ViteHub reloads the
 * page once, so the tab gets the new build. A second failure within 10 seconds does not reload again, so a chunk that
 * is missing from the new build too cannot cause a reload loop. A listener of the app that calls
 * `event.preventDefault()` keeps the page as it is.
 */
export const staleChunkReloadScript = [
  `addEventListener("vite:preloadError", event => setTimeout(() => {`,
  `  if (event.defaultPrevented) return`,
  `  try {`,
  `    if (Date.now() - Number(sessionStorage.getItem("vitehub:chunk-reload")) < 10000) return`,
  `    sessionStorage.setItem("vitehub:chunk-reload", String(Date.now()))`,
  `  }`,
  `  catch { return }`,
  `  location.reload()`,
  `}))`,
].join("\n")

export const staleChunkReloadPluginName = "vite-hub/stale-chunk-reload"

/** Adds the stale chunk reload to the `index.html` of a built Vite app. Nuxt renders its own HTML and uses the Nuxt plugin. */
export function staleChunkReloadVitePlugin(): Plugin {
  return {
    name: staleChunkReloadPluginName,
    apply: "build",
    transformIndexHtml: () => [{ tag: "script", children: staleChunkReloadScript, injectTo: "head-prepend" }],
  }
}

/**
 * Nuxt reloads when a page chunk fails during a navigation (`experimental.emitRouteChunkError: "automatic"`, the
 * default). It does not reload when a chunk fails after the page shows, such as a lazy component or an `import()` in a
 * click handler. This plugin reloads at the current page for those failures and keeps the payload state, like Nuxt.
 * `reloadNuxtApp()` does not reload the same path again within 10 seconds.
 */
export function staleChunkReloadNuxtPluginSource(): string {
  return [
    `import { defineNuxtPlugin, reloadNuxtApp, useRouter, useRuntimeConfig } from "#imports"`,
    ``,
    `export default defineNuxtPlugin({`,
    `  name: "vite-hub:stale-chunk-reload",`,
    `  setup() {`,
    `    const router = useRouter()`,
    `    const baseURL = useRuntimeConfig().app.baseURL.replace(/\\/$/, "")`,
    `    let navigating = false`,
    `    router.beforeEach(() => { navigating = true })`,
    `    router.afterEach(() => { navigating = false })`,
    `    router.onError(() => { navigating = false })`,
    `    window.addEventListener("vite:preloadError", (event) => {`,
    `      // Nuxt reloads at the target page when a chunk fails during a navigation.`,
    `      if (navigating) return`,
    `      setTimeout(() => {`,
    `        if (!event.defaultPrevented) reloadNuxtApp({ path: baseURL + router.currentRoute.value.fullPath, persistState: true })`,
    `      })`,
    `    })`,
    `  },`,
    `})`,
    ``,
  ].join("\n")
}

interface StaleChunkReloadNuxt {
  options: {
    experimental?: { emitRouteChunkError?: unknown }
    plugins?: Array<string | { src: string }>
  }
}

/**
 * Adds the client plugin when Nuxt handles chunk errors on its own, with `emitRouteChunkError: "automatic"`.
 * `"automatic-immediate"` already reloads on every chunk error, and `"manual"` or `false` means the app decides.
 */
export async function installStaleChunkReloadNuxt(nuxt: StaleChunkReloadNuxt, projectRoot: string): Promise<void> {
  if (nuxt.options.experimental?.emitRouteChunkError !== "automatic") return
  // Nuxt clears its build directory after modules run, so the plugin goes to `.vitehub/`.
  const plugin = join(projectRoot, ".vitehub/stale-chunk-reload/nuxt-plugin.client.mjs")
  await writeFileIfChanged(plugin, staleChunkReloadNuxtPluginSource())
  const plugins = (nuxt.options.plugins ??= [])
  if (!plugins.some(entry => (typeof entry === "string" ? entry : entry.src) === plugin)) plugins.push(plugin)
}
