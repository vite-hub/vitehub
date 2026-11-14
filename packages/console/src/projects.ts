import { and, asc, eq } from "drizzle-orm"
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

import { createConsoleKeyPair } from "@vite-hub/internal/console-signature"
import { authSqliteSchema } from "vite-hub/auth/schema"

import { openProjectKey, sealProjectKey } from "./token-box.ts"

import type { ConsoleSigningKey } from "@vite-hub/internal/console-signature"

import type { AnyRelations } from "drizzle-orm"
import type { SQLiteAsyncDatabase } from "drizzle-orm/sqlite-core"

/**
 * One row for each linked project. A project belongs to one team, the Better Auth organization in `team_id`. Each link
 * has its own Ed25519 key pair: `key_sealed` is the private key, encrypted with `VITEHUB_CONSOLE_SECRET`, and
 * `public_key` is the value that the project keeps, so the Console can show it again.
 */
export const consoleProjects = sqliteTable("console_projects", {
  id: text("id").primaryKey(),
  // Deleting a team deletes its projects.
  teamId: text("team_id").notNull().references(() => authSqliteSchema.organization.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  label: text("label"),
  keySealed: text("key_sealed").notNull(),
  publicKey: text("public_key").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at").notNull(),
}, table => [
  index("console_projects_team_idx").on(table.teamId),
  uniqueIndex("console_projects_team_url_uidx").on(table.teamId, table.url),
])

/** The tables of the Console, for `defineDatabase({ schema })`. */
export const consoleSchema = { consoleProjects }

/** A Drizzle SQLite Database: libSQL, D1, or the Database of a ViteHub app. */
export type ConsoleDatabase = SQLiteAsyncDatabase<"async", unknown, AnyRelations>

/** A linked project as the Console page sees it. It never holds the private key. */
export interface ConsoleProject {
  id: string
  teamId: string
  url: string
  label: string | null
  /** The Ed25519 public key of the link, base64url. The project keeps it in the variable `keyVariable`. */
  publicKey: string
  /**
   * The variable of the project that holds `publicKey`, such as `VITEHUB_CONSOLE_KEY_CONSOLE_3F9A12BC`. Each linked
   * project has its own, so two teams can link one app, and unlinking one leaves the other.
   */
  keyVariable: string
  createdBy: string
  createdAt: number
}

/** The key name of a project: `CONSOLE_` and the first 8 hex digits of its id. The app reads `VITEHUB_CONSOLE_KEY_<name>`. */
export function projectKeyName(id: string): string {
  return `CONSOLE_${id.replace(/[^0-9a-f]/gi, "").slice(0, 8).toUpperCase()}`
}

function toProject(row: typeof consoleProjects.$inferSelect): ConsoleProject {
  return { id: row.id, teamId: row.teamId, url: row.url, label: row.label, publicKey: row.publicKey, keyVariable: `VITEHUB_CONSOLE_KEY_${projectKeyName(row.id)}`, createdBy: row.createdBy, createdAt: row.createdAt }
}

/** The linked projects of one team. Each method sees only the projects of that team. */
export interface ConsoleProjectStore {
  list(): Promise<ConsoleProject[]>
  get(id: string): Promise<ConsoleProject | undefined>
  /** Link a project with a new key pair. Returns `undefined` when the team already linked the URL. */
  create(input: { url: string, label?: string, createdBy: string }): Promise<ConsoleProject | undefined>
  /** The project and its signing key, or `undefined` when there is no such project or the secret cannot open its key. */
  target(id: string): Promise<{ project: ConsoleProject, key: ConsoleSigningKey } | undefined>
  remove(id: string): Promise<boolean>
}

export function createConsoleProjectStore(database: ConsoleDatabase | (() => ConsoleDatabase), secret: string, teamId: string): ConsoleProjectStore {
  const db = typeof database === "function" ? database : () => database
  const inTeam = eq(consoleProjects.teamId, teamId)
  const row = async (id: string) => (await db().select().from(consoleProjects).where(and(inTeam, eq(consoleProjects.id, id))).limit(1))[0]
  return {
    async list() {
      return (await db().select().from(consoleProjects).where(inTeam).orderBy(asc(consoleProjects.createdAt), asc(consoleProjects.id))).map(toProject)
    },
    async get(id) {
      const found = await row(id)
      return found ? toProject(found) : undefined
    },
    async create({ url, label, createdBy }) {
      const [existing] = await db().select({ id: consoleProjects.id }).from(consoleProjects).where(and(inTeam, eq(consoleProjects.url, url))).limit(1)
      if (existing) return undefined
      const id = crypto.randomUUID()
      const pair = await createConsoleKeyPair()
      const values = {
        id,
        teamId,
        url,
        label: label?.trim() || null,
        keySealed: await sealProjectKey(secret, id, pair.privateKey),
        publicKey: pair.publicKey,
        createdBy,
        createdAt: Date.now(),
      }
      await db().insert(consoleProjects).values(values)
      return toProject(values)
    },
    async target(id) {
      const found = await row(id)
      if (!found) return undefined
      const privateKey = await openProjectKey(secret, found.id, found.keySealed)
      return privateKey ? { project: toProject(found), key: { name: projectKeyName(found.id), privateKey } } : undefined
    },
    async remove(id) {
      const removed = await db().delete(consoleProjects).where(and(inTeam, eq(consoleProjects.id, id))).returning({ id: consoleProjects.id })
      return removed.length > 0
    },
  }
}
