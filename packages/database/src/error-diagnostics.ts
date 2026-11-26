import { defineErrors } from "@vite-hub/runtime"

import { createPostgresLedger, insertPostgresLedgerRow, postgresLedgerTable, quotePostgresName } from "./internal/postgres-ledger.ts"

import type { PostgresLedgerEntry } from "./internal/postgres-ledger.ts"

function quoteList(values: readonly string[]): string {
  return values.map(value => JSON.stringify(value)).join(", ")
}

function fileList(files: readonly string[]): string {
  return files.map(file => `\n  - ${file}`).join("")
}

interface AmbiguousChange {
  entity: readonly string[]
  kind: string
}

function changeName({ entity, kind }: AmbiguousChange): string {
  return `${kind.replaceAll("_", " ")} ${entity.join(".")}`
}

interface AmbiguousChangeRetry {
  command: string
  hints: readonly unknown[]
  hintsFile?: string
}

function changeAnswers(change: AmbiguousChange, { command, hints, hintsFile }: AmbiguousChangeRetry): string {
  const id = change.entity
  const answers = {
    rename: { type: "rename", kind: change.kind, from: [...id.slice(0, -1), "<old_name>"], to: id },
    create: { type: "create", kind: change.kind, entity: id },
  }
  const write = (answer: object) => hintsFile ? JSON.stringify(answer) : `${command} --hints '${JSON.stringify([...hints, answer])}'`
  return [
    `\n  ${changeName(change)}:`,
    `\n    rename: ${write(answers.rename)}`,
    `\n    create: ${write(answers.create)}`,
  ].join("")
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
    DATABASE_CHUNK_INVALID_COUNT: {
      why: ({ min, name, value }: { min: number, name: string, value: number }) => `chunkParameters() needs \`${name}\` to be an integer of ${min} or more, not ${value}.`,
      fix: "Pass whole numbers to `chunkParameters(values, { per, reserved, limit })`: `per` and `limit` of 1 or more, and `reserved` of 0 or more.",
    },
    DATABASE_CHUNK_VALUE_TOO_LARGE: {
      why: ({ limit, per, reserved }: { limit: number, per: number, reserved: number }) => `chunkParameters() cannot fit one value: it takes ${per} bound parameters and the statement has ${reserved} more, over the limit of ${limit}.`,
      fix: "Make `per` plus `reserved` of `chunkParameters()` at most `limit`: bind fewer parameters in the statement, or split each value over more statements.",
    },
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
      fix: "Split the values with `chunkParameters()` from `vite-hub/database`, and run one query for each chunk.",
    },
    DATABASE_D1_VALUE_TOO_LARGE: {
      why: ({ bytes, limit }: { bytes: number, limit: number }) => `A bound value is ${bytes} bytes. Cloudflare D1 accepts strings and BLOBs of at most ${limit} bytes.`,
      fix: "Store large files in Blob, and keep the Blob pathname in the row.",
    },

    // Idempotency errors. `withIdempotency()` returns them as `[error, undefined]`.
    DATABASE_IDEMPOTENCY_INVALID_OPTIONS: {
      why: ({ option }: { option: "key" | "timeout" | "ttl" }) => option === "key"
        ? "`withIdempotency()` needs a key that is a non-empty string."
        : `\`${option}\` of \`withIdempotency()\` must be a positive number of seconds.`,
      fix: "Pass a key that names the work, such as `stripe:${event.id}`, and `ttl` and `timeout` in seconds, for example `withIdempotency(key, fn, { ttl: 86400, timeout: 60 })`.",
    },
    DATABASE_IDEMPOTENCY_IN_PROGRESS: {
      why: ({ key }: { key: string }) => `Another call with the key ${JSON.stringify(key)} is running.`,
      fix: "Retry later: when the other call finishes, a retry gets its result. In an HTTP route, answer 409 so the client retries. In a Queue handler, return, because the running call does the work. A call that crashed holds the key until its `timeout` ends.",
    },

    // Config errors. ViteHub throws them when code first uses the database, because the code or the deployment must change.
    DATABASE_DISABLED: {
      why: "Database is not configured in this runtime.",
      fix: "If the app has only Named Databases, read one with `useDatabase('<name>')`, or add a Default Database. Otherwise, set `database` in `vitehub()`. With `@vite-hub/database` alone, add `hubDatabase()` to the Vite plugins and do not pass `false` to it.",
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
    DATABASE_URL_VARIABLE_IGNORED: {
      why: ({ database, file, variable }: { database: string, file: string, variable: string }) => `The database "${database}" has no \`connection\`, so it uses the local SQLite file ${file}. \`${variable}\` is set, but a Database Definition does not read it.`,
      fix: ({ token, variable }: { token?: string, variable: string }) => `To use it, set \`connection: { url: process.env.${variable}${token ? `, authToken: process.env.${token}` : ""} }\` in the Database Definition. To keep the local file, unset \`${variable}\`.`,
    },
    DATABASE_UNSUPPORTED_URL: {
      why: ({ database, value }: { database: string, value: string }) => `The database "${database}" cannot connect to ${value}.`,
      fix: "Use `d1:BINDING`, `env:VARIABLE` with a libSQL URL, a `libsql://` or `https://` URL, or a `file:` path on Node.",
    },
    DATABASE_NO_D1_BINDING: {
      why: ({ database }: { database: string }) => `The database "${database}" has no Cloudflare D1 binding in this runtime.`,
      fix: "Call `useDatabaseBinding()` where the Database runs on a D1 binding, such as a Cloudflare Worker. On other hosts and over D1 HTTP, query it with `useDatabase(name).db`.",
    },
    DATABASE_PGLITE_NOT_INSTALLED: {
      why: ({ database, reason }: { database: string, reason: "driver" | "no-connection" }) => reason === "driver"
        ? `The database "${database}" sets \`driver: "pglite"\`, but the app cannot load \`@electric-sql/pglite\`.`
        : `The database "${database}" has no \`connection.url\` or PG* variables, so development runs it on PGlite, but the app cannot load \`@electric-sql/pglite\`.`,
      fix: "Install PGlite in the app, for example with `pnpm add -D @electric-sql/pglite`. To use a Postgres server instead, set `connection.url` and remove `driver: \"pglite\"`.",
    },
    DATABASE_NOT_FOUND: {
      why: ({ choices, database }: { choices?: readonly string[], database: string }) => `The database "${database}" is not configured.${choices ? ` Database Definitions: ${choices.length ? quoteList(choices) : "none"}.` : ""}`,
      fix: "Add a Database Definition with this name, for example `server/databases/<name>.ts`, or use the name of a discovered database. Run `vitehub inspect definitions --kind database` to see them.",
    },
    DATABASE_NAME_REQUIRED: {
      why: ({ choices }: { choices: readonly string[] }) => `\`useDatabase()\` without a name returns the default or only database, but the app has several and none is named "default": ${quoteList(choices)}.`,
      fix: ({ choices }: { choices: readonly string[] }) => `Pass the database name, for example \`useDatabase(${JSON.stringify(choices[0])})\`.`,
    },

    // Generate errors. `vitehub database generate` prints them and exits with code 2.
    DATABASE_GENERATE_AMBIGUOUS_CHANGE: {
      why: ({ changes, database }: { changes: readonly AmbiguousChange[], database: string }) => `The Definitions of the database "${database}" add a column or table and remove another one, and Drizzle Kit cannot tell whether the new one is a rename. Without a terminal, \`vitehub database generate\` cannot ask, so it wrote no migration.${changes.length ? `\nThe changes to answer:${fileList(changes.map(changeName))}` : " Drizzle Kit lists the changes above."}`,
      fix: ({ changes, ...retry }: AmbiguousChangeRetry & { changes: readonly AmbiguousChange[] }) => [
        "Answer each change with a hint and run the command again. A rename keeps the data. A create adds an empty column or table, and the migration drops the removed one with its data.",
        changes.length
          ? `Replace <old_name> with the removed name. ${retry.hintsFile ? `Add one answer per change to the array in ${retry.hintsFile}, then run ${retry.command} --hints-file ${retry.hintsFile}:` : "With several changes, put one answer per change in the same array:"}${changes.map(change => changeAnswers(change, retry)).join("")}`
          : `Copy the answers that Drizzle Kit printed into ${retry.command} --hints '[...]'.`,
        "In a terminal without CI, the command asks instead.",
      ].join("\n"),
    },

    // Migration errors. `vitehub database migrate` prints them and exits with code 1. `migrateOnStart` throws them at boot.
    DATABASE_D1_MIGRATION_FAILED: {
      why: ({ database, problem }: { database: string, problem: string }) => `D1 migration failed for the database "${database}". ${problem}`,
      fix: "Fix the SQL of the failed migration, or set `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` and `cloudflare.databaseId` (or the `url` and `authToken` of object-form `cloudflare.http`) to values that can edit D1. Then run `vitehub database migrate` again.",
    },
    DATABASE_D1_MIGRATION_INVALID: {
      why: ({ problem }: { problem: string }) => `D1 migration history is invalid. ${problem}`,
      fix: "Restore the migration folders and d1-migrations.json from version control. Keep the Wrangler file names of applied migrations, and give each new migration a unique file name before generating, building, or migrating again.",
    },
    DATABASE_MIGRATION_CHECK_FAILED: {
      why: ({ database, problem }: { database: string, problem: string }) => `ViteHub cannot read the pending migrations of the database "${database}". ${problem}`,
      fix: "Make the database reachable with the connection that `vitehub database migrate` uses: the local SQLite file, `connection.url` and `connection.authToken` for libSQL, `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` for D1 HTTP, `connection.url` or the PG* variables and the `postgres` package for Postgres, or `@electric-sql/pglite` for a Postgres Database on PGlite.",
    },
    DATABASE_MIGRATION_CONVERSION_FAILED: {
      why: ({ problem }: { problem: string }) => `ViteHub could not convert the old migration layout. ${problem}`,
      fix: "Fix the problem above and run `vitehub database up` again. Keep the file names and journal timestamps of applied migrations. If the history cannot be converted, move it to the Drizzle Kit 1.0 layout manually and verify it on a copy of the database before migrating.",
    },
    DATABASE_MIGRATION_DATA_LOSS: {
      why: ({ database, statements }: { database: string, statements: readonly string[] }) => `Pending migrations of the database "${database}" lose data:${fileList(statements)}`,
      fix: "Run `vitehub database migrate --dry-run` to read the SQL. To keep the data, change the schema or edit the migration. To accept the loss, back up the data and run `vitehub database migrate --allow-data-loss`, or set `database.migrateOnStart: { allowDataLoss: true }` for the next build. To accept it for one start of a built server, such as a container, set `VITEHUB_DATABASE_ALLOW_DATA_LOSS=1`.",
    },
    DATABASE_MIGRATION_FAILED: {
      why: ({ database, migration, problem }: { database: string, migration: string, problem: string }) => `The migration "${migration}" of the database "${database}" failed: ${problem} The database rolled back every pending migration of this run.`,
      fix: "Fix the SQL of the migration, or the data that it conflicts with, and apply it again with `vitehub database migrate` or a new server start. The server does not handle requests until the migrations apply.",
    },
    DATABASE_MIGRATE_ON_START_UNSUPPORTED: {
      why: ({ database, problem }: { database?: string, problem: string }) => `\`database.migrateOnStart\` and \`ensureMigrations()\` apply migrations only to local SQLite files, Cloudflare D1 over HTTP, and Postgres in a Node server${database ? `, and cannot migrate the database "${database}"` : ""}. ${problem}`,
      fix: "Build with the Node host and a `file:` or Postgres connection URL, or `cloudflare.http`. Otherwise, set `migrateOnStart: false`, remove the `ensureMigrations()` calls, and run `vitehub database migrate` from the deployment instead.",
    },
    DATABASE_MIGRATION_BACKUP_FAILED: {
      why: ({ database, problem, target }: { database: string, problem: string, target: string }) => `ViteHub cannot back up the database "${database}" to "${target}" before its pending migrations: ${problem} The server applied no migration.`,
      fix: "Make the backup folder writable and give it free space, or set `migrateOnStart.backup.dir` to another folder. Then start the server again.",
    },
    DATABASE_MIGRATION_BACKUP_UNSUPPORTED: {
      why: ({ database, problem }: { database?: string, problem: string }) => `\`migrateOnStart.backup\` copies only local SQLite files${database ? `, and cannot copy the database "${database}"` : ""}. ${problem}`,
      fix: "Use a `file:` connection URL, or remove `backup` and back up the database with its own tools, such as `pg_dump` or the snapshots of your libSQL provider. Set `keep` to a whole number of 1 or more.",
    },
    DATABASE_MIGRATE_ON_DEPLOY_UNSUPPORTED: {
      why: ({ database, problem }: { database?: string, problem: string }) => `\`database.migrateOnDeploy\` applies migrations only to Cloudflare D1 bindings, with \`wrangler d1 migrations apply\` before \`wrangler deploy\`${database ? `, and cannot migrate the database "${database}"` : ""}. ${problem}`,
      fix: "Build with the Cloudflare host and give each database a D1 binding. Otherwise, remove `migrateOnDeploy` and run `vitehub database migrate` before you deploy.",
    },
    DATABASE_MIGRATION_LEDGER_MISPLACED: {
      why: ({ database, migrations, schema }: { database: string, migrations: readonly PostgresLedgerEntry[], recorded: number, schema: string }) => `The database "${database}" sets \`migrationsSchema: "${schema}"\`, and the ledger ${postgresLedgerTable(schema)} does not list ${quoteList(migrations.map(migration => migration.name))}. The ledger "drizzle"."__drizzle_migrations" lists the same SQL, so the database probably applied them before \`migrationsSchema\` was set. ViteHub reads only the ledger in "${schema}", so it would apply them again. It stopped before any change.`,
      fix: ({ migrations, recorded, schema }: { database: string, migrations: readonly PostgresLedgerEntry[], recorded: number, schema: string }) => `${recorded ? `Keep \`migrationsSchema\`: the ledger in "${schema}" lists ${recorded} migration(s) that "drizzle" may not list, so ViteHub would apply them again without it. Verify` : `Remove \`migrationsSchema\` to keep the ledger in "drizzle". Or verify`} that this database applied these migrations, because another app that shares "drizzle" can apply the same SQL. Then run this SQL once in a SQL client, as a role that can create tables in "${schema}":\n${[createPostgresLedger(postgresLedgerTable(schema)), ...migrations.map(migration => insertPostgresLedgerRow(postgresLedgerTable(schema), migration))].map(statement => `${statement};`).join("\n")}`,
    },
    DATABASE_MIGRATION_SCHEMA_CONFLICT: {
      why: ({ databases, schemas }: { databases: readonly [string, string], schemas: readonly [string | undefined, string | undefined] }) => `The databases "${databases[0]}" and "${databases[1]}" share one Postgres database and its migration ledger, but set different \`migrationsSchema\` values: ${schemas.map(schema => schema === undefined ? "none (\"drizzle\")" : JSON.stringify(schema)).join(" and ")}.`,
      fix: "Set the same `migrationsSchema` on every Definition that connects to this Postgres database, or remove it from all of them.",
    },
    DATABASE_MIGRATION_SCHEMA_MISSING: {
      why: ({ database, schema }: { database: string, schema: string }) => `The database "${database}" sets \`migrationsSchema: "${schema}"\`, but the Postgres database has no schema "${schema}". On a Postgres server, ViteHub does not create a schema that you choose.`,
      fix: ({ schema }: { database: string, schema: string }) => `Create the schema with \`vitehub database sql 'CREATE SCHEMA ${quotePostgresName(schema)}'\`, as a role that owns the database, or fix the name in \`migrationsSchema\`.`,
    },

    // Export errors. `vitehub database export` prints them and exits with code 1.
    DATABASE_EXPORT_FAILED: {
      why: ({ database, problem }: { database: string, problem: string }) => `ViteHub cannot export the database "${database}". ${problem}`,
      fix: "Read the problem in `why`. Without `--remote`, `vitehub database export` reads the local SQLite file. With `--remote`, it needs `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` for D1, `connection.url` and `connection.authToken` for libSQL, the proxy `url` and `authToken` for object-form `cloudflare.http`, or `connection.url` or the PG* variables and `pg_dump` for Postgres.",
    },

    // SQL and drop errors. The CLI prints them and exits with code 1.
    DATABASE_DROP_FAILED: {
      why: ({ command, database, problem }: { command: "drop" | "reset", database: string, problem: string }) => `\`vitehub database ${command}\` cannot drop the tables of the database "${database}". ${problem}`,
      fix: "Read the problem in `why`. The drop runs in one transaction, so a failure drops nothing. Without `--remote`, it drops the local SQLite file or PGlite folder. With `--remote`, it needs the same credentials as `vitehub database export --remote`.",
    },
    DATABASE_DROP_NOT_CONFIRMED: {
      why: ({ command, database }: { command: "drop" | "reset", database: string }) => `\`vitehub database ${command}\` drops every table of the database "${database}" and was not confirmed.`,
      fix: "Answer `y` on a terminal, or add `--yes` when no terminal can answer, such as in CI or a script.",
    },
    DATABASE_SQL_FAILED: {
      why: ({ database, problem }: { database: string, problem: string }) => `ViteHub cannot run the SQL on the database "${database}". ${problem}`,
      fix: "Read the problem in `why`. Without `--remote`, `vitehub database sql` runs on the local SQLite file or PGlite folder. With `--remote`, it needs the same credentials as `vitehub database export --remote`. For a SQL error, fix the statement and run it again.",
    },

    // Seed errors. `vitehub seed` prints them and exits with code 1.
    DATABASE_SEED_NOT_FOUND: {
      why: ({ database, file }: { database: string, file: string }) => `The database "${database}" has no seed file. ViteHub looks for ${file}.`,
      fix: "Create the file with a default export, such as `export default async ({ db, schema }) => { await db.insert(schema.users).values({ name: 'Ada' }) }`. To seed another database, add `--database <name>`.",
    },
    DATABASE_SEED_PENDING_MIGRATIONS: {
      why: ({ database, migrations }: { database: string, migrations: readonly string[] }) => `The database "${database}" has pending migrations, so the seed would not see the current tables:${fileList(migrations)}`,
      fix: "Run `vitehub database migrate` with the same `--remote` and `--stage` flags, then run `vitehub seed` again.",
    },
    DATABASE_SEED_FAILED: {
      why: ({ database, problem }: { database: string, problem: string }) => `ViteHub cannot seed the database "${database}". ${problem}`,
      fix: "Read the problem in `why`. Without `--remote`, `vitehub seed` writes only the local database: the SQLite file or the PGlite folder. With `--remote`, it needs the same connection as `vitehub database export --remote`. A seed that throws keeps the rows that it wrote before the error. Write them in `db.transaction()` to keep all or none.",
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
    DATABASE_INVALID_DRIVER: {
      why: ({ file }: { file?: string }) => file
        ? `The Database Definition "${file}" must set \`driver\` to the string literal "node-postgres" or "pglite".`
        : "`defineDatabase().driver` must be `node-postgres` or `pglite`.",
      fix: "Set `driver: 'node-postgres'` or `driver: 'pglite'` as a string literal, or remove `driver` to connect with postgres.js.",
    },
    DATABASE_INVALID_MIGRATIONS_SCHEMA: {
      why: ({ file }: { file?: string }) => file
        ? `The Database Definition "${file}" must set \`migrationsSchema\` to a string literal.`
        : "`defineDatabase().migrationsSchema` must be a non-empty string.",
      fix: "Set `migrationsSchema` to the name of an existing Postgres schema as a string literal, such as `migrationsSchema: 'app'`, or remove it to keep the ledger in the schema \"drizzle\".",
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
      why: ({ dialect, option }: { dialect?: "postgresql" | "sqlite", option: string }) => dialect
        ? `\`defineDatabase()\` with ${dialect === "sqlite" ? "SQLite" : "`dialect: \"postgresql\"`"} does not support \`${option}\`.`
        : `\`defineDatabase()\` does not support the "${option}" option.`,
      fix: "Remove the option. The Database configure page lists the options of each dialect.",
    },

    // Build errors. ViteHub throws them when it discovers Database Definitions or builds the app.
    DATABASE_BINDING_CONFLICT: {
      why: ({ binding, first, kind, second }: { binding: string, first: string, kind: "D1" | "Hyperdrive", second: string }) => `${first} and ${second} use the same Cloudflare ${kind} binding "${binding}".`,
      fix: "Set `cloudflare.binding` to a different name for each Database Definition.",
    },
    DATABASE_CONTRIBUTED_TABLES_NOT_GENERATED: {
      why: ({ databases, missing, restore }: { databases: readonly string[], missing: readonly string[], restore: readonly string[] }) => `Vite plugins add tables or SQL migrations to the Database${databases.length > 1 ? "s" : ""} ${databases.join(", ")}, but its migrations do not have:${fileList([...missing, ...restore.map(file => `the SQL file ${file}`)])}\nRequests that use them could fail after the deploy.`,
      fix: ({ missing, restore }: { missing: readonly string[], restore: readonly string[] }) => [
        restore.length ? "Restore the missing `migration.sql` files from the original migrations and commit them." : "",
        missing.length ? "Run `vitehub database generate`, commit the new migration folders, and apply them with `vitehub database migrate` or your deploy." : "",
        "Then build again.",
      ].filter(Boolean).join(" "),
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
      fix: "Set `cloudflare.databaseId` and `cloudflare.databaseName` at build time, or run `vitehub provision run --host cloudflare`. For values that resolve at runtime, use D1 HTTP or a remote libSQL connection.",
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
    DATABASE_PGLITE_IN_BUILD: {
      why: ({ databases }: { databases: readonly string[] }) => `These Postgres Databases set \`driver: "pglite"\`: ${quoteList(databases)}. PGlite keeps its data in a local folder of one process, so a production build does not include it.`,
      fix: "Remove `driver: \"pglite\"` and set `connection.url` to your Postgres server, for example `connection: { url: process.env.DATABASE_URL }`. In development, a Postgres Database without a URL still runs on PGlite.",
    },
    DATABASE_PROVISION_FAILED: {
      why: ({ problem }: { problem: "database" | "list" }) => problem === "list"
        ? "Cloudflare returned an invalid D1 database list during provisioning."
        : "Cloudflare returned an invalid D1 database during provisioning.",
      fix: "Run `vitehub provision run --host cloudflare --dry-run` again, and check the Cloudflare token permissions.",
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
      why: ({ database, dir, layout }: { database?: string, dir: string, layout: "journal" | "flat" }) => `${database ? `The migrations of the database "${database}" in ` : ""}${dir} ${layout === "journal" ? "use the layout of Drizzle Kit 0.x, with `meta/_journal.json`" : "are flat `.sql` files, as Wrangler writes them"}. Drizzle Kit 1.0 and ViteHub read one \`<timestamp>_<name>/migration.sql\` folder per migration.`,
      fix: "Run `vitehub database up` once to convert the folder, then commit the new folders. Applied migrations stay applied, and D1 keeps the file names that Wrangler applied.",
    },
    DATABASE_RESERVED_SCHEMA_KEY: {
      why: ({ key, owner }: { key: string, owner: string }) => `${owner} uses the reserved schema key "${key}".`,
      fix: "Rename the table key in the schema object.",
    },
    DATABASE_SCHEMA_LOAD_FAILED: {
      why: ({ problem, source }: { problem: string, source: string }) => `${source} could not load: ${problem}`,
      fix: "Read `error.cause` for the import error, and fix the module. `vitehub database generate` needs every schema module to load.",
    },
    DATABASE_UNKNOWN_DRIVER: {
      why: ({ driver }: { driver: string }) => driver === "\"d1\""
        ? "`database.driver` is \"d1\". ViteHub renamed this driver to \"cloudflare\", and it does not read \"d1\"."
        : `\`database.driver\` ${driver} is not a Database driver. The only driver of the \`database\` option is "cloudflare".`,
      fix: ({ driver }: { driver: string }) => driver === "\"d1\""
        ? "Set `database: { driver: \"cloudflare\" }`, or run `npx @vite-hub/codemods driver-key` to rename it in every config file."
        : "Set `database.driver` to \"cloudflare\" for Cloudflare D1, or remove it. On `host: \"cloudflare\"`, ViteHub uses D1 without it. Set Postgres drivers in the Database Definition.",
    },
    DATABASE_WRANGLER_BINDING_CONFLICT: {
      why: ({ binding, field, generated, project, scope }: { binding: string, field: string, generated: string, project: string, scope: string }) => `The D1 binding "${binding}"${scope} is declared by ViteHub and by the project's Wrangler config with a different ${field}: ${JSON.stringify(generated)} and ${JSON.stringify(project)}.`,
      fix: "Remove the binding from the project's Wrangler config, since ViteHub writes it, or give one of them another binding name.",
    },

    // Setup errors. ViteHub throws them when the Wrangler config or the project packages do not fit the Database.
    DATABASE_D1_MIGRATIONS_DIR_INVALID: {
      why: "D1 migrations_dir must be a relative directory inside Nitro's server output.",
      fix: "Set `migrations_dir` of the D1 binding in the Wrangler config to a relative folder, such as `migrations`, or remove it so that ViteHub picks the folder.",
    },
    DATABASE_D1_MIGRATIONS_DIR_OVERLAP: {
      why: ({ first, second }: { first: string, second: string }) => `D1 migration directories overlap for bindings ${first} and ${second}; configure an exclusive migrations_dir for each binding.`,
      fix: "Give each D1 binding in the Wrangler config its own `migrations_dir` folder, so that no folder is the same as another or inside it.",
    },
    DATABASE_NUXT_CONTENT_D1_MISSING: {
      why: "Nuxt Content on Cloudflare requires an explicit content.database configuration or a complete Wrangler D1 binding named DB.",
      fix: "Set `content: { database: { type: \"d1\", bindingName: \"DB\" } }` in nuxt.config.ts and declare that D1 binding with its `database_id` in the Wrangler config, or add a Database Definition in `server/databases/`.",
    },
    DATABASE_POSTGRES_DRIVER_MISSING: {
      why: ({ name }: { name: "pg" | "postgres" }) => `Cannot load the \`${name}\` package from the project. Install it, for example with \`pnpm add ${name}\`.`,
      fix: "Install the Postgres driver that the message names in the project: `pnpm add postgres`, or `pnpm add pg` for a Database with `driver: \"node-postgres\"`.",
    },
  },
})
