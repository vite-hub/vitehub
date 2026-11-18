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

async function writePackage(rootDir: string, name: string, source: string, metadata: Record<string, unknown> = {}): Promise<void> {
  const directory = join(rootDir, "node_modules", name)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, "package.json"), JSON.stringify({ name, type: "module", exports: { ".": { import: "./index.js", default: "./index.js" } }, ...metadata }))
  await writeFile(join(directory, "index.js"), source)
}

async function bundleEntry(rootDir: string, source: string): Promise<string> {
  await writeFile(join(rootDir, "entry.js"), source)
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
  return outfile
}

/** A package that loads an optional peer on first use, as `@vite-hub/source/mcp` loads `@modelcontextprotocol/sdk`. */
async function writeOptionalPeerLoader(rootDir: string): Promise<void> {
  await writePackage(rootDir, "source-like", `export const loadClient = () => import("mcp-sdk-like/client/index.js")\n`, {
    peerDependencies: { "mcp-sdk-like": "^1.0.0" },
    peerDependenciesMeta: { "mcp-sdk-like": { optional: true } },
  })
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

  it("bundles a lazy optional peer import that the app did not install, and fails only when it runs", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-workflow-optional-peer-"))
    roots.push(rootDir)
    await writeOptionalPeerLoader(rootDir)

    const outfile = await bundleEntry(rootDir, `export { loadClient } from "source-like"\n`)
    const { loadClient } = await import(pathToFileURL(outfile).href) as { loadClient: () => Promise<unknown> }

    await expect(loadClient()).rejects.toMatchObject({ code: "ERR_MODULE_NOT_FOUND", message: expect.stringContaining("mcp-sdk-like/client/index.js") })
  })

  it("bundles a lazy optional peer import when the app installed the peer", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-workflow-installed-peer-"))
    roots.push(rootDir)
    await writeOptionalPeerLoader(rootDir)
    const peerDirectory = join(rootDir, "node_modules", "mcp-sdk-like")
    await mkdir(join(peerDirectory, "client"), { recursive: true })
    await writeFile(join(peerDirectory, "package.json"), JSON.stringify({ name: "mcp-sdk-like", type: "module", exports: { "./client/index.js": "./client/index.js" } }))
    await writeFile(join(peerDirectory, "client", "index.js"), `export const client = "installed"\n`)

    const outfile = await bundleEntry(rootDir, `export { loadClient } from "source-like"\n`)
    const { loadClient } = await import(pathToFileURL(outfile).href) as { loadClient: () => Promise<{ client: string }> }

    await expect(loadClient()).resolves.toMatchObject({ client: "installed" })
  })

  it("still fails the build for a missing package that is not an optional peer", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-workflow-missing-package-"))
    roots.push(rootDir)

    await expect(bundleEntry(rootDir, `export const load = () => import("not-installed")\n`)).rejects.toThrow(/Could not resolve "not-installed"/)
  })

  it("bundles @vite-hub/kv when the app installed it", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-workflow-installed-kv-"))
    roots.push(rootDir)
    await writePackage(rootDir, "@vite-hub/kv", `export const kv = "installed"\n`)

    const { loadKV } = await bundleAgentLikeEntry(rootDir)

    await expect(loadKV()).resolves.toMatchObject({ kv: "installed" })
  })
})
