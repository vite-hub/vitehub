import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { installStaleChunkReloadNuxt, staleChunkReloadPluginName, staleChunkReloadVitePlugin } from "../src/stale-chunk-reload.ts"

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
