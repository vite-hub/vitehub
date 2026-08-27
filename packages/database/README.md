# `@vite-hub/database`

`@vite-hub/database` discovers colocated Drizzle schemas, generates typed runtime imports, and uses local SQLite unless you configure a hosted database.

## Choose the package

| You are building | Install | Configure | Import application code from |
| --- | --- | --- | --- |
| A ViteHub application | `vite-hub` and `drizzle-orm` | `vitehub({ database: true, preset: "node" })` | `vite-hub/database` and `vite-hub/database/drizzle` |
| A library, custom Vite composition, or package-level tool | `@vite-hub/database` and `drizzle-orm` | `hubDb()` | `@vite-hub/database` and `@vite-hub/database/drizzle` |

Start new applications with `vite-hub`. It includes the ViteHub CLI and keeps deployment configuration in one `vitehub()` call. Install this owner package directly when you need its Vite integration without the rest of the framework distribution.

The example below uses the direct owner package because this is its npm README. It needs Node.js 24.15 or newer and runs without an account or provider credential.

## Run one local SQLite request

Create an ESM project and install the Database Package, Vite, H3, Drizzle ORM, the ViteHub CLI, and Drizzle Kit.

```sh
mkdir vitehub-database-start
cd vitehub-database-start
pnpm init
pnpm pkg set type=module
pnpm add @libsql/client @vite-hub/database drizzle-orm h3 vite
pnpm add -D @vite-hub/cli drizzle-kit
```

Register `hubDb()` and tell Vite to build the server entry as `dist/server.js`.

```ts
// vite.config.ts
import { resolve } from "node:path"

import { hubDb } from "@vite-hub/database/vite"
import { defineConfig } from "vite"

export default defineConfig({
  root: import.meta.dirname,
  appType: "custom",
  build: {
    outDir: "dist",
    rollupOptions: {
      input: resolve(import.meta.dirname, "src/server.ts"),
      output: { entryFileNames: "server.js" },
    },
    ssr: true,
  },
  plugins: [hubDb()],
  ssr: { external: ["@libsql/client"] },
})
```

This direct Node build leaves the native libSQL client outside the server bundle. The explicit `@libsql/client` install lets pnpm resolve it at runtime. Framework presets package their own runtime dependencies; a custom host composition must make that packaging choice itself.

Define one table in the Default Database. With no connection config, ViteHub writes its local SQLite file to `.vitehub/data/database/sqlite.db`.

```ts
// src/database.ts
import { defineDatabase } from "@vite-hub/database"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

const notes = sqliteTable("notes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
})

export default defineDatabase({
  schema: { notes },
})
```

Use the discovered name `default` in server code. The request inserts one row and returns only its title, so the response stays the same on repeated runs.

```ts
// src/server.ts
import { createServer } from "node:http"

import { useDatabase } from "@vite-hub/database/drizzle"
import { H3 } from "h3"
import { toNodeHandler } from "h3/node"

const { db, schema } = useDatabase("default")

const app = new H3().post("/notes", async () => {
  const [note] = await db
    .insert(schema.notes)
    .values({ title: "SQLite is ready" })
    .returning({ title: schema.notes.title })

  return { note }
})

const port = Number(process.env.PORT || 5173)
createServer(toNodeHandler(app)).listen(port, () => {
  console.log(`Database example listening on http://localhost:${port}`)
})
```

Generate the first migration. Create the default local data directory before the first migration, then apply it, build, and start the server.

```sh
pnpm vitehub db generate --name init
mkdir -p .vitehub/data/database
pnpm vitehub db migrate
pnpm vite build
node dist/server.js
```

From another terminal, send the request.

```sh
curl -X POST http://localhost:5173/notes
```

The response proves that the built server used the generated Drizzle import and local SQLite database:

```json
{"note":{"title":"SQLite is ready"}}
```

Stop the server with <kbd>Ctrl</kbd>+<kbd>C</kbd>. The SQLite file remains under `.vitehub/data/database`; deleting that directory deletes the local data.

## Choose Default or Named Databases

One application uses either one Default Database or a set of Named Databases. It cannot mix the two modes.

| Mode | Definition files | `name` option | Runtime lookup | Use it when |
| --- | --- | --- | --- | --- |
| Default | `src/database.ts` or `server/databases/config.ts` | Omit it | `useDatabase("default")` | One database owns the application's relational data. |
| Named | `src/<name>.database.ts` or `server/databases/<name>/config.ts` | Must match `<name>` | `useDatabase("<name>")` | The databases have separate storage or deployment lifecycles. |

For Named Databases, ViteHub creates one local SQLite file and one Drizzle config per name. The migration commands run once per discovered database and stop at the first failure. Name a database for a real data split, not for a source-code folder.

## Generate and apply migrations

`hubDb()` contributes the `db` namespace to the ViteHub CLI. Run these commands from the project root:

```sh
pnpm vitehub db generate
pnpm vitehub db generate --name add-audit-log
pnpm vitehub db generate --custom --name backfill-state
pnpm vitehub db migrate
```

`db generate` refreshes ViteHub's generated Drizzle config before it asks Drizzle Kit to create migrations. `--custom` creates an empty migration. `db migrate` refreshes the config and applies pending migrations. A direct owner-package installation needs both `@vite-hub/cli` and `drizzle-kit`; `vite-hub` includes the CLI.

Run migrations as an explicit deployment step. Building a server or starting it does not prove that its target database has the current schema.

## Generated runtime import

Application code imports `useDatabase()` from `@vite-hub/database/drizzle`. The package publishes that subpath, then `hubDb()` resolves its generated schema and connection for Vite server code and Provider Output.

Do not run an unbuilt source file that imports `@vite-hub/database/drizzle` with plain `node`. Run it through the Vite-built server, as in the example. Run a Vite or ViteHub CLI command once before type-checking Named Database lookups, so `hubDb()` can write the generated declarations.

`useDatabase(name)` returns `{ db, schema }`. The generated registry types each discovered name and its Drizzle schema. For a Named Database, use the same name in the Definition, discovered path, and runtime lookup. A Default Database omits `name`, uses one of the default Definition paths shown above, and is looked up as `default`.

## Public imports

| Import | Purpose |
| --- | --- |
| `defineDatabase` and types from `@vite-hub/database` | Declare a Database Definition. |
| `useDatabase` from `@vite-hub/database/drizzle` | Access a discovered Drizzle database and its generated schema. |
| `hubDb` from `@vite-hub/database/vite` | Register discovery, generated artifacts, CLI commands, and Provider Output in Vite. |
| `@vite-hub/database/config` | Resolve Database config and discovery in advanced integrations. |
| `@vite-hub/database/cli` | Compose the package-owned CLI contribution in custom tooling. |
| `@vite-hub/database/nuxt` | Wire one Nuxt D1 host resource to Nuxt Content and Cloudflare output. |

Applications installed through `vite-hub` use `vite-hub/database` and `vite-hub/database/drizzle`. They register Database with `vitehub({ database: true, preset: "<host>" })` instead of importing `@vite-hub/database/vite`.

## Hosted databases and limits

- Local SQLite is a file on one machine. It is suitable for local development and single-host deployments with persistent storage, not shared state across multiple instances or ephemeral filesystems.
- Cloudflare output uses a configured D1 binding. Other hosts and local development do not use that binding automatically.
- Set `cloudflare.http: true` only when local or non-Cloudflare code must call Cloudflare's D1 API. It requires `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, and a database id. Cloudflare applies its global API rate limit and recommends the REST API for administrative use, so sustained application traffic should go through a narrowly authenticated proxy Worker.
- For Vercel or another non-Cloudflare host, configure a hosted SQLite or libSQL-compatible `connection.url` and keep its optional `connection.authToken` in server environment variables.
- `@vite-hub/database/nuxt` is a narrow bridge for one D1 host resource. It is not the general Database integration for multiple Named Databases.

Provider credentials, backups, migration timing, retention, and database deletion remain deployment concerns. Keep credentials in server environment declarations. Literal connection and authentication values can become part of generated runtime config, so do not hard-code secrets in a Database Definition.

## Guides and support

- Read the [Database guide](https://vitehub.dev/docs/server-primitives/database) for every Definition option, D1 configuration, hosted libSQL, Nuxt, and Agent access.
- Read the [Database CLI reference](https://vitehub.dev/docs/development/cli#manage-database-migrations) for migration arguments and multi-database behavior.
- Check the [public import reference](https://vitehub.dev/docs/reference/import-paths) before depending on another package subpath.
- Ask implementation questions in the [ViteHub Discord community](https://discord.gg/YTRDsRP3).
- Report reproducible bugs and documentation gaps in [GitHub Issues](https://github.com/vite-hub/vitehub/issues). Report suspected vulnerabilities through the [security policy](https://github.com/vite-hub/vitehub/security/policy), not a public issue or Discord.
