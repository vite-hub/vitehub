import { existsSync } from "node:fs"
import { createRequire } from "node:module"

import { createClient } from "@libsql/client"
import { join } from "pathe"

import { createD1Query } from "./d1-migrations.ts"
import { cloudflareApi, describeExportTarget, missingD1Credentials, resolveD1DatabaseId, resolveExportTarget } from "./export.ts"
import { connectPostgres } from "./migration-plan.ts"
import { splitSqlStatements } from "./migration-sql.ts"

import type { ResolvedDrizzleDatabaseConfig } from "../types.ts"
import type { ExportTarget } from "./export.ts"

/** The result of one SQL statement. `rowsAffected` is `null` when the driver does not report it. */
export interface SqlStatementResult {
  columns: string[]
  rows: Array<Record<string, unknown>>
  rowsAffected: number | null
}

/** One open connection of `vitehub database sql` or `drop`. */
export interface SqlConnection {
  dialect: "postgresql" | "sqlite"
  /** Where the connection goes, without credentials. */
  target: string
  /** Runs a script of one or more statements. Returns one result per statement. */
  run: (script: string) => Promise<SqlStatementResult[]>
  /** Runs the statements in one transaction. SQLite defers foreign key checks to the commit. */
  runInTransaction: (statements: string[]) => Promise<void>
  close: () => Promise<void>
}

export interface SqlConnectionOptions {
  env: NodeJS.ProcessEnv
  fetch?: typeof fetch
  projectRoot: string
  remote: boolean
}

export type SqlConnectionResult =
  | { connection: SqlConnection }
  /** The local file or folder does not exist. */
  | { missing: string }
  | { problem: string }

/**
 * Opens the database that `vitehub database export` reads, with the same target rules: local SQLite and PGlite without
 * `--remote`, and every other connection only with `--remote`.
 */
export async function openSqlConnection(database: ResolvedDrizzleDatabaseConfig, options: SqlConnectionOptions): Promise<SqlConnectionResult> {
  const target = resolveExportTarget(database, options)
  const description = describeExportTarget(target, options.projectRoot)
  const local = target.kind === "local" || target.kind === "pglite"
  if (local && options.remote) {
    return { problem: `It uses ${description}, which is not remote. Remove \`--remote\`, or set the remote \`connection.url\` in the environment or with \`--stage\`.` }
  }
  if (!local && !options.remote) {
    return { problem: `It uses ${description}. Add \`--remote\` to reach a database that is not on this machine.` }
  }
  switch (target.kind) {
    case "local":
      if (target.path === ":memory:") return { problem: "It uses an in-memory SQLite URL, which a separate process cannot reach. Use a file-backed SQLite URL." }
      if (!existsSync(target.path)) return { missing: description }
      return { connection: openLibsql({ url: `file:${target.path}` }, description) }
    case "libsql":
      return { connection: openLibsql({ authToken: target.authToken, url: target.url }, description) }
    case "d1-proxy":
      return { connection: openD1(createD1Query({ proxy: { token: target.token, url: target.url } }, options.fetch), description) }
    case "d1": {
      const missing = missingD1Credentials(target)
      if (missing.length) return { problem: `ViteHub reaches D1 with the Cloudflare API, which needs ${missing.join(" and ")}.` }
      return { connection: await openD1Api(target, options.fetch, description) }
    }
    case "pglite":
      if (!existsSync(target.path)) return { missing: description }
      return openPglite(target.path, options.projectRoot, description)
    case "postgres":
      return { connection: openPostgres(target, options, description) }
  }
}

function toObjectRows(columns: readonly string[], rows: ArrayLike<unknown>[]): Array<Record<string, unknown>> {
  return rows.map(row => Object.fromEntries(columns.map((column, index) => [column, row[index]])))
}

function openLibsql(config: { authToken?: string, url: string }, target: string): SqlConnection {
  const client = createClient(config)
  return {
    close: async () => client.close(),
    dialect: "sqlite",
    run: async (script) => {
      const results: SqlStatementResult[] = []
      // libSQL runs one statement per call, so split at semicolons outside of quotes and comments.
      for (const statement of splitSqlStatements(script)) {
        const result = await client.execute(statement)
        const columns = [...result.columns]
        results.push({ columns, rows: toObjectRows(columns, result.rows), rowsAffected: columns.length ? null : result.rowsAffected })
      }
      return results
    },
    runInTransaction: async (statements) => {
      await client.batch(["PRAGMA defer_foreign_keys = ON", ...statements], "write")
    },
    target,
  }
}

type D1Query = ReturnType<typeof createD1Query>

function openD1(query: D1Query, target: string): SqlConnection {
  return {
    close: async () => {},
    dialect: "sqlite",
    run: async (script) => {
      const results: SqlStatementResult[] = []
      for (const statement of splitSqlStatements(script)) {
        const rows = (await query(statement)).filter((row): row is Record<string, unknown> => !!row && typeof row === "object" && !Array.isArray(row))
        results.push({ columns: rows[0] ? Object.keys(rows[0]) : [], rows, rowsAffected: null })
      }
      return results
    },
    // D1 runs the statements of one query as one batch, which commits together.
    runInTransaction: async (statements) => {
      await query(["PRAGMA defer_foreign_keys = ON", ...statements].map(statement => `${statement.replace(/;\s*$/, "")};`).join("\n"))
    },
    target,
  }
}

async function openD1Api(target: Extract<ExportTarget, { kind: "d1" }>, request: typeof fetch | undefined, description: string): Promise<SqlConnection> {
  const databaseId = await resolveD1DatabaseId(target, cloudflareApi(target, request))
  return openD1(createD1Query({ accountId: target.accountId, databaseId, token: target.token }, request), description)
}

interface PostgresResult extends Array<Record<string, unknown>> {
  columns?: Array<{ name: string }> | null
  command?: string
  count?: number | null
}

function readPostgresResult(result: PostgresResult): SqlStatementResult {
  const columns = (result.columns ?? []).map(column => column.name)
  return { columns, rows: [...result], rowsAffected: columns.length ? null : (result.count ?? null) }
}

function openPostgres(target: Extract<ExportTarget, { kind: "postgres" }>, options: SqlConnectionOptions, description: string): SqlConnection {
  const sql = connectPostgres(target, options.projectRoot, options.env)
  return {
    close: async () => sql.end({ timeout: 5 }),
    dialect: "postgresql",
    run: async (script) => {
      // The simple query protocol runs several statements in one call and returns one result for each.
      const result = await sql.unsafe(script).simple() as unknown as PostgresResult | PostgresResult[]
      const results = "command" in result ? [result as PostgresResult] : result as PostgresResult[]
      return results.map(readPostgresResult)
    },
    runInTransaction: async (statements) => {
      await sql.begin(async (transaction) => {
        for (const statement of statements) await transaction.unsafe(statement)
      })
    },
    target: description,
  }
}

async function openPglite(path: string, projectRoot: string, description: string): Promise<SqlConnectionResult> {
  let PGlite: typeof import("@electric-sql/pglite").PGlite
  try {
    // Drizzle Kit and `vitehub database migrate` load PGlite from the project too.
    ({ PGlite } = createRequire(join(projectRoot, "package.json"))("@electric-sql/pglite") as typeof import("@electric-sql/pglite"))
  }
  catch {
    return { problem: "It runs on PGlite, but the project cannot load `@electric-sql/pglite`. Install it with `pnpm add -D @electric-sql/pglite`." }
  }
  const client = new PGlite(path)
  return { connection: {
    close: async () => client.close(),
    dialect: "postgresql",
    run: async (script) => {
      const results = await client.exec(script)
      return results.map(result => ({
        columns: result.fields.map(field => field.name),
        rows: result.rows,
        rowsAffected: result.fields.length ? null : (result.affectedRows ?? null),
      }))
    },
    runInTransaction: async (statements) => {
      await client.transaction(async (transaction) => {
        for (const statement of statements) await transaction.exec(statement)
      })
    },
    target: description,
  } }
}

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll("\"", "\"\"")}"`
}

/** The statements that drop every user table and view, and the migration ledger with them. Empty when there is none. */
export async function planDrop(connection: SqlConnection): Promise<{ objects: string[], statements: string[] }> {
  return connection.dialect === "sqlite" ? await planSqliteDrop(connection) : await planPostgresDrop(connection)
}

/**
 * SQLite: every table and view in `main`, except SQLite and Cloudflare internal tables and FTS shadow tables, which go
 * with their virtual table. Drizzle's `__drizzle_migrations` and Wrangler's `d1_migrations` ledgers are tables too.
 */
async function planSqliteDrop(connection: SqlConnection) {
  const [tableList, objects] = await connection.run("PRAGMA table_list; SELECT type, name FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY rowid;")
  const shadow = new Set(tableList!.rows.filter(row => row.schema === "main" && row.type === "shadow").map(row => String(row.name)))
  const drop = objects!.rows
    .map(row => ({ name: String(row.name), type: String(row.type) }))
    .filter(object => !/^(?:sqlite_|_cf_)/i.test(object.name) && !shadow.has(object.name))
  // DROP TABLE performs an implicit DELETE, including immediate SET NULL/DEFAULT actions.
  // Remove children first so those actions cannot violate constraints on selected tables.
  const tables = drop.filter(object => object.type === "table")
  const references = await Promise.all(tables.map(async table => {
    const [result] = await connection.run(`PRAGMA foreign_key_list(${quoteIdentifier(table.name)})`)
    return { table, parents: new Set(result!.rows.map(row => String(row.table))) }
  }))
  const ordered = drop.filter(object => object.type === "view")
  const remaining = new Set(tables.map(table => table.name))
  while (remaining.size) {
    const next = references.find(entry => remaining.has(entry.table.name)
      && !references.some(child => remaining.has(child.table.name) && child.table.name !== entry.table.name && child.parents.has(entry.table.name)))
      ?? references.find(entry => remaining.has(entry.table.name))!
    ordered.push(next.table)
    remaining.delete(next.table.name)
  }
  return {
    objects: ordered.map(object => `${object.type} ${object.name}`),
    statements: ordered.map(object => `DROP ${object.type === "view" ? "VIEW" : "TABLE"} IF EXISTS ${quoteIdentifier(object.name)}`),
  }
}

const systemSchemas = "n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'"

/**
 * Postgres: the tables, views, sequences, and enum types that the current user owns, in every schema but the system ones, then the
 * schemas that are left empty, except `public`. Drizzle's ledger lives in the `drizzle` schema. Objects of other roles,
 * such as the `auth` and `storage` tables of Supabase, stay.
 */
async function planPostgresDrop(connection: SqlConnection) {
  const [relations, types] = await connection.run(`
    SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S') AND pg_get_userbyid(c.relowner) = current_user AND NOT c.relispartition AND ${systemSchemas}
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype IN ('a', 'e', 'i'))
      ORDER BY n.nspname, c.relname;
    SELECT n.nspname AS schema, t.typname AS name FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE t.typtype = 'e' AND pg_get_userbyid(t.typowner) = current_user AND ${systemSchemas}
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e')
      ORDER BY n.nspname, t.typname;
  `)
  const keyword = { f: "FOREIGN TABLE", m: "MATERIALIZED VIEW", p: "TABLE", r: "TABLE", S: "SEQUENCE", v: "VIEW" } as const
  const drops = relations!.rows.map(row => ({ keyword: keyword[String(row.kind) as keyof typeof keyword], name: `${quoteIdentifier(String(row.schema))}.${quoteIdentifier(String(row.name))}`, schema: String(row.schema) }))
  const enums = types!.rows.map(row => ({ name: `${quoteIdentifier(String(row.schema))}.${quoteIdentifier(String(row.name))}`, schema: String(row.schema) }))
  // Keep the confirmation in a stable order; execution below retries owned dependencies without CASCADE.
  const rank = (drop: { keyword: string }) => drop.keyword.includes("VIEW") ? 0 : drop.keyword === "SEQUENCE" ? 2 : 1
  const ordered = drops.toSorted((left, right) => rank(left) - rank(right))
  const schemas = [...new Set([...drops, ...enums].map(object => object.schema))].filter(schema => schema !== "public")
  // Drop tables together so mutual foreign keys among selected tables do not block a reset.
  // Other dependencies (including chains of views) are retried, but never cascaded.
  const commands = [...new Set(ordered.map(drop => drop.keyword))].map(keyword =>
    `DROP ${keyword} IF EXISTS ${ordered.filter(drop => drop.keyword === keyword).map(drop => drop.name).join(", ")}`)
  commands.push(...enums.map(type => `DROP TYPE IF EXISTS ${type.name}`))
  if (!commands.length) return { objects: [], statements: [] }
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`
  let delimiter = "$vitehub_drop$"
  while (commands.some(command => command.includes(delimiter))) delimiter = `$${delimiter.slice(1, -1)}_$`
  const tableNames = ordered.filter(drop => drop.keyword === "TABLE").map(drop => literal(drop.name))
  return {
    objects: [...ordered.map(drop => `${drop.keyword.toLowerCase()} ${drop.name}`), ...enums.map(type => `type ${type.name}`)],
    statements: [
      `DO ${delimiter}
      DECLARE pending text[] := ARRAY[${commands.map(literal).join(", ")}]::text[]; remaining text[]; command text;
      BEGIN
        -- Partitions are removed automatically even without CASCADE.
        IF EXISTS (
          WITH RECURSIVE descendants(oid) AS (
            SELECT unnest(ARRAY[${tableNames.join(", ")}]::regclass[])
            UNION
            SELECT i.inhrelid FROM pg_inherits i JOIN descendants d ON i.inhparent = d.oid
          )
          SELECT 1 FROM descendants d JOIN pg_class c ON c.oid = d.oid
          WHERE c.relispartition AND pg_get_userbyid(c.relowner) <> current_user
        ) THEN
          RAISE EXCEPTION 'Database reset blocked by a partition owned by another role' USING ERRCODE = '2BP01';
        END IF;
        WHILE cardinality(pending) > 0 LOOP
          remaining := ARRAY[]::text[];
          FOREACH command IN ARRAY pending LOOP
            BEGIN
              EXECUTE command;
            EXCEPTION WHEN dependent_objects_still_exist THEN
              remaining := array_append(remaining, command);
            END;
          END LOOP;
          IF cardinality(remaining) = cardinality(pending) THEN
            RAISE EXCEPTION 'Database reset blocked by dependencies outside the selected owned objects' USING ERRCODE = '2BP01';
          END IF;
          pending := remaining;
        END LOOP;
      END ${delimiter}`,
      // Drizzle Kit writes `CREATE SCHEMA` without `IF NOT EXISTS`, so the next migrate needs the schema gone. The DO
      // block keeps a schema that still has objects of another role, instead of failing the transaction.
      ...schemas.map(schema => `DO $$ BEGIN DROP SCHEMA ${quoteIdentifier(schema)}; EXCEPTION WHEN dependent_objects_still_exist OR insufficient_privilege THEN NULL; END $$`),
    ],
  }
}

/** Prints a cell: `NULL`, bytes as `x'..'` hex, objects as JSON, and the rest as text on one line. */
function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "NULL"
  if (value instanceof Date) return value.toISOString()
  if (value instanceof ArrayBuffer) return `x'${Buffer.from(value).toString("hex")}'`
  if (ArrayBuffer.isView(value)) return `x'${Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("hex")}'`
  const text = typeof value === "object" ? JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString() : item) : String(value)
  return text.replaceAll("\r", "\\r").replaceAll("\n", "\\n")
}

/** Formats one statement result as a text table, or as the number of changed rows for a statement without rows. */
export function formatSqlResult(result: SqlStatementResult): string {
  if (!result.columns.length) return result.rowsAffected === null ? "OK\n" : `OK, ${result.rowsAffected} ${result.rowsAffected === 1 ? "row" : "rows"} changed.\n`
  const cells = result.rows.map(row => result.columns.map(column => formatCell(row[column])))
  const widths = result.columns.map((column, index) => Math.max(column.length, ...cells.map(row => row[index]!.length)))
  const line = (values: string[]) => values.map((value, index) => value.padEnd(widths[index]!)).join(" | ").trimEnd()
  return [
    line(result.columns),
    widths.map(width => "-".repeat(width)).join("-+-"),
    ...cells.map(line),
    `(${result.rows.length} ${result.rows.length === 1 ? "row" : "rows"})`,
    "",
  ].join("\n")
}
