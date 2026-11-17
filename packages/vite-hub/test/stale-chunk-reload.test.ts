import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runInNewContext } from "node:vm"

import { afterEach, describe, expect, it, vi } from "vitest"

import { installStaleChunkReloadNuxt, staleChunkReloadNuxtPluginSource, staleChunkReloadPluginName, staleChunkReloadVitePlugin } from "../src/stale-chunk-reload.ts"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-stale-chunk-"))
  roots.push(root)
  return root
}

describe("stale chunk reload", () => {
  it("adds the reload script to the index.html of a build", () => {
    const plugin = staleChunkReloadVitePlugin()
    expect(plugin).toMatchObject({ apply: "build", name: staleChunkReloadPluginName })
    expect(Reflect.apply(plugin.transformIndexHtml as () => unknown, plugin, [])).toEqual([expect.objectContaining({ tag: "script", injectTo: "head-prepend" })])
  })

  it("adds the Nuxt plugin only when Nuxt reloads at navigation alone", async () => {
    const root = await project()
    const automatic = { options: { experimental: { emitRouteChunkError: "automatic" }, plugins: [] } }
    await installStaleChunkReloadNuxt(automatic, root)
    await installStaleChunkReloadNuxt(automatic, root)
    expect(automatic.options.plugins).toEqual([join(root, ".vitehub/stale-chunk-reload/nuxt-plugin.client.mjs")])
    expect(await readFile(automatic.options.plugins[0]!, "utf8")).toContain("vite:preloadError")

    for (const emitRouteChunkError of ["automatic-immediate", "manual", false]) {
      const nuxt = { options: { experimental: { emitRouteChunkError }, plugins: [] } }
      await installStaleChunkReloadNuxt(nuxt, root)
      expect(nuxt.options.plugins).toEqual([])
    }
  })
})

// Nuxt registers its normal window listener before application plugins run.
function nuxtPreload(css: boolean, optOut?: "before" | "after" | "capture") {
  const listeners: Array<{ callback: (event: Event) => void, capture: boolean }> = []
  const reload = vi.fn()
  const cancel = (event: Event) => event.preventDefault()
  if (optOut === "before" || optOut === "capture") listeners.push({ callback: cancel, capture: optOut === "capture" })
  listeners.push({ callback: (event) => { if (css) event.preventDefault() }, capture: false })
  runInNewContext(staleChunkReloadNuxtPluginSource().replace(/^import .*\n/, "").replace("export default ", ""), {
    defineNuxtPlugin: ({ setup }: { setup: () => void }) => setup(),
    useRouter: () => ({ beforeEach() {}, afterEach() {}, onError() {}, currentRoute: { value: { fullPath: "/orders" } } }),
    useRuntimeConfig: () => ({ app: { baseURL: "/" } }),
    reloadNuxtApp: reload,
    setTimeout: (callback: () => void) => queueMicrotask(callback),
    window: { addEventListener: (_name: string, callback: (event: Event) => void, capture = false) => listeners.push({ callback, capture }) },
  })
  if (optOut === "after") listeners.push({ callback: cancel, capture: false })
  const event = Object.assign(new Event("vite:preloadError", { cancelable: true }), { payload: new Error(css ? "Unable to preload CSS for /old.css" : "Failed to fetch dynamically imported module") })
  for (const listener of [...listeners.filter(item => item.capture), ...listeners.filter(item => !item.capture)]) listener.callback(event)
  return reload
}

it.each([false, true])("recovers from a Nuxt preload error (CSS: %s)", async (css) => {
  const reload = nuxtPreload(css)
  await Promise.resolve()
  expect(reload).toHaveBeenCalledWith({ path: "/orders", persistState: true })
})

it.each(["before", "after", "capture"] as const)("keeps application cancellation %s the Nuxt plugin", async (order) => {
  for (const css of [false, true]) {
    const reload = nuxtPreload(css, order)
    await Promise.resolve()
    expect(reload).not.toHaveBeenCalled()
  }
})
