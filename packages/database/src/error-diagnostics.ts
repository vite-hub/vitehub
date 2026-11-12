import { defineErrors } from "@vite-hub/runtime"

function quoteList(values: readonly string[]): string {
  return values.map(value => JSON.stringify(value)).join(", ")
}

function fileList(files: readonly string[]): string {
  return files.map(file => `\n  - ${file}`).join("")
}

interface LayerOptionsProblem {
  database: string
  files: readonly string[]
  /** Options that a layer sets and the application definition does not. Only for `reason: "missing"`. */
  options?: string
  reason: "layers" | "missing" | "unreadable"
}

interface ContributionTargetProblem {
  /** Names of the Database Definitions. */
  choices?: readonly string[]
  database?: string
  dialect?: string
  reason: "ambiguous" | "dialect" | "dialects" | "missing" | "none"
  source: string
  targetDialect?: string
}

function describeLayerOptionsProblem({ database, options, reason }: LayerOptionsProblem): string {
  if (reason === "layers") return `More than one Nuxt layer sets options for the database "${database}".`
  const replaces = `The application definition of the database "${database}" sets options, so it replaces the options of its Nuxt layers.`
  return reason === "missing"
    ? `${replaces} It does not set ${options}, which a layer sets.`
    : `${replaces} ViteHub cannot read the options of these definitions.`
}

function describeContributionTarget({ choices = [], database, dialect, reason, source, targetDialect }: ContributionTargetProblem): string {
  switch (reason) {
    case "none":
      return `${source} need a Database, but the app has no Database Definition.`
    case "ambiguous":
      return `${source} target the default Database, but the app has several Database Definitions and none is named "default": ${quoteList(choices)}.`
    case "missing":
      return `${source} target the Database "${database}", which has no Database Definition. Database Definitions: ${choices.length ? quoteList(choices) : "none"}.`
    case "dialect":
      return `${source} use the "${dialect}" dialect, but the Database "${database}" uses "${targetDialect}".`
    case "dialects":
      return `The app has no Database Definition, so ViteHub adds the default Database, but its contributions need different dialects: ${source}.`
  }
}

// Keep published codes stable. Each code has a heading on the docs page.
export const databaseErrorDiagnostics = /*#__PURE__*/ defineErrors({
  docs: "https://vitehub.dev/docs/database/diagnostics",
  codes: {
    // Runtime errors. A Drizzle query rejects with them, because Drizzle owns the query API.
    DATABASE_D1_INVALID_RESPONSE: {
      why: "Cloudflare D1 returned an invalid response shape, such as a different number of results than the number of queries or malformed rows.",
      fix: "Retry the query. If it fails again, open a ViteHub issue with the query and the D1 HTTP response.",
    },
    DATABASE_D1_REQUEST_FAILED: {
      why: ({ detail, label, status }: { detail?: string, label: string, status: number }) => `Cloudflare D1 ${label} failed with HTTP ${status}${detail ? `: ${detail}` : "."}`,
      fix: "Read the D1 message in `why`. Check the SQL, the D1 API token permissions, and the D1 database id.",
    },
    DATABASE_D1_STATEMENT_TOO_LONG: {
      why: ({ bytes, limit }: { bytes: number, limit: number }) => `The SQL statement is ${bytes} bytes. Cloudflare D1 accepts statements of at most ${limit} bytes.`,
      fix: "Bind values as parameters instead of writing them into the SQL, or split the statement into several queries.",
    },
    DATABASE_D1_TOO_MANY_PARAMETERS: {
      why: ({ count, limit }: { count: number, limit: number }) => `The query binds ${count} parameters. Cloudflare D1 accepts at most ${limit} bound parameters per query.`,
      fix: "Split the values with `chunkParameters()` from `@vite-hub/database/drizzle`, and run one query for each chunk.",
    },
    DATABASE_D1_VALUE_TOO_LARGE: {
      why: ({ bytes, limit }: { bytes: number, limit: number }) => `A bound value is ${bytes} bytes. Cloudflare D1 accepts strings and BLOBs of at most ${limit} bytes.`,
      fix: "Store large files in Blob, and keep the Blob pathname in the row.",
    },

    // Config errors. ViteHub throws them when code first uses the database, because the code or the deployment must change.
    DATABASE_DISABLED: {
      why: "Database is not configured in this runtime.",
      fix: "If the app has only Named Databases, read one with `useDatabase('<name>')`, or add a Default Database. Otherwise, set `database` in `vitehub()`. With `@vite-hub/database` alone, add `hubDb()` to the Vite plugins and do not pass `false` to it.",
    },
    DATABASE_INVALID_D1_HTTP_URL: {
      why: ({ database }: { database: string }) => `\`cloudflare.http.url\` of the database "${database}" is not an HTTP or HTTPS URL.`,
      fix: "Set `cloudflare.http.url` to the D1 HTTP endpoint, for example `https://api.cloudflare.com/client/v4/accounts/<account>/d1/database/<id>/raw`.",
    },
    DATABASE_MISSING_CONNECTION: {
      why: ({ database, needs }: { database: string, needs: string }) => `The database "${database}" has no connection. It needs ${needs}.`,
      fix: "On Cloudflare, add the binding to the Worker configuration. On other hosts, set `connection.url` in the Database Definition or its environment variable. A Postgres database can use the PG* environment variables, such as `PGHOST`, instead.",
    },
    DATABASE_MISSING_D1_HTTP_CONFIG: {
      why: ({ database, missing }: { database: string, missing: string }) => `The database "${database}" uses D1 HTTP and needs ${missing} at runtime.`,
      fix: "Set the missing values in the Database Definition or in the runtime environment, then restart the server.",
    },
    DATABASE_NOT_CONNECTED: {
      why: ({ database, looked }: { database: string, looked: string }) => `The database "${database}" found no connection. It looked for ${looked}.`,
      fix: "Set the environment variable or add the Cloudflare D1 binding that `connectDatabase()` reads, or pass another location, such as `file:./data/app.sqlite`.",
    },
    DATABASE_UNSUPPORTED_URL: {
      why: ({ database, value }: { database: string, value: string }) => `The database "${database}" cannot connect to ${value}.`,
      fix: "Use `d1:BINDING`, `env:VARIABLE` with a libSQL URL, a `libsql://` or `https://` URL, or a `file:` path on Node.",
    },
    DATABASE_NO_D1_BINDING: {
      why: ({ database }: { database: string }) => `The database "${database}" has no Cloudflare D1 binding in this runtime.`,
      fix: "Call `useDatabaseBinding()` where the Database runs on a D1 binding, such as a Cloudflare Worker. On other hosts and over D1 HTTP, query it with `useDatabase(name).db`.",
    },
    DATABASE_NOT_FOUND: {
      why: ({ choices, database }: { choices?: readonly string[], database: string }) => `The database "${database}" is not configured.${choices ? ` Database Definitions: ${choices.length ? quoteList(choices) : "none"}.` : ""}`,
      fix: "Add a Database Definition with this name, for example `server/databases/<name>.ts`, or use the name of a discovered database. Run `vitehub inspect definitions --kind database` to see them.",
    },
    DATABASE_NAME_REQUIRED: {
      why: ({ choices }: { choices: readonly string[] }) => `\`useDatabase()\` without a name returns the default or only database, but the app has several and none is named "default": ${quoteList(choices)}.`,
      fix: ({ choices }: { choices: readonly string[] }) => `Pass the database name, for example \`useDatabase(${JSON.stringify(choices[0])})\`.`,
    },

    // Migration errors. `vitehub database migrate` prints them and exits with code 1. `migrateOnStart` throws them at boot.
    DATABASE_D1_MIGRATION_INVALID: {
      why: ({ problem }: { problem: string }) => `D1 migration history is invalid. ${problem}`,
      fix: "Restore the migration folders and d1-migrations.json from version control. Keep the Wrangler file names of applied migrations, and give each new migration a unique file name before generating, building, or migrating again.",
    },
    DATABASE_MIGRATION_CHECK_FAILED: {
      why: ({ database, problem }: { database: string, problem: string }) => `ViteHub cannot read the pending migrations of the database "${database}". ${problem}`,
      fix: "Make the database reachable with the connection that `vitehub database migrate` uses: the local SQLite file, `connection.url` and `connection.authToken` for libSQL, `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` for D1 HTTP, or `connection.url` or the PG* variables and the `postgres` package for Postgres.",
    },
    DATABASE_MIGRATION_DATA_LOSS: {
      why: ({ database, statements }: { database: string, statements: readonly string[] }) => `Pending migrations of the database "${database}" lose data:${fileList(statements)}`,
      fix: "Run `vitehub database migrate --dry-run` to read the SQL. To keep the data, change the schema or edit the migration. To accept the loss, back up the data and run `vitehub database migrate --allow-data-loss`, or set `database.migrateOnStart: { allowDataLoss: true }` for the next start.",
    },
    DATABASE_MIGRATION_FAILED: {
      why: ({ database, migration, problem }: { database: string, migration: string, problem: string }) => `The migration "${migration}" of the database "${database}" failed: ${problem} The database rolled back every pending migration of this run.`,
      fix: "Fix the SQL of the migration, or the data that it conflicts with, and apply it again with `vitehub database migrate` or a new server start. The server does not handle requests until the migrations apply.",
    },
    DATABASE_MIGRATE_ON_START_UNSUPPORTED: {
      why: ({ database, problem }: { database?: string, problem: string }) => `\`database.migrateOnStart\` and \`ensureMigrations()\` apply migrations only to local SQLite files and Postgres in a Node server${database ? `, and cannot migrate the database "${database}"` : ""}. ${problem}`,
      fix: "Build with the Node preset and a `file:` or Postgres connection URL. Otherwise, set `migrateOnStart: false`, remove the `ensureMigrations()` calls, and run `vitehub database migrate` from the deployment instead.",
    },

    // Export errors. `vitehub database export` prints them and exits with code 1.
    DATABASE_EXPORT_FAILED: {
      why: ({ database, problem }: { database: string, problem: string }) => `ViteHub cannot export the database "${database}". ${problem}`,
      fix: "Read the problem in `why`. Without `--remote`, `vitehub database export` reads the local SQLite file. With `--remote`, it needs `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` for D1, `connection.url` and `connection.authToken` for libSQL, the proxy `url` and `authToken` for object-form `cloudflare.http`, or `connection.url` or the PG* variables and `pg_dump` for Postgres.",
    },

    // Definition errors. `defineDatabase()` throws them.
    DATABASE_DRIZZLE_OPTION_REMOVED: {
      why: "`defineDatabase()` has no `drizzle` option. Drizzle 1.0 removed the database `casing` option.",
      fix: "Remove `drizzle`. To map camelCase keys to snake_case columns, declare each table with `snakeCase.table()` from `drizzle-orm/sqlite-core` or `drizzle-orm/pg-core`.",
    },
    DATABASE_INVALID_DIALECT: {
      why: ({ file }: { file?: string }) => file
        ? `The Database Definition "${file}" must set \`dialect\` to the string literal "sqlite" or "postgresql".`
        : "`defineDatabase().dialect` must be `sqlite` or `postgresql`.",
      fix: "Set `dialect: 'sqlite'` or `dialect: 'postgresql'` as a string literal, or remove it to use SQLite.",
    },
    DATABASE_INVALID_NAME: {
      why: "`defineDatabase().name` must be a normalized path of letters, numbers, dots, underscores, or dashes.",
      fix: "Use a name such as `analytics` or `reports/daily`.",
    },
    DATABASE_INVALID_OPTIONS: {
      why: ({ path }: { path: string }) => `\`${path}\` must be a plain object.`,
      fix: "Pass an object literal, for example `defineDatabase({ schema: { notes } })`.",
    },
    DATABASE_INVALID_REMOTE: {
      why: "`defineDatabase().remote` must be `true` or `false`.",
      fix: "Set `remote: true` to query the real D1 database in `vite dev`, or remove `remote` to keep local SQLite.",
    },
    DATABASE_REMOTE_CONFLICT: {
      why: ({ database }: { database: string }) => `The database "${database}" sets \`remote: false\`, but \`cloudflare.http\` sends \`vite dev\` queries to the remote D1 database.`,
      fix: "Remove `remote: false` to keep D1 over HTTP, or remove `cloudflare.http` from the Definition and the integration to use local SQLite in `vite dev`.",
    },
    DATABASE_UNKNOWN_OPTION: {
      why: ({ dialect, option }: { dialect?: "postgresql", option: string }) => dialect
        ? `\`defineDatabase()\` with \`dialect: "postgresql"\` does not support \`${option}\`.`
        : `\`defineDatabase()\` does not support the "${option}" option.`,
      fix: "Remove the option. The Database configure page lists the options of each dialect.",
    },

    // Build errors. ViteHub throws them when it discovers Database Definitions or builds the app.
    DATABASE_BINDING_CONFLICT: {
      why: ({ binding, first, kind, second }: { binding: string, first: string, kind: "D1" | "Hyperdrive", second: string }) => `${first} and ${second} use the same Cloudflare ${kind} binding "${binding}".`,
      fix: "Set `cloudflare.binding` to a different name for each Database Definition.",
    },
    DATABASE_DUPLICATE_DEFINITION: {
      why: ({ database, files }: { database: string, files: readonly string[] }) => `${database === "default" ? "Only one default Database Definition is allowed." : `Only one definition is allowed for the database "${database}".`}${fileList(files)}`,
      fix: "Remove one of the definitions, or give it another name.",
    },
    DATABASE_DUPLICATE_TABLE: {
      why: ({ database, first, kind, name, second }: { database: string, first: string, kind: "schema key" | "table", name: string, second: string }) => `The database "${database}" has two ${kind}s named "${name}":${fileList([first, second])}`,
      fix: "Rename one of them, or remove the contribution. If the Definition already lists the contributed tables, remove them from its schema.",
    },
    DATABASE_INVALID_CONTRIBUTION: {
      why: ({ problem }: { problem: string }) => problem,
      fix: "Fix the `vitehub.databases` entry of the plugin. Each entry needs a unique `name` and `definition: { module, export? }` that points to an object of Drizzle tables.",
    },
    DATABASE_INVALID_CONTRIBUTION_TARGET: {
      why: (problem: ContributionTargetProblem) => describeContributionTarget(problem),
      fix: "Add `server/databases/default.ts` with `defineDatabase({ schema: {} })`, or set the `database` option of the contribution to a Database Definition with the same dialect.",
    },
    DATABASE_INVALID_SCHEMA_EXPORT: {
      why: ({ handler }: { handler: string }) => `The Database Definition "${handler}" must default export \`defineDatabase({ schema })\` with a schema object.`,
      fix: "Default export the result of `defineDatabase({ schema: { ... } })` from the file.",
    },
    DATABASE_LAYER_OPTIONS_CONFLICT: {
      why: (problem: LayerOptionsProblem) => `${describeLayerOptionsProblem(problem)}${fileList(problem.files)}`,
      fix: "Keep every option in one file: the application definition or one layer. Pass an object literal to `defineDatabase()`, so that ViteHub can read the options.",
    },
    DATABASE_LAYER_TABLE_CONFLICT: {
      why: ({ database, files, table }: { database: string, files: readonly string[], table: string }) => `More than one Nuxt layer declares the table "${table}" in the database "${database}":${fileList(files)}`,
      fix: "Rename one table, or declare the table in the application definition to replace both.",
    },
    DATABASE_LEGACY_CONFIG_FILE: {
      why: ({ file, name }: { file: string, name: string }) => name === "default"
        ? `"${file}" uses the former Database file layout. The \`default\` Database is now \`server/databases/default.ts\` or \`server/databases/default/index.ts\`, with its migrations in \`server/databases/default/migrations/\`.`
        : `"${file}" uses the former Database file layout. The Database "${name}" is now \`server/databases/${name}.ts\` or \`server/databases/${name}/index.ts\`.`,
      fix: "Run `npx @vite-hub/codemods define-forms`. It moves `config.ts` to `<name>/index.ts`, moves the migrations of the default Database, and updates the imports.",
    },
    DATABASE_MISSING_D1_RESOURCE: {
      why: ({ databases, missing }: { databases: readonly string[], missing: string }) => `Cloudflare D1 output needs ${missing} for ${quoteList(databases)}.`,
      fix: "Set `cloudflare.databaseId` and `cloudflare.databaseName` at build time, or run `vitehub provision run --provider cloudflare`. For values that resolve at runtime, use D1 HTTP or a remote libSQL connection.",
    },
    DATABASE_MIXED_DEFINITIONS: {
      why: ({ files }: { files: readonly string[] }) => `\`src/database.ts\` defines the default Database, so other Databases cannot use the Vite form beside it.${fileList(files)}`,
      fix: "Move the Databases to `server/databases/<name>.ts`, including `server/databases/default.ts` for the default one.",
    },
    DATABASE_NAME_MISMATCH: {
      why: ({ file, name }: { file: string, name: string }) => `The Database Definition "${file}" must set \`name: ${JSON.stringify(name)}\` to match its file name.`,
      fix: "Set `name` to the name from the file path, or remove `name`.",
    },
    DATABASE_OPAQUE_CLOUDFLARE_CONFIG: {
      why: ({ databases }: { databases: readonly string[] }) => `Cloudflare D1 output needs a literal \`cloudflare\` object for ${quoteList(databases)}.`,
      fix: "Write `cloudflare: { ... }` as an object literal in `defineDatabase()`, or use D1 HTTP or a remote libSQL connection.",
    },
    DATABASE_PROVISION_FAILED: {
      why: ({ problem }: { problem: "database" | "list" }) => problem === "list"
        ? "Cloudflare returned an invalid D1 database list during provisioning."
        : "Cloudflare returned an invalid D1 database during provisioning.",
      fix: "Run `vitehub provision run --provider cloudflare --dry-run` again, and check the Cloudflare token permissions.",
    },
    DATABASE_INVALID_RELATIONS: {
      why: ({ database, field, reason, table }: { database: string, field?: string, reason: "missing" | "replaced", table: string }) => {
        const subject = field ? `The relation "${field}" of the database "${database}" targets the table "${table}"` : `The relations of the database "${database}" name the table "${table}"`
        return reason === "missing"
          ? `${subject}, which is not in the merged schema.`
          : `${subject}, but the merged schema holds another table object for that key. A later Nuxt layer replaced the table.`
      },
      fix: "Pass `defineRelations()` the same table objects that the schema of the database holds. When a layer replaces a table, define the relations of that table in the same layer.",
    },
    DATABASE_MIGRATIONS_OLD_LAYOUT: {
      why: ({ database, dir }: { database?: string, dir: string }) => `${database ? `The migrations of the database "${database}" in ` : ""}${dir} use the layout of Drizzle Kit 0.x, with \`meta/_journal.json\`. Drizzle Kit 1.0 and ViteHub read one \`<timestamp>_<name>/migration.sql\` folder per migration.`,
      fix: "Run `vitehub database up` once to convert the folder, then commit the new folders. Applied migrations stay applied.",
    },
    DATABASE_RESERVED_SCHEMA_KEY: {
      why: ({ key, owner }: { key: string, owner: string }) => `${owner} uses the reserved schema key "${key}".`,
      fix: "Rename the table key in the schema object.",
    },
    DATABASE_SCHEMA_LOAD_FAILED: {
      why: ({ problem, source }: { problem: string, source: string }) => `${source} could not load: ${problem}`,
      fix: "Read `error.cause` for the import error, and fix the module. `vitehub database generate` needs every schema module to load.",
    },
    DATABASE_WRANGLER_BINDING_CONFLICT: {
      why: ({ binding, field, generated, project, scope }: { binding: string, field: string, generated: string, project: string, scope: string }) => `The D1 binding "${binding}"${scope} is declared by ViteHub and by the project's Wrangler config with a different ${field}: ${JSON.stringify(generated)} and ${JSON.stringify(project)}.`,
      fix: "Remove the binding from the project's Wrangler config, since ViteHub writes it, or give one of them another binding name.",
    },
  },
})
