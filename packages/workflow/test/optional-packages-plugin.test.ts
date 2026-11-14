import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { build } from "esbuild"
import { afterEach, describe, expect, it } from "vitest"

import { createOptionalPackagesPlugin } from "../src/internal/vite-build.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function writePackage(rootDir: string, name: string, source: string): Promise<void> {
  const directory = join(rootDir, "node_modules", name)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, "package.json"), JSON.stringify({ name, type: "module", exports: { ".": { import: "./index.js", default: "./index.js" } } }))
  await writeFile(join(directory, "index.js"), source)
}

/** Bundles an entry that loads `@vite-hub/kv` lazily from a package, as `@vite-hub/agent` does, and imports it. */
async function bundleAgentLikeEntry(rootDir: string): Promise<{ loadKV: () => Promise<{ kv: string }> }> {
  await writePackage(rootDir, "agent-like", `export const loadKV = () => import("@vite-hub/kv")\n`)
  await writeFile(join(rootDir, "entry.js"), `export { loadKV } from "agent-like"\n`)
  const outfile = join(rootDir, "worker.mjs")
  await build({
    absWorkingDir: rootDir,
    bundle: true,
    entryPoints: [join(rootDir, "entry.js")],
    format: "esm",
    logLevel: "silent",
    outfile,
    platform: "neutral",
    plugins: [createOptionalPackagesPlugin(rootDir)],
  })
  return await import(pathToFileURL(outfile).href) as { loadKV: () => Promise<{ kv: string }> }
}

describe("optional packages in Workflow bundles", () => {
  it("bundles a lazy @vite-hub/kv import that the app did not install, and fails only when it runs", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-workflow-optional-kv-"))
    roots.push(rootDir)

    const { loadKV } = await bundleAgentLikeEntry(rootDir)

    await expect(loadKV()).rejects.toMatchObject({ code: "ERR_MODULE_NOT_FOUND", message: expect.stringContaining("@vite-hub/kv") })
  })

  it("bundles @vite-hub/kv when the app installed it", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-workflow-installed-kv-"))
    roots.push(rootDir)
    await writePackage(rootDir, "@vite-hub/kv", `export const kv = "installed"\n`)

    const { loadKV } = await bundleAgentLikeEntry(rootDir)

    await expect(loadKV()).resolves.toMatchObject({ kv: "installed" })
  })
})
