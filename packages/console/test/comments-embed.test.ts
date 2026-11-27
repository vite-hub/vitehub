import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { describe, expect, it } from "vitest"

import { serveHostedComments } from "../src/assets.ts"
import { readConsoleAssets } from "../src/assets-build.ts"
import { commentsEmbedFrameScript, serveCommentsEmbed } from "../src/comments-embed.ts"

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

  it("serves the embed scripts to any site, with a short cache for their stable names", async () => {
    const assets = readConsoleAssets()
    expect(Object.keys(assets.hostedComments)).toEqual(["hosted-comments.js", "hosted-comments/frame.js", "hosted-comments/tools.js"])
    for (const path of ["/hosted-comments.js", "/hosted-comments/frame.js", "/hosted-comments/tools.js"]) {
      const response = serveHostedComments(get(path), assets)
      expect(response.status, path).toBe(200)
      expect(response.headers.get("access-control-allow-origin")).toBe("*")
      expect(response.headers.get("cross-origin-resource-policy")).toBe("cross-origin")
      expect(response.headers.get("cache-control")).toBe("public, max-age=300")
    }
    expect(serveHostedComments(get("/hosted-comments/missing.js"), assets).status).toBe(404)
    expect(serveHostedComments(get("/hosted-comments.js", "POST"), assets).status).toBe(405)
  })
})
