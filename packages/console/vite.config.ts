import { nitro } from "nitro/vite"
import { defineConfig } from "vite"
import { vitehub } from "vite-hub"
import { detectPreset } from "vite-hub/deployment"
import { env } from "vite-hub/env"

// The Console is a ViteHub app: Auth signs people in, and the Database keeps the linked projects. The host comes from
// VITEHUB_HOSTING or the build variables of the host, and is `node` without them.
const host = detectPreset() ?? "node"

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
      preset: host,
      ...(host === "node" ? { dataDir: process.env.VITEHUB_DATA_DIR ?? ".data" } : {}),
    }),
    nitro(),
  ],
})
