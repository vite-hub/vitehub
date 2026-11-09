import { mkdtemp, readdir, readFile, rm, symlink, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { createBuilder } from "vite"
import { describe, expect, it } from "vitest"

import { vitehub } from "vite-hub"

import { consoleAssetBases, pruneConsoleAssetManifest } from "../src/console/nitro.ts"

async function buildConsoleApp(preset: "cloudflare" | "node"): Promise<{ entry: string, files: string[], root: string }> {
  const root = await mkdtemp(join(tmpdir(), `vitehub-console-manifest-${preset}-`))
  await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir")
  await writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }))
  await mkdir(join(root, "server/routes"), { recursive: true })
  await writeFile(join(root, "server/routes/hello.ts"), "export default () => \"hello\"\n")
  const builder = await createBuilder({ logLevel: "silent", plugins: [vitehub({ console: { auth: "token" }, preset })], root })
  await builder.buildApp()
  const files = await readdir(join(root, ".output/public/_vitehub/assets"), { recursive: true })
  return { entry: await readFile(join(root, ".output/server/index.mjs"), "utf8"), files, root }
}

describe("Console files in Nitro's public asset manifest", () => {
  it("leaves them out of a Cloudflare server entry and keeps the asset base that matches them", async () => {
    const { entry, files, root } = await buildConsoleApp("cloudflare")
    try {
      expect(files.length).toBeGreaterThan(100)
      // A manifest entry names the file it describes.
      expect(entry).not.toContain("\"path\": \"../public/_vitehub/assets/")
      expect(entry).toContain("\"/_vitehub/assets/\": { \"maxAge\": 31536e3 }")
    }
    finally {
      await rm(root, { force: true, recursive: true, maxRetries: 3 })
    }
  }, 120_000)

  it("keeps them on Node, where Nitro serves each file from its manifest entry", async () => {
    const { entry, root } = await buildConsoleApp("node")
    try {
      expect(entry).toContain("\"path\": \"../public/_vitehub/assets/")
    }
    finally {
      await rm(root, { force: true, recursive: true, maxRetries: 3 })
    }
  }, 120_000)
})

describe("pruneConsoleAssetManifest", () => {
  const manifest = `export default ${JSON.stringify({
    "/app/_vitehub/assets/app-1.js": { type: "text/javascript" },
    "/app/_vitehub/page/assets/loader.js": { type: "text/javascript" },
    "/app/_vitehub/rpc.json": { type: "application/json" },
    "/app/favicon.ico": { type: "image/x-icon" },
    "/app/docs/a.html": { type: "text/html" },
  }, null, 2)};`

  it("removes only the files below a /_vitehub/ asset base that has no fallthrough", () => {
    const bases = consoleAssetBases("/app/", [
      { baseURL: "/_vitehub/assets", fallthrough: false },
      { baseURL: "/_vitehub/page/assets" },
      { baseURL: "/_vitehub", fallthrough: true },
      { baseURL: "/docs", fallthrough: false },
      {},
    ])
    expect(bases).toEqual(["/app/_vitehub/assets/", "/app/_vitehub/page/assets/"])
    expect(pruneConsoleAssetManifest(manifest, bases)).toBe(`export default ${JSON.stringify({
      "/app/_vitehub/rpc.json": { type: "application/json" },
      "/app/favicon.ico": { type: "image/x-icon" },
      "/app/docs/a.html": { type: "text/html" },
    }, null, 2)};`)
  })

  it("keeps a module it cannot read", () => {
    expect(pruneConsoleAssetManifest("export const assets = {}", ["/_vitehub/assets/"])).toBeUndefined()
    expect(pruneConsoleAssetManifest(manifest, [])).toBeUndefined()
  })
})
