import { execFile } from "node:child_process"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"

import { afterEach, describe, expect, it } from "vitest"

import { readAuthExistingTables } from "../src/existing-tables.ts"
import { authSqlName, resolveAuthTableSpecs } from "../src/table-specs.ts"

import type { AuthSchemaOptions } from "../src/table-specs.ts"

const execFileAsync = promisify(execFile)
const roots: string[] = []
const schemaModule = new URL("../src/schema.ts", import.meta.url).pathname
const drizzleKit = new URL("../node_modules/drizzle-kit/bin.cjs", import.meta.url).pathname

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

// Better Auth tables that an app wrote by hand before `authDatabase()`, as ViteHub Finance did: column defaults that
// Better Auth does not declare, unique indexes from Drizzle Kit 0.x where Auth declares UNIQUE, and no foreign keys on
// the OAuth tables. `budget` is a table of the app that references `user` and `organization`.
const handSchema = `
import { sql } from "drizzle-orm"
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

const now = sql\`(cast(unixepoch('subsecond') * 1000 as integer))\`
const createdAt = () => integer("created_at", { mode: "timestamp_ms" }).default(now).notNull()
const updatedAt = () => integer("updated_at", { mode: "timestamp_ms" }).default(now).notNull()

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  emailVerified: integer("email_verified", { mode: "boolean" }).default(false).notNull(),
  image: text("image"),
  role: text("role").notNull().default("user"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, table => [uniqueIndex("user_email_unique").on(table.email)])

export const session = sqliteTable("session", {
  id: text("id").primaryKey(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  token: text("token").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  activeOrganizationId: text("active_organization_id"),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
}, table => [index("session_user_idx").on(table.userId), uniqueIndex("session_token_unique").on(table.token)])

export const account = sqliteTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
  refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
  scope: text("scope"),
  password: text("password"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, table => [index("account_user_idx").on(table.userId)])

export const verification = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, table => [index("verification_identifier_idx").on(table.identifier)])

export const organization = sqliteTable("organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  logo: text("logo"),
  metadata: text("metadata"),
  createdAt: createdAt(),
}, table => [uniqueIndex("organization_slug_idx").on(table.slug)])

export const member = sqliteTable("member", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("member"),
  createdAt: createdAt(),
}, table => [uniqueIndex("member_user_organization_idx").on(table.userId, table.organizationId)])

export const oauthClient = sqliteTable("oauth_client", {
  id: text("id").primaryKey(),
  clientId: text("client_id").notNull(),
  clientSecret: text("client_secret"),
  userId: text("user_id"),
  redirectUris: text("redirect_uris").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }),
}, table => [uniqueIndex("oauth_client_client_id_unique").on(table.clientId), index("oauth_client_user_id_idx").on(table.userId)])

export const budget = sqliteTable("budget", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  householdId: text("household_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
})
`

const options: AuthSchemaOptions = { additionalFields: { user: { language: { type: "string" } } } }

/** The schema of the app after the move: the Auth tables and the same `budget` table, with foreign keys to Auth's tables. */
function authSchema(existing: unknown) {
  return `
import { sqliteTable, text } from "drizzle-orm/sqlite-core"
import { createAuthSqliteSchema } from ${JSON.stringify(schemaModule)}

export const { user, session, account, verification, organization, member, invitation, passkey, jwks, oauthClient, oauthResource, oauthClientResource, oauthRefreshToken, oauthAccessToken, oauthConsent, oauthClientAssertion, rateLimit } = createAuthSqliteSchema(${JSON.stringify(options)}${existing ? `, ${JSON.stringify(existing)}` : ""})

export const budget = sqliteTable("budget", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  householdId: text("household_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
})
`
}

async function generate(root: string, schema: string, name: string): Promise<string> {
  await writeFile(join(root, "schema.ts"), schema)
  await execFileAsync(process.execPath, [drizzleKit, "generate", "--config", "drizzle.config.ts", "--name", name], { cwd: root })
  const folder = (await readdir(join(root, "migrations"))).find(entry => entry.endsWith(`_${name}`))
  return folder ? await readFile(join(root, "migrations", folder, "migration.sql"), "utf8") : ""
}

async function handProject() {
  const root = await mkdtemp(join(import.meta.dirname, ".existing-tables-"))
  roots.push(root)
  await writeFile(join(root, "drizzle.config.ts"), `export default { dialect: "sqlite", schema: "./schema.ts", out: "./migrations" }\n`)
  await generate(root, handSchema, "hand")
  return root
}

const tableNames = Object.keys(resolveAuthTableSpecs(options)).map(authSqlName)

describe("authDatabase() on a Database with Better Auth tables", () => {
  // Every SQLite table rebuild drops the old table. D1 runs ON DELETE CASCADE when it drops `organization`, which
  // deleted the `member` and `budget` rows of ViteHub Finance.
  it("rebuilds the hand-written tables without the existing tables", async () => {
    const root = await handProject()
    const sql = await generate(root, authSchema(undefined), "auth")
    expect(sql).toContain("CREATE TABLE `__new_organization`")
    expect(sql).toContain("DROP TABLE `organization`;")
  }, 120_000)

  it("adds columns, tables, and indexes and rebuilds no table with the existing tables", async () => {
    const root = await handProject()
    const existing = readAuthExistingTables(join(root, "migrations"), tableNames)
    expect(Object.keys(existing ?? {}).sort()).toEqual(["account", "member", "oauth_client", "organization", "session", "user", "verification"])
    const sql = await generate(root, authSchema(existing), "auth")
    expect(sql).not.toMatch(/__new_|DROP TABLE|DROP INDEX|DROP COLUMN/)
    const statements = sql.split("--> statement-breakpoint").map(statement => statement.trim().split("\n")[0]).filter(Boolean)
    expect(statements.every(statement => /^(?:CREATE TABLE|ALTER TABLE `\w+` ADD|CREATE (?:UNIQUE )?INDEX)/.test(statement!)), sql).toBe(true)
    expect(existing?.user?.columns.role).toMatchObject({ notNull: true })
    expect(sql).not.toContain("ALTER TABLE `user` ADD `role`")
    expect(sql).toContain("ALTER TABLE `user` ADD `language` text;")
    expect(sql).toContain("CREATE TABLE `rate_limit`")

    // The next migration has nothing to do: the tables keep what the new snapshot has.
    const next = readAuthExistingTables(join(root, "migrations"), tableNames)
    expect(await generate(root, authSchema(next), "again")).toBe("")
  }, 120_000)

  it("reads nothing from a folder without a SQLite snapshot", () => {
    expect(readAuthExistingTables(join(import.meta.dirname, "no-such-migrations"), tableNames)).toBeUndefined()
  })
})
