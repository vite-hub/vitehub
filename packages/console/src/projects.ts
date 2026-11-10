import { asc, eq } from "drizzle-orm"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

import { createProjectToken, openProjectToken, sealProjectToken, tokenSha256 } from "./token-box.ts"

import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core"

/**
 * One row for each linked project. `token_sealed` is the project token, encrypted with `VITEHUB_CONSOLE_SECRET`.
 * `token_sha256` is the value that the project keeps, so the Console can show it again.
 */
export const consoleProjects = sqliteTable("console_projects", {
  id: text("id").primaryKey(),
  url: text("url").notNull().unique(),
  label: text("label"),
  tokenSealed: text("token_sealed").notNull(),
  tokenSha256: text("token_sha256").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at").notNull(),
})

/** The tables of the Console, for `defineDatabase({ schema })`. */
export const consoleSchema = { consoleProjects }

/** A Drizzle SQLite Database: libSQL, D1, or the Database of a ViteHub app. */
export type ConsoleDatabase = BaseSQLiteDatabase<"async", unknown, Record<string, unknown>>

/** A linked project as the Console page sees it. It never holds the token. */
export interface ConsoleProject {
  id: string
  url: string
  label: string | null
  /** The SHA-256 of the project token. The project keeps it in `VITEHUB_CONSOLE_TOKEN_SHA256`. */
  tokenSha256: string
  createdBy: string
  createdAt: number
}

function toProject(row: typeof consoleProjects.$inferSelect): ConsoleProject {
  return { id: row.id, url: row.url, label: row.label, tokenSha256: row.tokenSha256, createdBy: row.createdBy, createdAt: row.createdAt }
}

export interface ConsoleProjectStore {
  list(): Promise<ConsoleProject[]>
  get(id: string): Promise<ConsoleProject | undefined>
  /** Link a project with a new token. Returns `undefined` when the URL is already linked. */
  create(input: { url: string, label?: string, createdBy: string }): Promise<ConsoleProject | undefined>
  /** The project and its token, or `undefined` when there is no such project or the secret cannot open its token. */
  target(id: string): Promise<{ project: ConsoleProject, token: string } | undefined>
  remove(id: string): Promise<boolean>
}

export function createConsoleProjectStore(database: ConsoleDatabase | (() => ConsoleDatabase), secret: string): ConsoleProjectStore {
  const db = typeof database === "function" ? database : () => database
  const row = async (id: string) => (await db().select().from(consoleProjects).where(eq(consoleProjects.id, id)).limit(1))[0]
  return {
    async list() {
      return (await db().select().from(consoleProjects).orderBy(asc(consoleProjects.createdAt), asc(consoleProjects.id))).map(toProject)
    },
    async get(id) {
      const found = await row(id)
      return found ? toProject(found) : undefined
    },
    async create({ url, label, createdBy }) {
      const [existing] = await db().select({ id: consoleProjects.id }).from(consoleProjects).where(eq(consoleProjects.url, url)).limit(1)
      if (existing) return undefined
      const id = crypto.randomUUID()
      const token = createProjectToken()
      const values = {
        id,
        url,
        label: label?.trim() || null,
        tokenSealed: await sealProjectToken(secret, id, token),
        tokenSha256: await tokenSha256(token),
        createdBy,
        createdAt: Date.now(),
      }
      await db().insert(consoleProjects).values(values)
      return toProject(values)
    },
    async target(id) {
      const found = await row(id)
      if (!found) return undefined
      const token = await openProjectToken(secret, found.id, found.tokenSealed)
      return token ? { project: toProject(found), token } : undefined
    },
    async remove(id) {
      const removed = await db().delete(consoleProjects).where(eq(consoleProjects.id, id)).returning({ id: consoleProjects.id })
      return removed.length > 0
    },
  }
}
