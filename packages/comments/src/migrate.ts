import { sql } from "drizzle-orm"

import { commentsTables } from "./tables.ts"

/**
 * - `empty`: no `vitehub_comment_threads` table.
 * - `live`: the tables of the live-site model: threads with `number`, `page`, and `created_by`, and `vitehub_comments`.
 * - `outdated`: the tables of one model, without columns that a later version added.
 * - `current`: nothing to do.
 */
export type CommentsSchemaState = "empty" | "live" | "outdated" | "current"

export interface CommentsMigrationOptions {
  /** `postgresql` for a Postgres Database. Default `sqlite`: SQLite, libSQL, and D1. */
  dialect?: "sqlite" | "postgresql"
}

export interface CommentsMigration {
  /** What the Database had before. */
  from: CommentsSchemaState
  /** The statements that ran. Empty when there was nothing to do. */
  statements: string[]
  /** The table that keeps the threads of the live-site model, after a `live` migration. */
  backup?: string
}

/** The live-site threads, after the migration renames them. The migration never deletes them. */
export const liveThreadsBackup = "vitehub_comment_threads_live"

/** The columns that one model added to `vitehub_comment_threads` after its first version. */
const addedColumns = { metadata: "text", context: "text", revision: "integer" } as const

const scopeOf = "CASE WHEN `scope` = 'pages' THEN 'site' ELSE `scope` END"

/**
 * Moves the live-site tables to the tables of one model, on SQLite, libSQL, and D1. It renames the threads table to
 * `vitehub_comment_threads_live`, creates the new tables, and copies every thread and comment. It deletes nothing:
 * `vitehub_comment_threads_live`, `vitehub_comments`, and `vitehub_comment_scope_counters` stay for you to check.
 */
function liveToCurrent(): string[] {
  const subjectKind = "CASE WHEN `scope` = 'pages' THEN 'page' WHEN instr(`scope`, ':') > 1 THEN substr(`scope`, 1, instr(`scope`, ':') - 1) ELSE `scope` END"
  const subjectId = "CASE WHEN `scope` = 'pages' THEN `page` WHEN instr(`scope`, ':') > 1 THEN substr(`scope`, instr(`scope`, ':') + 1) ELSE `page` END"
  return [
    `ALTER TABLE \`vitehub_comment_threads\` RENAME TO \`${liveThreadsBackup}\``,
    ...commentsTables,
    "CREATE TABLE IF NOT EXISTS `vitehub_comment_scope_counters` (`scope` text PRIMARY KEY NOT NULL, `last_number` integer NOT NULL)",
    [
      "INSERT INTO `vitehub_comment_threads` (`id`, `scope`, `n`, `subject_kind`, `subject_id`, `anchor`, `status`, `resolved_by`, `resolved_at`, `author_id`, `author_name`, `author_image`, `actor`, `metadata`, `context`, `revision`, `created_at`, `updated_at`)",
      `SELECT \`id\`, ${scopeOf}, \`number\`, ${subjectKind}, ${subjectId},`,
      "CASE WHEN `anchor` IS NULL OR `anchor` = 'null' THEN '{\"kind\":\"page\"}' ELSE json_set(`anchor`, '$.kind', 'element') END,",
      "`status`, `resolved_by`, `resolved_at`,",
      "json_extract(`created_by`, '$.id'), json_extract(`created_by`, '$.name'), json_extract(`created_by`, '$.image'),",
      "NULL, `metadata`, `context`, NULL, `created_at`, `updated_at`",
      `FROM \`${liveThreadsBackup}\``,
    ].join(" "),
    [
      "INSERT INTO `vitehub_comment_messages` (`id`, `thread_id`, `body`, `author_id`, `author_name`, `author_image`, `actor`, `mentions`, `attachments`, `created_at`, `edited_at`)",
      "SELECT `c`.`id`, `c`.`thread_id`, `c`.`body`, json_extract(`c`.`author`, '$.id'), json_extract(`c`.`author`, '$.name'), json_extract(`c`.`author`, '$.image'), NULL,",
      "coalesce((SELECT json_group_array(json_extract(`m`.`value`, '$.id')) FROM json_each(`c`.`mentions`) AS `m`), '[]'), '[]', `c`.`created_at`, `c`.`edited_at`",
      `FROM \`vitehub_comments\` AS \`c\` WHERE \`c\`.\`thread_id\` IN (SELECT \`id\` FROM \`${liveThreadsBackup}\`)`,
    ].join(" "),
    // A number is handed out once: the next one follows the highest number that the scope ever had.
    `INSERT INTO \`vitehub_comment_counters\` (\`scope\`, \`next\`) SELECT ${scopeOf}, max(\`number\`) + 1 FROM \`${liveThreadsBackup}\` GROUP BY 1 ON CONFLICT (\`scope\`) DO UPDATE SET \`next\` = max(\`next\`, excluded.\`next\`)`,
    `INSERT INTO \`vitehub_comment_counters\` (\`scope\`, \`next\`) SELECT ${scopeOf}, \`last_number\` + 1 FROM \`vitehub_comment_scope_counters\` WHERE true ON CONFLICT (\`scope\`) DO UPDATE SET \`next\` = max(\`next\`, excluded.\`next\`)`,
  ]
}

function postgresCurrent(): string[] {
  return [
    ...Object.entries(addedColumns).map(([column, type]) => `ALTER TABLE "vitehub_comment_threads" ADD COLUMN IF NOT EXISTS "${column}" ${type === "integer" ? "bigint" : type}`),
    "CREATE TABLE IF NOT EXISTS \"vitehub_comment_forge\" (\"id\" text PRIMARY KEY NOT NULL, \"thread_id\" text, \"repository\" text NOT NULL, \"pull_request\" bigint NOT NULL, \"remote_id\" text, \"node_id\" text, \"url\" text, \"digest\" text, \"posted_as\" text, \"minimized\" boolean DEFAULT false NOT NULL, \"error\" text, \"updated_at\" bigint NOT NULL)",
    "CREATE INDEX IF NOT EXISTS \"vitehub_comment_forge_thread\" ON \"vitehub_comment_forge\" (\"thread_id\")",
    "CREATE INDEX IF NOT EXISTS \"vitehub_comment_forge_pull_request\" ON \"vitehub_comment_forge\" (\"repository\",\"pull_request\")",
  ]
}

/**
 * The SQL of a migration, to put in a custom migration file: `vitehub db generate --custom`, or
 * `wrangler d1 execute --file`. `from: "live"` moves the live-site tables of SQLite, libSQL, or D1 to one model;
 * `from: "outdated"` adds the columns of this version, on SQLite or Postgres. Run each SQL once. `migrateComments()`
 * reads the Database first, so it can run on every deploy.
 */
export function commentsMigrationSql(options: CommentsMigrationOptions & { from: "live" | "outdated", missing?: readonly string[] }): string[] {
  if (options.dialect === "postgresql") {
    if (options.from === "live") throw new TypeError("[vitehub] The live-site comments model had no Postgres tables, so there is nothing to move.")
    return postgresCurrent()
  }
  if (options.from === "live") return liveToCurrent()
  const missing = options.missing ?? Object.keys(addedColumns)
  return [
    ...Object.entries(addedColumns).filter(([column]) => missing.includes(column)).map(([column, type]) => `ALTER TABLE \`vitehub_comment_threads\` ADD COLUMN \`${column}\` ${type}`),
    ...commentsTables.filter(statement => statement.includes("vitehub_comment_forge")),
  ]
}

/** The Drizzle databases of SQLite, libSQL, D1, and Postgres, as far as the migration uses them. */
interface MigrationDatabase {
  all?: (query: ReturnType<typeof sql.raw>) => Promise<unknown[]>
  run?: (query: ReturnType<typeof sql.raw>) => PromiseLike<unknown>
  execute?: (query: ReturnType<typeof sql.raw>) => PromiseLike<unknown>
  batch?: (queries: unknown[]) => Promise<unknown>
  transaction?: (run: (target: MigrationDatabase) => Promise<void>) => Promise<unknown>
}

/** The first column of each row: libSQL and D1 return objects, the SQLite proxy returns arrays. */
function names(rows: unknown): string[] {
  const list = Array.isArray(rows) ? rows : Array.isArray(Reflect.get(Object(rows), "rows")) ? Reflect.get(Object(rows), "rows") as unknown[] : []
  return list.map(row => String(Array.isArray(row) ? row[0] : Object.values(Object(row))[0]))
}

async function columns(db: MigrationDatabase, postgres: boolean): Promise<string[]> {
  if (postgres) return names(await db.execute!(sql.raw("SELECT column_name FROM information_schema.columns WHERE table_name = 'vitehub_comment_threads' AND table_schema = current_schema()")))
  return names(await db.all!(sql.raw("SELECT name FROM pragma_table_info('vitehub_comment_threads')")))
}

/** What the Database has: no comments yet, the live-site tables, one model without newer columns, or nothing to do. */
export async function commentsSchemaState(db: object, options: CommentsMigrationOptions = {}): Promise<{ state: CommentsSchemaState, missing: string[] }> {
  // SAFETY: Drizzle databases of every supported driver have these methods; `postgres` picks the ones it calls.
  const found = await columns(db as MigrationDatabase, options.dialect === "postgresql")
  if (!found.length) return { missing: [], state: "empty" }
  if (found.includes("number") && found.includes("created_by")) return { missing: [], state: "live" }
  const missing = Object.keys(addedColumns).filter(column => !found.includes(column))
  return { missing, state: missing.length ? "outdated" : "current" }
}

/**
 * Brings the comment tables of a Database to this version, in place. It reads the tables first, so a second run does
 * nothing. A live-site Database keeps its old tables: the threads move to `vitehub_comment_threads_live`, and
 * `vitehub_comments` and `vitehub_comment_scope_counters` stay. All statements run in one batch or transaction, so a
 * failure changes nothing. Stop comment writes while it runs, and back up the Database first.
 */
export async function migrateComments(db: object, options: CommentsMigrationOptions = {}): Promise<CommentsMigration> {
  // SAFETY: Drizzle databases of every supported driver have these methods.
  const target = db as MigrationDatabase
  const postgres = options.dialect === "postgresql"
  const { state, missing } = await commentsSchemaState(target, options)
  if (state === "empty" || state === "current") return { from: state, statements: [] }
  const statements = commentsMigrationSql({ ...options, from: state, missing })
  if (postgres) {
    if (!target.transaction) throw new TypeError("[vitehub] migrateComments() needs a Postgres Drizzle database with transaction().")
    await target.transaction(async (tx) => {
      for (const statement of statements) await tx.execute!(sql.raw(statement))
    })
  }
  else if (target.batch) {
    await target.batch(statements.map(statement => target.run!(sql.raw(statement))))
  }
  else if (target.transaction) {
    await target.transaction(async (tx) => {
      for (const statement of statements) await tx.run!(sql.raw(statement))
    })
  }
  else {
    throw new TypeError("[vitehub] migrateComments() needs a Drizzle database with batch() or transaction(), so a failure changes nothing.")
  }
  return { from: state, statements, ...(state === "live" ? { backup: liveThreadsBackup } : {}) }
}
