import { migrate } from "drizzle-orm/libsql/migrator"
import { definePlugin } from "nitro"
import { db } from "vite-hub/database/drizzle"

// Included only on Node hosts and in `nuxt dev`, where ViteHub's database is a local libsql file. Keep
// server/databases/migrations beside .output when copying a Node build. Cloudflare applies migrations with wrangler.
// SAFETY: only those builds include this plugin, and there `db` is a libsql Drizzle database.
await migrate(db as Parameters<typeof migrate>[0], { migrationsFolder: "server/databases/migrations" })

export default definePlugin(() => {})
