import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { Miniflare } from "miniflare"
import { createBuilder } from "vite"
import { describe, expect, it } from "vitest"

import { webContainerHeaders } from "@vite-hub/web-container/vite"

import { vitehub } from "../src/index.ts"
import { startBuiltServer } from "./content-preview-fixture.ts"
import { createProject } from "./support/content-cms.ts"

const files = {
  "package.json": JSON.stringify({ name: "web-container-build", private: true, type: "module" }),
  "server/routes/__vitehub_fixture_ready.ts": "export default () => 'ok'\n",
  "server/routes/docs.ts": "export default () => 'docs'\n",
  "server/routes/play/index.ts": "export default () => 'play'\n",
  "server/routes/play/editor.ts": "export default () => 'editor'\n",
}

describe("webContainer in a built Node server", () => {
  it("sends the isolation headers on the WebContainer routes only", async () => {
    const root = await createProject(files)
    const { nitro } = (await import("nitro/vite" as string)) as { nitro: () => unknown }
    const builder = await createBuilder({ cacheDir: `${root}.vite-cache`, logLevel: "silent", plugins: [vitehub({ host: "node", webContainer: { routes: ["/play/**"] } }), nitro()], root } as never)
    await builder.buildApp()
    const server = await startBuiltServer(root, {})
    const isolation = async (path: string) => {
      const response = await server.fetch(path)
      await response.arrayBuffer()
      return Object.fromEntries(Object.keys(webContainerHeaders).map(name => [name, response.headers.get(name)]))
    }
    try {
      expect(await isolation("/play")).toEqual(webContainerHeaders)
      expect(await isolation("/play/editor")).toEqual(webContainerHeaders)
      expect(await isolation("/docs")).toEqual({ "Cross-Origin-Embedder-Policy": null, "Cross-Origin-Opener-Policy": null })
    }
    finally {
      server.close()
    }
  }, 180_000)
})

describe("webContainer in built Cloudflare assets", () => {
  it.each([
    { routes: ["/play/**", "/play/editor"], patterns: ["/play", "/play/*"], path: "/play/editor", canonical: null, docsIsolated: false },
    { routes: ["/**"], patterns: ["/*"], path: "/play/editor", canonical: null, docsIsolated: true },
    { routes: ["/play"], patterns: ["/play", "/play/"], path: "/play", canonical: "/play/", docsIsolated: false },
  ])("serves one isolation header per matching asset with $routes", async ({ routes, patterns, path, canonical, docsIsolated }) => {
    const root = await createProject({
      ...files,
      "public/play/editor.html": "<title>Editor</title>",
      "public/play/index.html": "<title>Play</title>",
      "public/docs.html": "<title>Docs</title>",
    })
    const { nitro } = (await import("nitro/vite" as string)) as { nitro: () => unknown }
    const builder = await createBuilder({ cacheDir: `${root}.vite-cache`, logLevel: "silent", plugins: [vitehub({ host: "cloudflare", webContainer: { routes } }), nitro()], root } as never)
    await builder.buildApp()
    const directory = join(root, ".output/public")
    const contents = await readFile(join(directory, "_headers"), "utf8")
    const blocks = contents.trimEnd().split(/\n(?=\S)/)
    const isolationPatterns = blocks.filter(block => block.includes("Cross-Origin-Opener-Policy:")).map(block => block.split("\n")[0])
    expect(isolationPatterns.sort()).toEqual(patterns.sort())
    expect(blocks.filter(block => block.startsWith("/*\n"))).toHaveLength(1)
    const worker = new Miniflare({
      compatibilityDate: "2026-04-20",
      modules: true,
      script: "export default { fetch: () => new Response('not an asset', { status: 404 }) }",
      assets: { directory, assetConfig: { html_handling: "auto-trailing-slash" } },
    })
    try {
      const origin = "https://example.com"
      const response = await worker.dispatchFetch(`${origin}${path}`, { redirect: "manual" })
      if (canonical) {
        expect(response.status).toBeGreaterThanOrEqual(300)
        expect(response.status).toBeLessThan(400)
        expect(new URL(response.headers.get("location")!, origin).pathname).toBe(canonical)
        await response.arrayBuffer()
      }
      const page = canonical ? await worker.dispatchFetch(`${origin}${canonical}`) : response
      const docs = await worker.dispatchFetch(`${origin}/docs`)
      expect([page.status, docs.status]).toEqual([200, 200])
      await Promise.all([page.arrayBuffer(), docs.arrayBuffer()])
      for (const [name, value] of Object.entries(webContainerHeaders)) {
        expect(page.headers.get(name)).toBe(value)
        expect(docs.headers.get(name)).toBe(docsIsolated ? value : null)
      }
      expect(page.headers.get("x-content-type-options")).toBe("nosniff")
    }
    finally {
      await worker.dispose()
    }
  }, 180_000)
})
