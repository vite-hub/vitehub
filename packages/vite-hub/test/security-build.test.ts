import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { createBuilder } from "vite"
import { describe, expect, it } from "vitest"

import { vitehub } from "../src/index.ts"
import { startBuiltServer } from "./content-preview-fixture.ts"
import { createProject } from "./support/content-cms.ts"

import type { ViteHubOptions } from "../src/index.ts"

const routes = {
  "server/routes/__vitehub_fixture_ready.ts": "export default () => 'ok'\n",
  "server/routes/api/page.ts": "export default () => ({ ok: true })\n",
  // A route that sets a stricter value than the default keeps it.
  "server/routes/embed.ts": "export default () => new Response('embed', { headers: { 'x-frame-options': 'DENY' } })\n",
  "server/routes/api/notes.post.ts": "import { defineHandler, readBody } from 'h3'\nexport default defineHandler(async event => ({ size: String(await readBody(event, { type: 'text' })).length }))\n",
  "public/robots.txt": "User-agent: *\n",
}

async function build(options: ViteHubOptions, files: Record<string, string> = {}, nitro: Record<string, unknown> = {}): Promise<string> {
  const root = await createProject({ "package.json": JSON.stringify({ name: "security-build", private: true, type: "module" }), ...routes, ...files })
  const { nitro: nitroPlugin } = (await import("nitro/vite" as string)) as { nitro: () => unknown }
  const builder = await createBuilder({ cacheDir: `${root}.vite-cache`, logLevel: "silent", plugins: [vitehub(options), nitroPlugin()], root, nitro } as never)
  await builder.buildApp()
  return root
}

function chunks(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  let offset = 0
  return new ReadableStream({ pull: controller => offset >= bytes.byteLength ? controller.close() : controller.enqueue(bytes.slice(offset, offset += 256)) })
}

describe("security in a built Node server", () => {
  it("adds the headers to routes, errors, and static files, and caps request bodies", async () => {
    const root = await build({ host: "node", sameOriginWrites: true, security: { headers: { "X-Frame-Options": "SAMEORIGIN", "X-Robots-Tag": "noindex" }, maxBodySize: "1kb" } })
    const server = await startBuiltServer(root, {})
    try {
      const page = await server.fetch("/api/page")
      expect(Object.fromEntries([...page.headers].filter(([name]) => name !== "content-type" && name !== "content-length" && name !== "date" && name !== "connection" && name !== "keep-alive"))).toEqual({
        "referrer-policy": "strict-origin-when-cross-origin",
        "strict-transport-security": "max-age=31536000",
        "x-content-type-options": "nosniff",
        "x-frame-options": "SAMEORIGIN",
        "x-robots-tag": "noindex",
      })
      expect((await server.fetch("/embed")).headers.get("x-frame-options")).toBe("DENY")
      expect((await server.fetch("/robots.txt")).headers.get("x-content-type-options")).toBe("nosniff")
      expect((await server.fetch("/missing")).headers.get("x-frame-options")).toBe("SAMEORIGIN")

      const small = await server.fetch("/api/notes", { method: "POST", body: "a".repeat(1024) })
      expect(await small.json()).toEqual({ size: 1024 })
      const large = await server.fetch("/api/notes", { method: "POST", body: "a".repeat(1025) })
      expect(large.status).toBe(413)
      expect(large.headers.get("x-content-type-options")).toBe("nosniff")
      expect(await large.json()).toMatchObject({ data: { code: "VITE_HUB_REQUEST_BODY_TOO_LARGE" } })
      const streamed = await server.fetch("/api/notes", { method: "POST", body: chunks("a".repeat(4096)), duplex: "half" } as RequestInit)
      expect(streamed.status).toBe(413)

      // `security` wraps the request policy, so its 403 also carries the headers.
      const foreign = await server.fetch("/api/notes", { method: "POST", body: "a", headers: { cookie: "session=1", origin: "https://evil.test" } })
      expect(foreign.status).toBe(403)
      expect(foreign.headers.get("x-robots-tag")).toBe("noindex")
    }
    finally {
      server.close()
    }
  }, 180_000)

  it("sends the default headers and no body limit when security is unset", async () => {
    const root = await build({ host: "node" })
    const server = await startBuiltServer(root, {})
    try {
      const page = await server.fetch("/api/page")
      expect(page.headers.get("strict-transport-security")).toBe("max-age=31536000")
      expect(page.headers.get("x-content-type-options")).toBe("nosniff")
      expect(page.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin")
      expect(page.headers.has("x-frame-options")).toBe(false)
      expect(page.headers.has("permissions-policy")).toBe(false)
      expect((await server.fetch("/embed")).headers.get("x-frame-options")).toBe("DENY")
      expect((await server.fetch("/api/notes", { method: "POST", body: "a".repeat(4096) })).status).toBe(200)
    }
    finally {
      server.close()
    }
  }, 180_000)

  it("sends no headers with headers: false", async () => {
    const root = await build({ host: "node", security: { headers: false } })
    const server = await startBuiltServer(root, {})
    try {
      const page = await server.fetch("/api/page")
      expect(page.headers.has("strict-transport-security")).toBe(false)
      expect(page.headers.has("x-content-type-options")).toBe(false)
    }
    finally {
      server.close()
    }
  }, 180_000)
})

describe("security headers for static files on hosts that serve them without the server", () => {
  it("adds the default rule to the Cloudflare _headers file, after the route rules", async () => {
    const root = await build({ host: "cloudflare" }, {}, { routeRules: { "/embed/**": { headers: { "Referrer-Policy": "no-referrer" } } } })
    expect(await readFile(join(root, ".output/public/_headers"), "utf8")).toBe([
      "/embed/*",
      "  Referrer-Policy: no-referrer",
      "/*",
      "  Strict-Transport-Security: max-age=31536000",
      "  X-Content-Type-Options: nosniff",
      "",
    ].join("\n"))
  }, 180_000)

  it("adds a hit-phase route to the Vercel Build Output config", async () => {
    const root = await build({ host: "vercel", security: { headers: { "Permissions-Policy": "camera=()", "Referrer-Policy": false } } })
    const config = JSON.parse(await readFile(join(root, ".vercel/output/config.json"), "utf8")) as { routes: Array<Record<string, unknown>> }
    const hit = config.routes.findIndex(route => route.handle === "hit")
    expect(hit).toBeGreaterThan(config.routes.findIndex(route => route.handle === "filesystem"))
    expect(config.routes[hit + 1]).toEqual({
      src: "/(.*)",
      continue: true,
      headers: {
        "Strict-Transport-Security": "max-age=31536000",
        "X-Content-Type-Options": "nosniff",
        "Permissions-Policy": "camera=()",
      },
    })
  }, 180_000)
})
