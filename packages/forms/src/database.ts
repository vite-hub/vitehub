import { and, desc, eq, lt, ne, or } from "drizzle-orm"
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

import { formsDiagnostics, isFormsDiagnostic } from "./errors.ts"

import type { AnyRelations } from "drizzle-orm"
import type { SQLiteAsyncDatabase } from "drizzle-orm/sqlite-core"
import type { FormAnchor, FormsStore, FormStatus, FormSubmission, FormUser, ListFormSubmissionsOptions } from "./types.ts"

/**
 * One row for each submission of every form. `data`, `anchor`, and `user` hold JSON, so a change to a form schema
 * needs no migration. Times are milliseconds since the epoch.
 */
export const formSubmissions = sqliteTable("vitehub_form_submissions", {
  id: text("id").primaryKey(),
  form: text("form").notNull(),
  data: text("data").notNull(),
  page: text("page"),
  anchor: text("anchor"),
  user: text("user"),
  status: text("status", { enum: ["open", "done", "spam", "pending"] }).notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, table => [
  index("vitehub_form_submissions_form").on(table.form, table.createdAt),
  index("vitehub_form_submissions_status").on(table.status, table.createdAt),
])

/** The tables of Forms, for `defineDatabase({ schema })` or a Database contribution. */
export const formsSchema = { formSubmissions }

export { formsTableNames } from "./table-names.ts"

/** The tables of `formsSchema` as SQLite statements that are safe to run on every start. */
export const formsTables: readonly string[] = [
  "CREATE TABLE IF NOT EXISTS `vitehub_form_submissions` (`id` text PRIMARY KEY NOT NULL, `form` text NOT NULL, `data` text NOT NULL, `page` text, `anchor` text, `user` text, `status` text NOT NULL, `created_at` integer NOT NULL, `updated_at` integer NOT NULL)",
  "CREATE INDEX IF NOT EXISTS `vitehub_form_submissions_form` ON `vitehub_form_submissions` (`form`,`created_at`)",
  "CREATE INDEX IF NOT EXISTS `vitehub_form_submissions_status` ON `vitehub_form_submissions` (`status`,`created_at`)",
]

/** A Drizzle SQLite Database: libSQL, D1, or the Database of a ViteHub app. */
export type FormsDatabase = SQLiteAsyncDatabase<"async", unknown, AnyRelations>

type Row = typeof formSubmissions.$inferSelect

function parse<T>(value: string | null): T | null {
  return value === null ? null : JSON.parse(value) as T
}

function toSubmission(row: Row): FormSubmission | undefined {
  if (row.status === "pending") return undefined
  return {
    id: row.id,
    form: row.form,
    data: JSON.parse(row.data),
    page: row.page,
    anchor: parse<FormAnchor>(row.anchor),
    user: parse<FormUser>(row.user),
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function toRow(submission: FormSubmission): Row {
  return {
    ...submission,
    data: JSON.stringify(submission.data),
    anchor: submission.anchor ? JSON.stringify(submission.anchor) : null,
    user: submission.user ? JSON.stringify(submission.user) : null,
  }
}

/** SQLite, libSQL, and D1 say `no such table`. Drizzle wraps the driver error in `cause`. */
function isMissingTable(error: unknown): boolean {
  for (let current = error, depth = 0; current instanceof Error && depth < 5; current = current.cause, depth++) {
    if (/no such table:?\s*[`"']?vitehub_form_submissions/i.test(current.message)) return true
  }
  return false
}

async function guarded<T>(action: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  }
  catch (cause) {
    if (isFormsDiagnostic(cause)) throw cause
    if (isMissingTable(cause)) throw formsDiagnostics.FORMS_TABLES_MISSING({ action, cause })
    throw formsDiagnostics.FORMS_R0001({ message: `[vitehub] Forms could not ${action}.`, cause })
  }
}

/**
 * Submissions in a Drizzle SQLite Database. Pass a function when the Database connects per request, as D1 does on
 * Cloudflare.
 */
export function createDrizzleFormsStore(database: FormsDatabase | (() => FormsDatabase)): FormsStore {
  const db = typeof database === "function" ? database : () => database
  const insertRow = (row: () => Row) => guarded("store a submission", async () => {
    const rows = await db().insert(formSubmissions).values(row()).onConflictDoNothing().returning({ id: formSubmissions.id })
    return rows.length > 0
  })
  return {
    insert: submission => insertRow(() => toRow(submission)),
    async insertWith(submission, beforeInsert) {
      const { id, form, createdAt, updatedAt } = submission
      if (!await insertRow(() => ({ id, form, createdAt, updatedAt, status: "pending", data: "null", page: null, anchor: null, user: null }))) return false

      const pending = and(eq(formSubmissions.id, id), eq(formSubmissions.status, "pending"))
      let accepted = false
      try {
        accepted = await beforeInsert()
      }
      finally {
        if (!accepted) await guarded("release a submission reservation", async () => {
          await db().delete(formSubmissions).where(pending)
        })
      }
      if (!accepted) return false
      return guarded("finish storing a submission", async () => {
        const rows = await db().update(formSubmissions).set({ ...toRow(submission), id }).where(pending).returning({ id: formSubmissions.id })
        return rows.length > 0
      })
    },
    list: (options: ListFormSubmissionsOptions = {}) => guarded("list submissions", async () => {
      const limit = Math.min(Math.max(options.limit ?? 100, 1), 500)
      const { before } = options
      const where = and(
        ne(formSubmissions.status, "pending"),
        options.form ? eq(formSubmissions.form, options.form) : undefined,
        options.status ? eq(formSubmissions.status, options.status) : undefined,
        before ? or(lt(formSubmissions.createdAt, before.createdAt), and(eq(formSubmissions.createdAt, before.createdAt), lt(formSubmissions.id, before.id))) : undefined,
      )
      const rows = await db().select().from(formSubmissions).where(where).orderBy(desc(formSubmissions.createdAt), desc(formSubmissions.id)).limit(limit)
      return rows.map(toSubmission).filter(row => row !== undefined)
    }),
    get: id => guarded("read a submission", async () => {
      const [row] = await db().select().from(formSubmissions).where(eq(formSubmissions.id, id)).limit(1)
      return row ? toSubmission(row) : undefined
    }),
    setStatus: (id, status: FormStatus, now) => guarded("change a submission", async () => {
      const [row] = await db().update(formSubmissions).set({ status, updatedAt: now }).where(and(eq(formSubmissions.id, id), ne(formSubmissions.status, "pending"))).returning()
      return row ? toSubmission(row) : undefined
    }),
  }
}
