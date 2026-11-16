import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

import { Miniflare } from "miniflare"
import { createBuilder } from "vite"
import { describe, expect, it } from "vitest"

import { vitehub } from "../src/index.ts"
import { startBuiltServer } from "./content-preview-fixture.ts"
import { createProject } from "./support/content-cms.ts"

import type { ViteHubOptions } from "../src/index.ts"

const files = {
  "package.json": JSON.stringify({ name: "redirects-build", private: true, type: "module" }),
  "server/routes/__vitehub_fixture_ready.ts": "export default () => 'ok'\n",
  "server/routes/docs.ts": "export default () => 'docs'\n",
  "server/routes/api/notes.post.ts": "export default () => ({ ok: true })\n",
  "public/robots.txt": "User-agent: *\n",
}

async function build(options: ViteHubOptions): Promise<string> {
  const root = await createProject(files)
  const { nitro } = (await import("nitro/vite" as string)) as { nitro: () => unknown }
  const builder = await createBuilder({ cacheDir: `${root}.vite-cache`, logLevel: "silent", plugins: [vitehub(options), nitro()], root } as never)
  await builder.buildApp()
  return root
}

const where = (response: Response) => [response.status, response.headers.get("location")]

describe("redirects in a built Node server", () => {
  it("redirects routes and static files to the canonical address, and keeps local requests", async () => {
    const root = await build({ host: "node", redirects: { host: "example.com", https: true, trailingSlash: "remove" } })
    const server = await startBuiltServer(root, {})
    const proxy = (host: string, proto = "https") => ({ redirect: "manual" as const, headers: { "x-forwarded-host": host, "x-forwarded-proto": proto } })
    try {
      expect(where(await server.fetch("/docs/?tab=api", proxy("www.example.com", "http")))).toEqual([301, "https://example.com/docs?tab=api"])
      expect(where(await server.fetch("/robots.txt", proxy("www.example.com")))).toEqual([301, "https://example.com/robots.txt"])
      expect(where(await server.fetch("/api/notes", { ...proxy("www.example.com"), method: "POST" }))).toEqual([308, "https://example.com/api/notes"])
      expect(await (await server.fetch("/docs", proxy("example.com"))).text()).toBe("docs")
      expect(await (await server.fetch("/docs", proxy("shop.acme.workers.dev", "http"))).text()).toBe("docs")
      // 127.0.0.1 keeps its host and scheme, and the path still becomes canonical.
      expect(await (await server.fetch("/docs", { redirect: "manual" })).text()).toBe("docs")
      expect(where(await server.fetch("/docs/", { redirect: "manual" }))).toEqual([301, `http://127.0.0.1:${server.port}/docs`])
    }
    finally {
      server.close()
    }
  }, 180_000)

  it("generates nothing without redirects", async () => {
    const root = await build({ host: "node" })
    expect(await readdir(join(root, ".vitehub/nitro")).catch(() => [])).not.toContain("redirects.mjs")
    const server = await startBuiltServer(root, {})
    try {
      expect((await server.fetch("/docs/", { redirect: "manual", headers: { "x-forwarded-host": "www.example.com" } })).status).toBe(200)
    }
    finally {
      server.close()
    }
  }, 180_000)
})

describe("redirects on Cloudflare", () => {
  it("runs the Worker before static files and redirects them before they are served", async () => {
    const root = await build({ host: "cloudflare", redirects: { host: "example.com", https: true, trailingSlash: "remove" } })
    const server = join(root, ".output/server")
    const wrangler = JSON.parse(await readFile(join(server, "wrangler.json"), "utf8")) as { assets: Record<string, unknown>, compatibility_flags?: string[] }
    expect(wrangler.assets).toMatchObject({ binding: "ASSETS", run_worker_first: ["/*"], html_handling: "drop-trailing-slash" })

    const modules = (await readdir(server, { recursive: true })).filter(file => file.endsWith(".mjs"))
    const worker = new Miniflare({
      // The build writes today's date. The pinned workerd binary can be older.
      compatibilityDate: "2026-04-20",
      compatibilityFlags: [...new Set([...wrangler.compatibility_flags ?? [], "nodejs_compat"])],
      modules: ["index.mjs", ...modules.filter(file => file !== "index.mjs")].map(file => ({ path: join(server, file), type: "ESModule" as const })),
      modulesRoot: server,
      // The asset layer behind `run_worker_first`: the Worker asks it for each file.
      serviceBindings: { ASSETS: (request: { url: string }) => new URL(request.url).pathname === "/robots.txt" ? new Response("User-agent: *\n") : new Response("Not Found", { status: 404 }) },
    })
    try {
      const fetch = (url: string, init?: RequestInit) => worker.dispatchFetch(url, { redirect: "manual", ...init } as never) as unknown as Promise<Response>
      expect(where(await fetch("http://www.example.com/robots.txt"))).toEqual([301, "https://example.com/robots.txt"])
      expect(where(await fetch("https://example.com/docs/"))).toEqual([301, "https://example.com/docs"])
      expect(await (await fetch("https://example.com/robots.txt")).text()).toBe("User-agent: *\n")
      expect(await (await fetch("https://example.com/docs")).text()).toBe("docs")
      expect(await (await fetch("https://redirects-build.acme.workers.dev/docs")).text()).toBe("docs")
    }
    finally {
      await worker.dispose()
    }
  }, 300_000)
})
