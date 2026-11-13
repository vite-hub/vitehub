import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

import { nitro } from "nitro/vite"
import { defineConfig } from "vite"
import { detectHost, vitehub } from "vite-hub"
import { env } from "vite-hub/env"

// The Console is a ViteHub app: Auth signs people in, and the Database keeps the linked projects. The host comes from
// VITEHUB_HOST or the build variables of the host, and is `node` without them.
const host = detectHost() ?? "node"

// The Console page is the Console client of vite-hub in `account` mode. Build it first with
// `pnpm --filter vite-hub build:console-account`.
const page = resolve(import.meta.dirname, "../vite-hub/.vitehub/console-account")
const pageModule = "#console-page"

function database() {
  // A VPS keeps SQLite in the data folder and applies new migrations when the server starts.
  if (host === "node") return { migrateOnStart: true }
  // Vercel has no local disk. The Console keeps its data in hosted libSQL, such as Turso from the Vercel Marketplace.
  if (host === "vercel") {
    return {
      connection: {
        url: env({ source: env.source("TURSO_DATABASE_URL") }),
        authToken: env({ secret: true, source: env.source("TURSO_AUTH_TOKEN") }),
      },
    }
  }
  // Cloudflare uses the D1 binding of server/databases/default.ts.
  return true
}

export default defineConfig({
  plugins: [
    vitehub({
      auth: true,
      database: database(),
      // Comments on the Console's own pages, for the people in VITEHUB_CONSOLE_COMMENTERS (server/comments.ts). With
      // `console: true`, a Console can link this one as an app, with signed calls, to triage them.
      comments: true,
      console: true,
      // The ViteHub MCP. /mcp serves the docs tools to anyone. /mcp/account adds the tools of the person's team, after
      // OAuth sign-in with the Console account (mcpOAuth() in server/auth.ts).
      mcp: { publicRoute: "/mcp", route: "/mcp/account" },
      env: {
        server: {
          auth: {
            // Without a GitHub OAuth app, people sign up with a passkey only.
            github: {
              clientId: env({ optional: true, source: env.source("GITHUB_CLIENT_ID") }),
              clientSecret: env({ optional: true, secret: true, source: env.source("GITHUB_CLIENT_SECRET") }),
            },
          },
        },
      },
      host: host,
      ...(host === "node" ? { dataDir: process.env.VITEHUB_DATA_DIR ?? ".data" } : {}),
    }),
    {
      // The server answers Console routes such as /kv with this page. Its asset names change with each build.
      name: "vitehub-console-page",
      resolveId: id => id === pageModule ? `\0${pageModule}` : undefined,
      load(id) {
        if (id !== `\0${pageModule}`) return undefined
        const html = resolve(page, "index.html")
        if (existsSync(html)) return `export default ${JSON.stringify(readFileSync(html, "utf8"))}`
        // Tests and type checks build the server without the page. A deploy builds the page first.
        this.warn(`The Console page is missing at ${html}, so the app serves a placeholder. Run \`pnpm --filter vite-hub build:console-account\` first.`)
        return `export default ${JSON.stringify("<!doctype html><title>ViteHub Console</title><p>Build the Console page with <code>pnpm --filter vite-hub build:console-account</code>.</p>")}`
      },
    },
    // File names in assets/ carry a content hash, so they never change.
    nitro({ publicAssets: [{ baseURL: "/assets", dir: resolve(page, "assets"), maxAge: 31_536_000 }] }),
  ],
})
