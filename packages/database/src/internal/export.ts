import { createWriteStream, existsSync } from "node:fs"
import { link, mkdir, mkdtemp, open, rm } from "node:fs/promises"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { setTimeout as sleep } from "node:timers/promises"

import { createClient } from "@libsql/client"
import { basename, dirname, join, resolve } from "pathe"

import { resolveConfigValue } from "../config-value.ts"
import { resolveLocalSqlitePath } from "../runtime/local-path.ts"
import { createD1Query } from "./d1-migrations.ts"
import { withoutCredentials } from "./migration-plan.ts"

import type { ResolvedDrizzleDatabaseConfig } from "../types.ts"
import type { D1Query } from "./d1-migrations.ts"

/** Where `vitehub db export` reads a database. Only `local` is on this machine. */
type ExportTarget =
  | { kind: "local", path: string }
  | { kind: "libsql", authToken?: string, url: string }
  | { kind: "d1", accountId?: string, databaseId?: string, databaseName?: string, token?: string }
  | { kind: "d1-proxy", token?: string, url?: string }
  | { kind: "postgres", url?: string }

interface ExportOptions {
  env: NodeJS.ProcessEnv
  fetch?: typeof fetch
  /** Absolute path of the SQL file. The export fails when it exists. */
  output: string
  projectRoot: string
  remote: boolean
  spawn: (command: string, args: string[], options?: { cwd?: string, env?: NodeJS.ProcessEnv, stderr?: "inherit" | "pipe", stdout?: "inherit" | "pipe" }) => Promise<{ exitCode: number | null }>
}

/** Resolves the export target with the same connection rules as `vitehub db migrate`. */
function resolveExportTarget(database: ResolvedDrizzleDatabaseConfig, { env, projectRoot, remote }: Pick<ExportOptions, "env" | "projectRoot" | "remote">): ExportTarget {
  if (database.dialect === "postgresql") return { kind: "postgres", url: resolveConfigValue(database.connection?.url, env)?.trim() || undefined }
  const cloudflare = database.cloudflare
  if (cloudflare?.http && typeof cloudflare.http === "object") {
    return { kind: "d1-proxy", token: resolveConfigValue(cloudflare.http.authToken, env)?.trim() || undefined, url: resolveConfigValue(cloudflare.http.url, env)?.trim() || undefined }
  }
  const defaultUrl = database.name === "default" ? "file:.vitehub/data/database/sqlite.db" : `file:.vitehub/data/database/${database.name}.sqlite.db`
  const url = resolveConfigValue(database.connection?.url, env)?.trim() || defaultUrl
  const isLibsql = /^(?:libsql:|https?:|wss?:)/i.test(url)
  // A native D1 binding reads the local SQLite file during development. `--remote` reads the deployed D1 database.
  // An explicitly configured remote libSQL connection takes precedence over a native binding.
  if (cloudflare && (cloudflare.http || (remote && !isLibsql))) {
    return {
      accountId: env.CLOUDFLARE_ACCOUNT_ID?.trim() || undefined,
      databaseId: resolveConfigValue(cloudflare.databaseId, env)?.trim() || undefined,
      databaseName: resolveConfigValue(cloudflare.databaseName, env)?.trim() || undefined,
      kind: "d1",
      token: env.CLOUDFLARE_API_TOKEN?.trim() || undefined,
    }
  }
  if (isLibsql) return { authToken: resolveConfigValue(database.connection?.authToken, env) || undefined, kind: "libsql", url }
  return { kind: "local", path: url === ":memory:" ? url : resolve(projectRoot, resolveLocalSqlitePath(url)) }
}

/** Names the target without credentials. */
export function describeExportTarget(target: ExportTarget, projectRoot: string): string {
  switch (target.kind) {
    case "local":
      return `local SQLite ${target.path.startsWith(`${projectRoot}/`) ? target.path.slice(projectRoot.length + 1) : target.path}`
    case "libsql":
      return `libSQL ${withoutCredentials(target.url)}`
    case "d1":
      return target.databaseId ? `Cloudflare D1 ${target.databaseId}` : `Cloudflare D1 "${target.databaseName ?? "(no database id or name)"}"`
    case "d1-proxy":
      return `D1 HTTP proxy ${withoutCredentials(target.url ?? "")}`
    case "postgres":
      return target.url ? `Postgres ${withoutCredentials(target.url)}` : "Postgres from the PG* environment variables"
  }
}

/**
 * Writes a SQL dump of one database to `options.output`. SQLite, libSQL, and D1 dumps use the format of
 * `wrangler d1 export`, so `wrangler d1 execute --file` and `sqlite3` can both restore them. Throws with the problem.
 */
export async function exportDatabase(database: ResolvedDrizzleDatabaseConfig, options: ExportOptions): Promise<ExportTarget> {
  const target = resolveExportTarget(database, options)
  const description = describeExportTarget(target, options.projectRoot)
  if (target.kind === "local" && options.remote) {
    throw new Error(`It uses ${description}, which is not remote. Remove \`--remote\`, or set the remote \`connection.url\` in the environment or with \`--stage\`.`)
  }
  if (target.kind !== "local" && !options.remote) {
    throw new Error(`It uses ${description}. Add \`--remote\` to export a database that is not a local file.`)
  }
  if (existsSync(options.output)) throw new Error(`The output file exists: ${options.output}`)
  await mkdir(dirname(options.output), { recursive: true })
  const partialDirectory = await mkdtemp(join(dirname(options.output), `.${basename(options.output)}.partial-`))
  const partial = join(partialDirectory, basename(options.output))
  try {
    switch (target.kind) {
      case "local":
        if (target.path === ":memory:") throw new Error("It uses an in-memory SQLite URL, which a separate process cannot read. Use a file-backed SQLite URL.")
        if (!existsSync(target.path)) throw new Error(`The local SQLite file does not exist: ${target.path}. Run \`vitehub db migrate\` to create it.`)
        await dumpLibsql({ url: `file:${target.path}` }, partial)
        break
      case "libsql":
        await dumpLibsql({ authToken: target.authToken, url: target.url }, partial)
        break
      case "d1-proxy":
        await writeSqliteDump(createD1Query({ proxy: { token: target.token, url: target.url } }, options.fetch), partial)
        break
      case "d1":
        await exportD1(target, partial, options)
        break
      case "postgres":
        await exportPostgres(target, partial, options)
        break
    }
    // Linking publishes the completed file atomically and refuses an existing destination.
    try {
      await link(partial, options.output)
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`The output file exists: ${options.output}`)
      throw error
    }
  }
  finally {
    await rm(partialDirectory, { force: true, recursive: true })
  }
  return target
}

async function dumpLibsql(config: { authToken?: string, url: string }, file: string) {
  const client = createClient(config)
  try {
    // One read transaction gives a consistent snapshot while the app keeps writing.
    const transaction = await client.transaction("read")
    try {
      await writeSqliteDump(async sql => (await transaction.execute(sql)).rows, file, true)
    }
    finally {
      transaction.close()
    }
  }
  finally {
    client.close()
  }
}

const pageSize = 500

/** Writes a dump like `wrangler d1 export`: no transaction, foreign keys deferred, data before indexes and triggers. */
async function writeSqliteDump(query: D1Query, file: string, inTransaction = false): Promise<void> {
  const handle = await open(file, "wx")
  try {
    const write = async (text: string) => { await handle.write(text) }
    await write("PRAGMA defer_foreign_keys=TRUE;\n")
    const tableList = await query("PRAGMA table_list")
    const kinds = new Map(tableList
      .filter(row => field(row, "schema", 0) === "main")
      .map(row => [String(field(row, "name", 1)), { type: String(field(row, "type", 2)), withoutRowid: Number(field(row, "wr", 4)) === 1 }]))
    const objects = (await query("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid"))
      .map(row => ({ name: String(field(row, "name", 1)), sql: String(field(row, "sql", 3)), table: String(field(row, "tbl_name", 2)), type: String(field(row, "type", 0)) }))
    const skipped = (table: string) => /^(?:sqlite_|_cf_)/i.test(table) || kinds.get(table)?.type === "shadow"
    for (const object of objects) {
      if (object.type !== "table" || skipped(object.name)) continue
      if (kinds.get(object.name)?.type === "virtual" && isContentlessFts5(object.sql)) {
        throw new Error(`Cannot export contentless FTS5 table ${quoteIdentifier(object.name)} without losing its search index. Use a SQLite backup that preserves FTS shadow tables.`)
      }
      await write(`${object.sql};\n`)
      await writeRows(query, object.name, kinds.get(object.name), write, inTransaction)
    }
    if (objects.some(object => object.type === "table" && object.name === "sqlite_sequence")) {
      await write("DELETE FROM sqlite_sequence;\n")
      for (const row of await query("SELECT quote(name), quote(seq) FROM sqlite_sequence")) {
        await write(`INSERT INTO "sqlite_sequence" VALUES(${field(row, "quote(name)", 0)},${field(row, "quote(seq)", 1)});\n`)
      }
    }
    for (const object of objects) {
      if (object.type === "table" || skipped(object.table)) continue
      await write(`${object.sql};\n`)
    }
  }
  finally {
    await handle.close()
  }
}

function isContentlessFts5(sql: string): boolean {
  // Keep quoted strings whole and discard comments before inspecting module options.
  const tokens = (sql.match(/'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|--[^\r\n]*|\/\*[\s\S]*?\*\/|\w+|[^\s]/g) ?? [])
    .filter(token => !token.startsWith("--") && !token.startsWith("/*"))
    .map(token => (/^['"`[]/.test(token) ? token.slice(1, -1) : token).toLowerCase())
  return tokens.some((token, index) => token === "using" && tokens[index + 1] === "fts5")
    && tokens.some((token, index) => token === "content" && tokens[index + 1] === "=" && tokens[index + 2] === "")
}

async function writeRows(query: D1Query, table: string, kind: { type: string, withoutRowid: boolean } | undefined, write: (text: string) => Promise<void>, inTransaction: boolean) {
  const info = await query(`PRAGMA table_xinfo(${quoteIdentifier(table)})`)
  const columns = info.filter(row => Number(field(row, "hidden", 6)) === 0).map(row => String(field(row, "name", 1)))
  if (!columns.length) return
  const rowid = kind && !kind.withoutRowid ? ["_rowid_", "rowid", "oid"].find(name => !info.some(row => String(field(row, "name", 1)).toLowerCase() === name)) : undefined
  if (rowid) {
    const primaryKey = info.filter(row => Number(field(row, "pk", 5)) > 0)
    // INTEGER PRIMARY KEY aliases rowid, except when SQLite creates a separate PK index (e.g. PRIMARY KEY DESC).
    const aliasesRowid = primaryKey.length === 1 && String(field(primaryKey[0], "type", 2)).toUpperCase() === "INTEGER"
      && !(await query(`PRAGMA index_list(${quoteIdentifier(table)})`)).some(row => field(row, "origin", 3) === "pk")
    if (!aliasesRowid) columns.unshift(rowid)
  }
  const values = columns.map((column, index) => {
    const name = quoteIdentifier(column)
    // quote() truncates TEXT at NUL and emits invalid Inf tokens for infinite REALs.
    return `CASE WHEN typeof(${name}) = 'text' AND instr(${name}, char(0)) > 0 THEN 'CAST(X''' || hex(${name}) || ''' AS TEXT)' WHEN typeof(${name}) = 'real' AND ${name} = 1e999 THEN '1e999' WHEN typeof(${name}) = 'real' AND ${name} = -1e999 THEN '-1e999' ELSE quote(${name}) END AS c${index}`
  }).join(", ")
  const insert = `INSERT INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(",")}) VALUES(`
  const writePage = async (rows: unknown[], offset: number) => {
    for (const row of rows) await write(`${insert}${columns.map((_, index) => field(row, `c${index}`, index + offset)).join(",")});\n`)
  }
  // Offset pages are stable only inside a read transaction. A proxy cannot share one across requests.
  const pageRowid = kind?.type === "table" ? rowid : undefined
  if (!pageRowid && !inTransaction) {
    await writePage(await query(`SELECT ${values} FROM ${quoteIdentifier(table)}`), 0)
    return
  }
  let after: string | undefined
  let offset = 0
  for (;;) {
    const rows = await query(pageRowid
      ? `SELECT quote(${quoteIdentifier(pageRowid)}) AS k, ${values} FROM ${quoteIdentifier(table)}${after === undefined ? "" : ` WHERE ${quoteIdentifier(pageRowid)} > ${after}`} ORDER BY ${quoteIdentifier(pageRowid)} LIMIT ${pageSize}`
      : `SELECT ${values} FROM ${quoteIdentifier(table)} LIMIT ${pageSize} OFFSET ${offset}`)
    await writePage(rows, pageRowid ? 1 : 0)
    if (rows.length < pageSize) return
    if (pageRowid) after = String(field(rows.at(-1), "k", 0))
    else offset += rows.length
  }
}

function field(row: unknown, key: string, index: number): unknown {
  if (Array.isArray(row)) return row[index]
  return row && typeof row === "object" ? (row as Record<string, unknown>)[key] : undefined
}

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll("\"", "\"\"")}"`
}

interface CloudflareEnvelope {
  errors?: Array<{ message?: string }>
  result?: unknown
  success?: boolean
}

interface D1ExportPoll {
  at_bookmark?: string
  error?: string
  result?: { signed_url?: string }
  status?: "active" | "complete" | "error"
}

/** Exports a D1 database with Cloudflare's export API, like `wrangler d1 export --remote`. */
async function exportD1(target: Extract<ExportTarget, { kind: "d1" }>, file: string, options: ExportOptions) {
  const missing = [
    !target.accountId && "`CLOUDFLARE_ACCOUNT_ID`",
    !target.token && "`CLOUDFLARE_API_TOKEN`",
    !target.databaseId && !target.databaseName && "`cloudflare.databaseId` or `cloudflare.databaseName`",
  ].filter(Boolean)
  if (missing.length) throw new Error(`ViteHub exports D1 with the Cloudflare API, which needs ${missing.join(" and ")}.`)
  const request = options.fetch ?? fetch
  const api = async (path: string, init: { body?: unknown, method?: string } = {}) => {
    const response = await request(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(target.accountId!)}${path}`, {
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      headers: { "Authorization": `Bearer ${target.token}`, "Content-Type": "application/json" },
      method: init.method ?? "GET",
    })
    const payload = await response.json().catch(() => undefined) as CloudflareEnvelope | undefined
    if (!response.ok || payload?.success !== true) {
      const messages = (payload?.errors ?? []).map(error => error.message).filter(Boolean)
      throw new Error(`The Cloudflare API returned HTTP ${response.status}${messages.length ? `: ${messages.join("; ")}` : ""}.`)
    }
    return payload.result
  }
  let databaseId = target.databaseId
  if (!databaseId) {
    const listed = await api(`/d1/database?name=${encodeURIComponent(target.databaseName!)}`)
    const match = (Array.isArray(listed) ? listed as Array<{ name?: string, uuid?: string }> : []).find(database => database.name === target.databaseName)
    if (!match?.uuid) throw new Error(`The Cloudflare account has no D1 database named "${target.databaseName}". Run \`vitehub provision run --provider cloudflare\` or set \`cloudflare.databaseId\`.`)
    databaseId = match.uuid
  }
  let bookmark: string | undefined
  let signedUrl: string | undefined
  const maxPolls = 600
  for (let attempt = 0; attempt < maxPolls; attempt++) {
    const poll = await api(`/d1/database/${encodeURIComponent(databaseId)}/export`, {
      body: { current_bookmark: bookmark, dump_options: { no_data: false, no_schema: false }, output_format: "polling" },
      method: "POST",
    }) as D1ExportPoll | undefined
    if (poll?.status === "error") throw new Error(`Cloudflare D1 export failed: ${poll.error ?? "unknown error"}.`)
    if (poll?.status === "complete") {
      signedUrl = poll.result?.signed_url
      if (!signedUrl) throw new Error("Cloudflare D1 export completed without a download URL.")
      break
    }
    if (typeof poll?.at_bookmark !== "string" || !poll.at_bookmark.trim()) throw new Error("Cloudflare D1 export returned a continuation without a bookmark.")
    bookmark = poll.at_bookmark
    if (attempt < maxPolls - 1) await sleep(1000)
  }
  if (!signedUrl) throw new Error(`Cloudflare D1 export did not complete after ${maxPolls} polls.`)
  // The signed URL authorizes the download by itself. Do not send the API token to it.
  const download = await request(signedUrl)
  if (!download.ok || !download.body) throw new Error(`The D1 export download returned HTTP ${download.status}.`)
  await pipeline(Readable.fromWeb(download.body), createWriteStream(file, { flags: "wx" }))
}

/** Exports Postgres with `pg_dump`. The password goes in `PGPASSWORD`, so it is not in the process arguments. */
async function exportPostgres(target: Extract<ExportTarget, { kind: "postgres" }>, file: string, options: ExportOptions) {
  const env = { ...options.env }
  const args = ["--no-owner", "--no-privileges", "--file", file]
  if (target.url) {
    const url = new URL(target.url)
    if (url.password) env.PGPASSWORD = decodeURIComponent(url.password)
    url.password = ""
    args.push("--dbname", url.href)
  }
  let exitCode: number | null
  try {
    ({ exitCode } = await options.spawn("pg_dump", args, { cwd: options.projectRoot, env, stderr: "inherit", stdout: "inherit" }))
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("ViteHub exports Postgres with `pg_dump`, which is not on PATH. Install the PostgreSQL client tools.")
    throw error
  }
  if (exitCode !== 0) throw new Error(`\`pg_dump\` failed with exit code ${exitCode ?? "unknown"}. See its output above.`)
}
