import { and, asc, eq } from "drizzle-orm"
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

import { createConsoleKeyPair } from "@vite-hub/internal/console-signature"
import { authSqliteSchema } from "vite-hub/auth/schema"

import { consoleApiKeys, consoleDeviceCodes } from "./api-keys.ts"
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

/**
 * The MCP connections that a person made from the Console page of a project. `sealed` is the whole connection, with its
 * tokens, encrypted with `VITEHUB_CONSOLE_SECRET`. Unlinking the project or deleting the person deletes them.
 */
export const consoleMcpConnections = sqliteTable("console_mcp_connections", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => authSqliteSchema.user.id, { onDelete: "cascade" }),
  projectId: text("project_id").notNull().references(() => consoleProjects.id, { onDelete: "cascade" }),
  sealed: text("sealed").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, table => [index("console_mcp_connections_owner_idx").on(table.userId, table.projectId)])

/**
 * The OAuth clients that the Console registered with authorization servers, one for each server, callback, and MCP
 * endpoint. `id` is a SHA-256 hash of those three, and `sealed` is the registration, encrypted like a connection.
 */
export const consoleMcpClients = sqliteTable("console_mcp_clients", {
  id: text("id").primaryKey(),
  sealed: text("sealed").notNull(),
  createdAt: integer("created_at").notNull(),
})

/** The tables of the Console, for `defineDatabase({ schema })`. `deviceCode` is the key that Better Auth looks up. */
export const consoleSchema = { consoleProjects, consoleApiKeys, deviceCode: consoleDeviceCodes, consoleMcpConnections, consoleMcpClients }

/** A Drizzle SQLite Database: libSQL, D1, or the Database of a ViteHub app. */
export type ConsoleDatabase = SQLiteAsyncDatabase<"async", unknown, AnyRelations>

interface ConsoleProjectDetails {
  id: string
  teamId: string
  url: string
  label: string | null
  createdBy: string
  createdAt: number
}

/** A project as the Console sees it. A site registered for Hosted Comments has no signing key. */
export type ConsoleProject = ConsoleProjectDetails & ({ publicKey: string, keyVariable: string } | { publicKey: null, keyVariable: null })

export type LinkedConsoleProject = ConsoleProjectDetails & { publicKey: string, keyVariable: string }
type ProjectInput = Pick<ConsoleProjectDetails, "url" | "createdBy"> & { label?: string }

/** The key name of a project: `CONSOLE_` and the first 8 hex digits of its id. The app reads `VITEHUB_CONSOLE_KEY_<name>`. */
export function projectKeyName(id: string): string {
  return `CONSOLE_${id.replace(/[^0-9a-f]/gi, "").slice(0, 8).toUpperCase()}`
}

function toProject(row: typeof consoleProjects.$inferSelect): ConsoleProject {
  return row.publicKey ? linkedProject(row) : { ...projectDetails(row), publicKey: null, keyVariable: null }
}

function linkedProject(row: typeof consoleProjects.$inferSelect): LinkedConsoleProject {
  return { ...projectDetails(row), publicKey: row.publicKey, keyVariable: `VITEHUB_CONSOLE_KEY_${projectKeyName(row.id)}` }
}

function projectDetails({ id, teamId, url, label, createdBy, createdAt }: typeof consoleProjects.$inferSelect): ConsoleProjectDetails {
  return { id, teamId, url, label, createdBy, createdAt }
}

/** The linked projects of a team, the oldest first. Listing needs no secret: it never opens a private key. */
export async function listConsoleProjects(db: ConsoleDatabase, teamId: string): Promise<ConsoleProject[]> {
  return (await db.select().from(consoleProjects).where(eq(consoleProjects.teamId, teamId)).orderBy(asc(consoleProjects.createdAt), asc(consoleProjects.id))).map(toProject)
}

/** A linked project in any team that the person is a member of, whatever team the session has open. */
export async function memberConsoleProject(db: ConsoleDatabase, userId: string, id: string): Promise<ConsoleProject | undefined> {
  const [row] = await db.select({ project: consoleProjects }).from(consoleProjects)
    .innerJoin(authSqliteSchema.member, and(eq(authSqliteSchema.member.organizationId, consoleProjects.teamId), eq(authSqliteSchema.member.userId, userId)))
    .where(eq(consoleProjects.id, id)).limit(1)
  return row ? toProject(row.project) : undefined
}

/** The linked projects of one team. Each method sees only the projects of that team. */
export interface ConsoleProjectStore {
  list(): Promise<ConsoleProject[]>
  get(id: string): Promise<ConsoleProject | undefined>
  /** Link a project with a new key pair. Returns `undefined` when the team already linked the URL. */
  create(input: ProjectInput): Promise<LinkedConsoleProject | undefined>
  registerSite(input: ProjectInput): Promise<ConsoleProject | undefined>
  /** Change the label of a project. An empty label removes it. Returns `undefined` when the team has no such project. */
  rename(id: string, label: string | null): Promise<ConsoleProject | undefined>
  /** The project and its signing key, or `undefined` when there is no such project or the secret cannot open its key. */
  target(id: string): Promise<{ project: LinkedConsoleProject, key: ConsoleSigningKey } | undefined>
  remove(id: string): Promise<boolean>
}

/**
 * The store of an API key that names projects: it lists and opens only those, and it links no new project. `null` is a
 * key for every project of the team, which gets the store as it is.
 */
export function scopeConsoleProjectStore(store: ConsoleProjectStore, projectIds: readonly string[] | null): ConsoleProjectStore {
  if (!projectIds) return store
  const allowed = new Set(projectIds)
  return {
    list: async () => (await store.list()).filter(project => allowed.has(project.id)),
    get: async id => allowed.has(id) ? store.get(id) : undefined,
    create: async () => undefined,
    registerSite: async () => undefined,
    rename: async (id, label) => allowed.has(id) ? store.rename(id, label) : undefined,
    target: async id => allowed.has(id) ? store.target(id) : undefined,
    remove: async id => allowed.has(id) && store.remove(id),
  }
}

export function createConsoleProjectStore(database: ConsoleDatabase | (() => ConsoleDatabase), secret: string, teamId: string): ConsoleProjectStore {
  const db = typeof database === "function" ? database : () => database
  const inTeam = eq(consoleProjects.teamId, teamId)
  const row = async (id: string) => (await db().select().from(consoleProjects).where(and(inTeam, eq(consoleProjects.id, id))).limit(1))[0]
  const details = ({ createdBy, label, url }: ProjectInput): ConsoleProjectDetails => ({
    id: crypto.randomUUID(), teamId, url, label: label?.trim() || null, createdBy, createdAt: Date.now(),
  })
  const insert = async (values: typeof consoleProjects.$inferInsert) =>
    (await db().insert(consoleProjects).values(values).onConflictDoNothing({ target: [consoleProjects.teamId, consoleProjects.url] }).returning())[0]
  return {
    list: () => listConsoleProjects(db(), teamId),
    async get(id) {
      const found = await row(id)
      return found ? toProject(found) : undefined
    },
    async create(input) {
      const project = details(input)
      const pair = await createConsoleKeyPair()
      const created = await insert({
        ...project,
        keySealed: await sealProjectKey(secret, project.id, pair.privateKey),
        publicKey: pair.publicKey,
      })
      return created ? linkedProject(created) : undefined
    },
    async registerSite(input) {
      const created = await insert({ ...details(input), keySealed: "", publicKey: "" })
      return created ? toProject(created) : undefined
    },
    async rename(id, label) {
      const [renamed] = await db().update(consoleProjects).set({ label: label?.trim() || null }).where(and(inTeam, eq(consoleProjects.id, id))).returning()
      return renamed ? toProject(renamed) : undefined
    },
    async target(id) {
      const found = await row(id)
      if (!found?.publicKey) return undefined
      const privateKey = await openProjectKey(secret, found.id, found.keySealed)
      return privateKey ? { project: linkedProject(found), key: { name: projectKeyName(found.id), privateKey } } : undefined
    },
    async remove(id) {
      const removed = await db().delete(consoleProjects).where(and(inTeam, eq(consoleProjects.id, id))).returning({ id: consoleProjects.id })
      return removed.length > 0
    },
  }
}
