import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"

import { afterEach, describe, expect, it } from "vitest"

const tempDirs: string[] = []

async function createTempDir() {
  const dir = await mkdtemp(join(tmpdir(), "vitehub-internal-esbuild-"))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe("bundleEsmEntry", () => {
  it("keeps CommonJS globals available in Node ESM bundles", async () => {
    const rootDir = await createTempDir()
    const entry = join(rootDir, "entry.mjs")
    const outfile = join(rootDir, "bundle.mjs")
    await writeFile(entry, "export default () => ({ dirname: __dirname, filename: __filename, requireType: typeof require })\n", "utf8")

    const { bundleEsmEntry } = await import("../src/build/esbuild.ts")
    await bundleEsmEntry(entry, outfile, { format: "esm", platform: "node" })

    await expect(readFile(outfile, "utf8")).resolves.toContain("globalThis.__filename = __vitehubFileURLToPath(import.meta.url);")
    const loaded = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`) as { default: () => { dirname: string, filename: string, requireType: string } }
    expect(loaded.default()).toEqual({
      dirname: dirname(outfile),
      filename: outfile,
      requireType: "function",
    })
  })

  it("does not redeclare Netlify runtime filename globals", async () => {
    const rootDir = await createTempDir()
    const entry = join(rootDir, "entry.mjs")
    const outfile = join(rootDir, "bundle.mjs")
    await writeFile(entry, "export default () => ({ filename: __filename, requireType: typeof require })\n", "utf8")

    const { bundleEsmEntry } = await import("../src/build/esbuild.ts")
    await bundleEsmEntry(entry, outfile, { format: "esm", minifyIdentifiers: true, platform: "node" })

    const bundled = await readFile(outfile, "utf8")
    expect(bundled).not.toContain("var __filename")
    expect(bundled).not.toContain("const __filename")
    await writeFile(outfile, `${bundled}\nconst __filename = "netlify-runtime";\n`, "utf8")

    const loaded = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`) as { default: () => { filename: string, requireType: string } }
    expect(loaded.default()).toEqual({
      filename: "netlify-runtime",
      requireType: "function",
    })
  })

  it("resolves package entry fields in neutral bundles", async () => {
    const rootDir = await createTempDir()
    const packageDir = join(rootDir, "node_modules", "main-only-package")
    const entry = join(rootDir, "entry.mjs")
    const outfile = join(rootDir, "bundle.mjs")
    await mkdir(packageDir, { recursive: true })
    await writeFile(join(packageDir, "package.json"), JSON.stringify({ main: "index.js", name: "main-only-package", type: "module" }), "utf8")
    await writeFile(join(packageDir, "index.js"), "export const value = 'neutral-main'\n", "utf8")
    await writeFile(entry, "import { value } from 'main-only-package'\nexport default value\n", "utf8")

    const { bundleEsmEntry } = await import("../src/build/esbuild.ts")
    await bundleEsmEntry(entry, outfile, { format: "esm", platform: "neutral" })

    const loaded = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`) as { default: string }
    expect(loaded.default).toBe("neutral-main")
  })
})
