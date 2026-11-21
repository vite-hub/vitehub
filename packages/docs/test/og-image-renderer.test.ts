import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

import { expect, it } from "vitest"

it("renders share images in an app that does not install @takumi-rs/core", async () => {
  // A pnpm app installs the docs package and its peers, but not the docs dependencies, such as @takumi-rs/core. Link
  // this package's dependencies into an app outside it, all but that one.
  const packageModules = join(import.meta.dirname, "../node_modules")
  const root = await mkdtemp(join(import.meta.dirname, "../../../.tmp-og-image-renderer-"))
  try {
    await mkdir(join(root, "node_modules"))
    for (const name of await readdir(packageModules)) {
      if (name.startsWith(".") || name === "@takumi-rs") continue
      await symlink(join(packageModules, name), join(root, "node_modules", name), "junction")
    }
    await mkdir(join(root, "content"))
    await writeFile(join(root, "content/index.md"), "---\ntitle: Lumen\n---\nHello\n")
    await writeFile(join(root, "nuxt.config.ts"), "export default defineNuxtConfig({})\n")
    const script = join(root, "build.mjs")
    await writeFile(script, [
      "import { createRequire } from \"node:module\"",
      `import { build, loadNuxt } from ${JSON.stringify(import.meta.resolve("nuxt"))}`,
      "try { createRequire(`${process.cwd()}/`).resolve(\"@takumi-rs/core\") } catch { globalThis.unresolved = true }",
      "if (!globalThis.unresolved) throw new Error(\"The app must not resolve @takumi-rs/core.\")",
      `const { default: docs } = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "../dist/nuxt.js")).href)})`,
      "const nuxt = await loadNuxt({ cwd: process.cwd(), ready: true, overrides: {",
      "  dev: false, devtools: { enabled: false },",
      "  modules: [[docs, { mcp: false, linkChecker: false, site: { name: \"Lumen\", url: \"https://lumen.example.com\" } }]],",
      "} })",
      "try { await build(nuxt) } finally { await nuxt.close() }",
      "",
    ].join("\n"))
    // `nuxt build` runs from the app root. pnpm gives the test process a NODE_PATH that resolves every installed
    // package, and an app has none.
    const env = { ...process.env }
    delete env.NODE_PATH
    await promisify(execFile)(process.execPath, [script], { cwd: root, env, maxBuffer: 64 * 1024 * 1024 })

    const imagesDir = join(root, ".output/public/_og/s")
    const images = existsSync(imagesDir) ? await readdir(imagesDir) : []
    expect(images.some(file => file.endsWith(".png"))).toBe(true)
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}, 240_000)
