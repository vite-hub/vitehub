import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { createNitro } from "nitropack"
import { getRollupConfig } from "nitropack/rollup"
import { afterEach, expect, it } from "vitest"

import { nitroInjectSourcemapsModule } from "../src/internal/nitro-inject-sourcemaps.ts"

type CachedModule = { id: string, sourcemapChain: unknown[] }
type RollupBuild = { cache?: { modules: CachedModule[] }, close: () => Promise<void>, generate: (options: object) => Promise<{ output: Array<{ code?: string }> }> }
type Rollup = { rollup: (options: object) => Promise<RollupBuild> }

// Nitro 2 brings its own Rollup; load the copy that its config was made for.
const nitroRequire = createRequire(import.meta.resolve("nitropack/package.json"))
const { rollup }: Rollup = await import(pathToFileURL(nitroRequire.resolve("rollup")).href)

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

/** Builds a package module twice with Nitro 2's development Rollup config, sharing the cache as Nitro's watcher does. */
async function rebuildCache(modules: unknown[]) {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-nitro-inject-"))
  roots.push(rootDir)
  const entry = join(rootDir, "node_modules/large-package/index.mjs")
  await mkdir(join(entry, ".."), { recursive: true })
  await writeFile(join(entry, "../package.json"), JSON.stringify({ name: "large-package", type: "module" }))
  // Code that names no global that Nitro injects, so the inject plugin returns it unchanged.
  await writeFile(entry, Array.from({ length: 200 }, (_, index) => `export function step${index}(value) { return value + ${index} }`).join("\n"))
  const nitro = await createNitro({ dev: true, externals: { inline: ["large-package"] }, logLevel: 0, modules: modules as never, preset: "nitro-dev", rootDir })
  try {
    const config = getRollupConfig(nitro)
    await nitro.hooks.callHook("rollup:before", nitro, config)
    const options = { ...config, input: entry, onwarn: () => {} }
    let cache: RollupBuild["cache"]
    for (let build = 0; build < 2; build++) {
      const bundle = await rollup({ ...options, cache })
      const { output } = await bundle.generate({ format: "esm" })
      expect(output[0]?.code).toContain("value + 199")
      cache = bundle.cache
      await bundle.close()
    }
    const cached = cache?.modules.find(module => module.id === entry)
    if (!cached) throw new Error("The rebuild did not cache the package module.")
    return cached.sourcemapChain.length
  }
  finally {
    await nitro.close()
  }
}

it("keeps no inject sourcemap for unchanged modules across Nitro 2 rebuilds", { timeout: 60_000 }, async () => {
  // Without the module, Nitro's inject plugin adds a full-resolution identity map to the module on every build.
  expect(await rebuildCache([])).toBe(1)
  expect(await rebuildCache([nitroInjectSourcemapsModule])).toBe(0)
})
