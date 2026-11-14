import { existsSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { createRequire } from "node:module"

import { isRecord } from "@vite-hub/internal/object"
import { dirname, join, resolve } from "pathe"

import { databaseErrorDiagnostics } from "../error-diagnostics.ts"
// Keep this static: a dynamic namespace shares Rolldown's Node helpers with the hosted D1 runtime.
import { createCloudflareD1HttpDb } from "../runtime/d1-http.ts"
import { describeExportTarget, resolveExportTarget } from "./export.ts"
import { connectPostgres, readMigrationPlan } from "./migration-plan.ts"

import type { AnyRelations } from "drizzle-orm"
import type { ResolvedDrizzleDatabaseConfig } from "../types.ts"
import type { ExportTarget } from "./export.ts"

/** The file names that `vitehub database seed` looks for, beside the migrations folder of a Database. */
const seedFileNames = ["seed.ts", "seed.mts", "seed.js", "seed.mjs"]

export interface SeedOptions {
  /** Import aliases of the host, such as Vite `resolve.alias`, for the seed file and the schema. */
  alias?: Record<string, string>
  env: NodeJS.ProcessEnv
  fetch?: typeof fetch
  projectRoot: string
  remote: boolean
}

/**
 * The seed file of a Database: `seed.ts` beside its migrations folder, so `server/databases/<name>/seed.ts` for
 * Definitions in `server/databases/`. Returns the `seed.ts` path when no file exists.
 */
export function findSeedFile(database: ResolvedDrizzleDatabaseConfig, projectRoot: string): { exists: boolean, file: string } {
  const dir = dirname(resolve(projectRoot, database.migrationsDir))
  const file = seedFileNames.map(name => join(dir, name)).find(file => existsSync(file))
  return file ? { exists: true, file } : { exists: false, file: join(dir, seedFileNames[0]!) }
}

/** The message of an error, with the message of its cause, such as the SQLite error of a Drizzle query error. */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const cause = error.cause instanceof Error ? error.cause.message : undefined
  return cause && !error.message.includes(cause) ? `${error.message.trimEnd()} ${cause}` : error.message
}

/** A Drizzle database for the seed, and how to close its client. */
interface SeedConnection {
  close: () => Promise<void> | void
  db: unknown
}

async function loadModule(file: string, options: SeedOptions): Promise<Record<string, unknown>> {
  const { createJiti } = await import("jiti")
  const jiti = createJiti(join(options.projectRoot, "package.json"), { alias: options.alias, fsCache: false, interopDefault: false, moduleCache: false })
  return await jiti.import<Record<string, unknown>>(file)
}

/** Why the target cannot be seeded, like `vitehub database export`: only a local database runs without `--remote`. */
function targetProblem(target: ExportTarget, description: string, remote: boolean): string | undefined {
  const local = target.kind === "local" || target.kind === "pglite"
  if (local && remote) return `It uses ${description}, which is not remote. Remove \`--remote\`, or set the remote \`connection.url\` in the environment or with \`--stage\`.`
  if (!local && !remote) return `It uses ${description}. Add \`--remote\` to seed a database that is not local.`
  if (target.kind === "local" && target.path === ":memory:") return "It uses an in-memory SQLite URL, which a separate process cannot write. Use a file-backed SQLite URL."
  if (target.kind === "d1" && !target.databaseId) return "Seeding D1 uses the Cloudflare API, which needs the D1 database id: set `cloudflare.databaseId`, or run `vitehub provision run`."
  if (target.kind === "d1" && (!target.accountId || !target.token)) return "Seeding D1 uses the Cloudflare API, which needs `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`."
  if (target.kind === "d1-proxy" && (!target.url || !target.token)) return "Seeding through the D1 HTTP proxy needs `cloudflare.http.url` and `cloudflare.http.authToken`."
}

/** The Database config that `readMigrationPlan()` reads for this target, with the connection already resolved. */
function migrationPlanDatabase(database: ResolvedDrizzleDatabaseConfig, target: ExportTarget): ResolvedDrizzleDatabaseConfig {
  switch (target.kind) {
    case "local":
      return { ...database, connection: { url: `file:${target.path}` } }
    case "d1":
      // A native binding with `--remote` uses the Cloudflare API, like `cloudflare.http: true`.
      return { ...database, cloudflare: { ...database.cloudflare!, databaseId: target.databaseId, http: true } }
    case "d1-proxy":
      return { ...database, cloudflare: { ...database.cloudflare!, databaseId: database.cloudflare?.databaseId ?? "" } }
    default:
      return database
  }
}

async function connect(target: ExportTarget, relations: AnyRelations, options: SeedOptions): Promise<SeedConnection> {
  switch (target.kind) {
    case "local":
    case "libsql": {
      const [{ createClient }, { createLibsqlDrizzle }] = await Promise.all([import("@libsql/client"), import("../runtime/libsql-drizzle.ts")])
      if (target.kind === "local") await mkdir(dirname(target.path), { recursive: true })
      const client = createClient(target.kind === "local" ? { url: `file:${target.path}` } : { authToken: target.authToken, url: target.url })
      return { close: () => client.close(), db: createLibsqlDrizzle(client, { relations }) }
    }
    case "d1":
    case "d1-proxy": {
      // `targetProblem()` checked the id, account, token, and proxy URL.
      const connection = target.kind === "d1"
        ? { token: target.token!, url: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(target.accountId!)}/d1/database/${encodeURIComponent(target.databaseId!)}/raw` }
        : { token: target.token!, url: target.url! }
      const request = options.fetch ?? fetch
      return { close: () => {}, db: createCloudflareD1HttpDb(connection, relations, (...args) => request(...args)) }
    }
    case "postgres": {
      const client = connectPostgres(target, options.projectRoot, options.env)
      const { drizzle } = await import("drizzle-orm/postgres-js")
      return { close: () => client.end({ timeout: 5 }), db: drizzle({ client, relations }) }
    }
    case "pglite": {
      // The app installs PGlite, so load it from the project, like `vitehub database migrate`.
      const { PGlite } = createRequire(join(options.projectRoot, "package.json"))("@electric-sql/pglite") as typeof import("@electric-sql/pglite")
      const { drizzle } = await import("drizzle-orm/pglite")
      await mkdir(dirname(target.path), { recursive: true })
      const client = new PGlite(target.path)
      return { close: () => client.close(), db: drizzle({ client, relations }) }
    }
  }
}

/**
 * Runs the seed file of one Database: its default export gets `{ db, schema }`, with the Drizzle database of the target
 * and the merged schema of the Definition. It refuses a database with pending migrations. Throws a Database error.
 */
export async function seedDatabase(database: ResolvedDrizzleDatabaseConfig, file: string, options: SeedOptions): Promise<string> {
  const failed = (problem: string, cause?: unknown) => databaseErrorDiagnostics.DATABASE_SEED_FAILED({ cause, database: database.name, problem })
  const target = resolveExportTarget(database, options)
  const description = describeExportTarget(target, options.projectRoot)
  const problem = targetProblem(target, description, options.remote)
  if (problem) throw failed(problem)

  const [error, plan] = await readMigrationPlan(
    { ...migrationPlanDatabase(database, target), migrationsDir: resolve(options.projectRoot, database.migrationsDir) },
    { env: options.env, fetch: options.fetch, projectRoot: options.projectRoot },
  )
  if (error) throw error
  if (plan.pending.length) throw databaseErrorDiagnostics.DATABASE_SEED_PENDING_MIGRATIONS({ database: database.name, migrations: plan.pending.map(migration => migration.name) })

  let seed: unknown
  let schema: Record<string, unknown>
  let relations: AnyRelations
  try {
    const [seedModule, schemaModule] = await Promise.all([loadModule(file, options), loadModule(resolve(options.projectRoot, database.generatedSchemaFile), options)])
    seed = seedModule.default
    schema = isRecord(schemaModule.schema) ? schemaModule.schema : {}
    // SAFETY: The generated schema module exports the merged Drizzle relations of the Database.
    relations = (isRecord(schemaModule.relations) ? schemaModule.relations : {}) as AnyRelations
  }
  catch (error) {
    throw failed(`The seed file ${file} or the schema of the database cannot load: ${error instanceof Error ? error.message : String(error)}`, error)
  }
  if (typeof seed !== "function") throw failed(`The seed file ${file} must default-export a function, such as \`export default async ({ db, schema }) => { ... }\`.`)

  let connection: SeedConnection
  try {
    connection = await connect(target, relations, options)
  }
  catch (error) {
    throw failed(error instanceof Error ? error.message : String(error), error)
  }
  try {
    await seed({ db: connection.db, schema })
  }
  catch (error) {
    throw failed(`The seed file ${file} threw: ${describeError(error)}`, error)
  }
  finally {
    await connection.close()
  }
  return description
}
