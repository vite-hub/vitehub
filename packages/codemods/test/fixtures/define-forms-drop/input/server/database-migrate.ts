import { migrate } from "drizzle-orm/libsql/migrator"
import { definePlugin } from "nitro"
import { db } from "vite-hub/database/drizzle"

// Included only in local SQLite builds. Keep this directory beside .output when copying a Node build.
// Nitro invokes plugins synchronously, so await here to finish migrations before opening the server.
// SAFETY: only local SQLite builds include this plugin, and there ViteHub's db is a libsql Drizzle database.
await migrate(db as Parameters<typeof migrate>[0], { migrationsFolder: "server/databases/migrations" })

export default definePlugin(() => {})
