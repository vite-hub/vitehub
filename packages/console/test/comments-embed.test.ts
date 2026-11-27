import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { describe, expect, it } from "vitest"

import { serveHostedComments } from "../src/assets.ts"
import { readConsoleAssets } from "../src/assets-build.ts"
import { commentsEmbedFrameScript, serveCommentsEmbed, serveCommentsProject } from "../src/comments-embed.ts"

const table = "CREATE TABLE `console_projects` (`id` text PRIMARY KEY NOT NULL, `team_id` text NOT NULL, `url` text NOT NULL, `label` text, `key_sealed` text NOT NULL, `public_key` text NOT NULL, `created_by` text NOT NULL, `created_at` integer NOT NULL, UNIQUE (`team_id`, `url`))"
const get = (path: string, method = "GET") => new Request(`https://console.example.com${path}`, { method })

async function database() {
  const client = createClient({ url: ":memory:" })
  await client.execute(table)
  await client.execute({ sql: "INSERT INTO console_projects VALUES (?, 'team', ?, NULL, 'sealed', 'key', 'user', 0)", args: ["p-1", "https://docs.example.com/guide/?a=1"] })
  return drizzle({ client })
}

describe("the hosted Comments embed", () => {
  it("lets only the origin of the registered project URL embed the frame", async () => {
    const response = await serveCommentsEmbed(get("/comments/p-1/embed"), await database())
    expect(response.status).toBe(200)
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors https://docs.example.com")
    expect(response.headers.get("cross-origin-embedder-policy")).toBe("require-corp")
    expect(response.headers.get("cross-origin-resource-policy")).toBe("cross-origin")
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("set-cookie")).toBeNull()
    const html = await response.text()
    expect(html).toContain("data-origin=\"https://docs.example.com\"")
    expect(html).toContain("data-project=\"p-1\"")
    expect(html).toContain(`src="${commentsEmbedFrameScript}"`)
    expect(html).not.toMatch(/token|secret|sealed|key/i)
  })

  it("refuses unknown projects and other methods", async () => {
    const db = await database()
    for (const path of ["/comments/p-2/embed", "/comments/%E0%A4%A/embed", "/comments//embed"]) {
      const response = await serveCommentsEmbed(get(path), db)
      expect(response.status, path).toBe(404)
      expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'")
    }
    expect((await serveCommentsEmbed(get("/comments/p-1/embed", "POST"), db)).status).toBe(405)
  })

  it("serves the embed scripts to any site, with a short cache for the stable names", async () => {
    const assets = readConsoleAssets()
    expect(Object.keys(assets.hostedComments)).toEqual(expect.arrayContaining(["hosted-comments.js", "hosted-comments/frame.js"]))
    for (const path of ["/hosted-comments.js", "/hosted-comments/frame.js"]) {
      const response = serveHostedComments(get(path), assets)
      expect(response.status, path).toBe(200)
      expect(response.headers.get("access-control-allow-origin")).toBe("*")
      expect(response.headers.get("cross-origin-resource-policy")).toBe("cross-origin")
      expect(response.headers.get("cache-control")).toBe("public, max-age=300")
    }
    const chunk = Object.keys(assets.hostedComments).find(path => path.startsWith("hosted-comments/") && path !== "hosted-comments/frame.js")
    expect(chunk).toBeDefined()
    expect(serveHostedComments(get(`/${chunk}`), assets).headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
    expect(serveHostedComments(get("/hosted-comments/missing.js"), assets).status).toBe(404)
    expect(serveHostedComments(get("/hosted-comments.js", "POST"), assets).status).toBe(405)
  })
})

describe("the project of a Console key", () => {
  const publicKey = "k".repeat(43)
  const ask = (keys: string[], origin?: string, method = "GET", base = "") => new Request(`https://console.example.com/comments/project?base=${encodeURIComponent(base)}&${keys.map(key => `key=${key}`).join("&")}`, { method, headers: origin ? { origin } : {} })

  async function keyed() {
    const client = createClient({ url: ":memory:" })
    await client.execute(table)
    await client.execute("CREATE TABLE organization (id text PRIMARY KEY, name text NOT NULL)")
    await client.execute("INSERT INTO organization VALUES ('team', 'Cocina'), ('other', 'Recipe editors')")
    await client.execute({ sql: "INSERT INTO console_projects VALUES (?, 'team', ?, NULL, 'sealed', ?, 'user', 0)", args: ["p-cocina", "https://cocina.example.com", publicKey] })
    await client.execute({ sql: "INSERT INTO console_projects VALUES (?, 'team', ?, NULL, 'sealed', ?, 'user', 0)", args: ["p-shop", "https://cocina.example.com/shop", "s".repeat(43)] })
    await client.execute({ sql: "INSERT INTO console_projects VALUES (?, 'other', ?, NULL, 'sealed', ?, 'user', 0)", args: ["p-shop-other", "https://cocina.example.com/shop/", "t".repeat(43)] })
    await client.execute({ sql: "INSERT INTO console_projects VALUES (?, 'team', ?, NULL, '', '', 'user', 0)", args: ["p-unlinked", "https://cocina.example.com/old"] })
    return drizzle({ client })
  }

  it("answers the project id to the origin of the project URL", async () => {
    const response = await serveCommentsProject(ask(["x".repeat(43), publicKey], "https://cocina.example.com"), await keyed())
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ projects: [{ id: "p-cocina", team: "Cocina" }] })
    expect(response.headers.get("access-control-allow-origin")).toBe("https://cocina.example.com")
    expect(response.headers.get("vary")).toBe("origin")
    expect(response.headers.get("cache-control")).toBe("no-store")
  })

  it("matches the app mount exactly and returns both team choices for a shared mount", async () => {
    const db = await keyed()
    const origin = "https://cocina.example.com"
    const keys = [publicKey, "s".repeat(43), "t".repeat(43)]
    expect(await (await serveCommentsProject(ask(keys, origin), db)).json()).toEqual({ projects: [{ id: "p-cocina", team: "Cocina" }] })
    expect(await (await serveCommentsProject(ask(keys, origin, "GET", "/shop"), db)).json()).toEqual({ projects: [{ id: "p-shop", team: "Cocina" }, { id: "p-shop-other", team: "Recipe editors" }] })
    expect((await serveCommentsProject(ask(keys, origin, "GET", "/docs"), db)).status).toBe(404)
  })

  it("answers 404 to another origin, a request without an origin, and an unknown or malformed key", async () => {
    const db = await keyed()
    for (const request of [ask([publicKey], "https://evil.example.com"), ask([publicKey]), ask(["y".repeat(43)], "https://cocina.example.com"), ask([""], "https://cocina.example.com"), ask(["short"], "https://cocina.example.com")]) {
      const response = await serveCommentsProject(request, db)
      expect(response.status).toBe(404)
      expect(await response.json()).not.toHaveProperty("id")
    }
    expect((await serveCommentsProject(ask([publicKey], "https://cocina.example.com", "POST"), db)).status).toBe(405)
  })
})
