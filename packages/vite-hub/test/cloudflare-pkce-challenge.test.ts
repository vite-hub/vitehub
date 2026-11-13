import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { Miniflare } from "miniflare"
import { createBuilder } from "vite"
import { expect, it } from "vitest"

import { vitehub } from "vite-hub"

// The released pkce-challenge exports, without the `workerd` target that this repository patches in.
const pkceChallengeManifest = {
  name: "pkce-challenge",
  version: "5.0.1",
  type: "module",
  exports: {
    ".": {
      browser: { default: "./dist/index.browser.js" },
      node: { import: "./dist/index.node.js", require: "./dist/index.node.cjs" },
    },
  },
}

it("builds a Cloudflare Worker that imports pkce-challenge, as the MCP SDK client does", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-pkce-cloudflare-"))
  try {
    await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir")
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }))
    const pkce = join(root, "mcp-client/node_modules/pkce-challenge")
    await mkdir(join(pkce, "dist"), { recursive: true })
    await writeFile(join(pkce, "package.json"), JSON.stringify(pkceChallengeManifest))
    await writeFile(join(pkce, "dist/index.browser.js"), "export default async () => ({ build: 'browser', subtle: typeof crypto.subtle.digest })\n")
    await writeFile(join(pkce, "dist/index.node.js"), "export default async () => ({ build: 'node' })\n")
    await writeFile(join(pkce, "dist/index.node.cjs"), "module.exports = async () => ({ build: 'node' })\n")
    await writeFile(join(root, "mcp-client/index.js"), "export { default as pkceChallenge } from 'pkce-challenge'\n")
    await mkdir(join(root, "server/api"), { recursive: true })
    await writeFile(join(root, "server/api/pkce.get.ts"), `
      import { defineEventHandler } from "h3"
      import { pkceChallenge } from "../../mcp-client/index.js"
      export default defineEventHandler(() => pkceChallenge())
    `)
    const builder = await createBuilder({ logLevel: "silent", plugins: [vitehub({ host: "cloudflare" })], root })
    await builder.buildApp()

    const server = join(root, ".output/server")
    const files = await readdir(server, { recursive: true })
    const worker = new Miniflare({
      compatibilityDate: "2026-04-20",
      compatibilityFlags: ["nodejs_compat"],
      modules: ["index.mjs", ...files.filter(file => file.endsWith(".mjs") && file !== "index.mjs")].map(file => ({ path: join(server, file), type: "ESModule" as const })),
      modulesRoot: server,
    })
    try {
      const response = await worker.dispatchFetch("http://localhost/api/pkce")
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ build: "browser", subtle: "function" })
    }
    finally {
      await worker.dispose()
    }
  }
  finally {
    await rm(root, { force: true, recursive: true, maxRetries: 3 })
  }
}, 300_000)
