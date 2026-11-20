import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { nitro } from "nitro/vite"
import { defineConfig } from "vite"
import { detectHost, vitehub } from "vite-hub"
import { env } from "vite-hub/env"

const host = detectHost() ?? "node"
const dataDir = resolve(process.env.VITEHUB_DATA_DIR ?? ".data")

const page = resolve(import.meta.dirname, "../vite-hub/.vitehub/console-account")
const pageModule = "#console-page"

function database() {
  if (host === "node") return { migrateOnStart: true, connection: { url: pathToFileURL(resolve(dataDir, "database/sqlite.db")).href } }
  if (host === "vercel") {
    return {
      connection: {
        url: env({ source: env.source("TURSO_DATABASE_URL") }),
        authToken: env({ secret: true, source: env.source("TURSO_AUTH_TOKEN") }),
      },
    }
  }
  return true
}

export default defineConfig({
  plugins: [
    vitehub({
      auth: true,
      database: database(),
      comments: true,
      console: true,
      publicUrl: process.env.VITEHUB_CONSOLE_PUBLIC_URL,
      mcp: { publicRoute: "/mcp", route: "/mcp/account" },
      env: {
        server: {
          auth: {
            github: {
              clientId: env({ optional: true, source: env.source("GITHUB_CLIENT_ID") }),
              clientSecret: env({ optional: true, secret: true, source: env.source("GITHUB_CLIENT_SECRET") }),
            },
          },
        },
      },
      host: host,
      ...(host === "node" ? { dataDir } : {}),
    }),
    {
      name: "vitehub-console-page",
      resolveId: id => id === pageModule ? `\0${pageModule}` : undefined,
      load(id) {
        if (id !== `\0${pageModule}`) return undefined
        const html = resolve(page, "index.html")
        if (existsSync(html)) return `export default ${JSON.stringify(readFileSync(html, "utf8"))}`
        this.warn(`The Console page is missing at ${html}, so the app serves a placeholder. Run \`pnpm --filter vite-hub build:console-account\` first.`)
        return `export default ${JSON.stringify("<!doctype html><title>ViteHub Console</title><p>Build the Console page with <code>pnpm --filter vite-hub build:console-account</code>.</p>")}`
      },
    },
    nitro({ publicAssets: [{ baseURL: "/assets", dir: resolve(page, "assets"), maxAge: 31_536_000 }] }),
  ],
})
