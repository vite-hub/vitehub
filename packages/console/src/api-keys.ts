import { and, desc, eq } from "drizzle-orm"
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { authSqliteSchema } from "vite-hub/auth/schema"

import type { ConsoleDatabase } from "./projects.ts"

const { member, organization, user } = authSqliteSchema

/**
 * One row for each API key. The key itself is never stored: `key_hash` is its SHA-256 digest, and `start` is the first
 * characters after the prefix, so a person can tell keys apart. A key acts for the person who made it, in one team, and
 * only on the projects in `project_ids` when it has them. Deleting the person or the team deletes their keys.
 */
export const consoleApiKeys = sqliteTable("console_api_keys", {
  id: text("id").primaryKey(),
  teamId: text("team_id").notNull().references(() => authSqliteSchema.organization.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => authSqliteSchema.user.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  start: text("start").notNull(),
  keyHash: text("key_hash").notNull(),
  projectIds: text("project_ids", { mode: "json" }).$type<string[]>(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  lastUsedAt: integer("last_used_at"),
}, table => [
  uniqueIndex("console_api_keys_key_hash_uidx").on(table.keyHash),
  index("console_api_keys_user_idx").on(table.userId),
])

/**
 * The device codes of RFC 8628, the table of Better Auth's `deviceAuthorization()`. Two columns are the Console's own:
 * `client_name`, the machine that asked, such as `vitehub CLI on ada-laptop`, which the `/device` page shows, and
 * `team_id`, the team that the person chose when they approved.
 */
export const consoleDeviceCodes = sqliteTable("device_code", {
  id: text("id").primaryKey(),
  deviceCode: text("device_code").notNull(),
  userCode: text("user_code").notNull(),
  userId: text("user_id").references(() => authSqliteSchema.user.id, { onDelete: "cascade" }),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  status: text("status").notNull(),
  lastPolledAt: integer("last_polled_at", { mode: "timestamp_ms" }),
  pollingInterval: integer("polling_interval"),
  clientId: text("client_id"),
  scope: text("scope"),
  clientName: text("client_name"),
  teamId: text("team_id").references(() => authSqliteSchema.organization.id, { onDelete: "cascade" }),
}, table => [
  uniqueIndex("device_code_device_code_uidx").on(table.deviceCode),
  uniqueIndex("device_code_user_code_uidx").on(table.userCode),
  index("device_code_user_idx").on(table.userId),
])

/** Every API key starts with this, so a secret scanner and the Console tell it apart from a session token. */
export const consoleApiKeyPrefix = "vhk_"

/** The key lifetime that the device flow gives, and the default of a key made in the Console. */
export const defaultApiKeyDays = 90

/** The longest key lifetime. */
export const maxApiKeyDays = 365

const day = 86_400_000

/** An API key as its owner sees it. It never holds the key. */
export interface ConsoleApiKey {
  id: string
  name: string
  /** The prefix and the first characters of the key, such as `vhk_Ab3x`. */
  start: string
  team: { id: string, name: string }
  /** The projects that the key may open, or `null` for every project of the team. */
  projectIds: string[] | null
  createdAt: number
  expiresAt: number
  lastUsedAt: number | null
}

/** The SHA-256 digest of a key, as hex. Keys are random, so a plain digest is enough. */
export async function hashConsoleApiKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")
}

function randomKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return consoleApiKeyPrefix + btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export interface CreateConsoleApiKeyInput {
  userId: string
  teamId: string
  name: string
  projectIds?: readonly string[] | null
  days?: number
}

/**
 * Make a key for a member of a team. The answer holds the key once: show it to the person and forget it. Returns
 * `undefined` when the person is not a member of the team.
 */
export async function createConsoleApiKey(db: ConsoleDatabase, input: CreateConsoleApiKeyInput, now = Date.now()): Promise<{ apiKey: ConsoleApiKey, key: string } | undefined> {
  const [team] = await db.select({ id: organization.id, name: organization.name }).from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(and(eq(member.organizationId, input.teamId), eq(member.userId, input.userId)))
    .limit(1)
  if (!team) return undefined
  const key = randomKey()
  const projectIds = input.projectIds?.length ? [...new Set(input.projectIds)] : null
  const values = {
    id: crypto.randomUUID(),
    teamId: input.teamId,
    userId: input.userId,
    name: input.name.trim().slice(0, 100) || "API key",
    start: key.slice(0, consoleApiKeyPrefix.length + 4),
    keyHash: await hashConsoleApiKey(key),
    projectIds,
    createdAt: now,
    expiresAt: now + Math.min(Math.max(input.days ?? defaultApiKeyDays, 1), maxApiKeyDays) * day,
    lastUsedAt: null,
  }
  await db.insert(consoleApiKeys).values(values)
  const { keyHash: _hash, teamId: _team, userId: _user, ...shown } = values
  return { apiKey: { ...shown, team: { id: String(team.id), name: String(team.name) } }, key }
}

/** The keys of a person, in every team, the newest first. Expired keys stay in the list until the person revokes them. */
export async function listConsoleApiKeys(db: ConsoleDatabase, userId: string): Promise<ConsoleApiKey[]> {
  const rows = await db.select({ key: consoleApiKeys, teamName: organization.name }).from(consoleApiKeys)
    .innerJoin(organization, eq(organization.id, consoleApiKeys.teamId))
    .where(eq(consoleApiKeys.userId, userId))
    .orderBy(desc(consoleApiKeys.createdAt), desc(consoleApiKeys.id))
  return rows.map(({ key, teamName }) => ({
    id: key.id,
    name: key.name,
    start: key.start,
    team: { id: key.teamId, name: String(teamName) },
    projectIds: key.projectIds ?? null,
    createdAt: key.createdAt,
    expiresAt: key.expiresAt,
    lastUsedAt: key.lastUsedAt,
  }))
}

/** Delete a key of the person. Returns `false` when the person has no such key. */
export async function revokeConsoleApiKey(db: ConsoleDatabase, userId: string, id: string): Promise<boolean> {
  const removed = await db.delete(consoleApiKeys).where(and(eq(consoleApiKeys.id, id), eq(consoleApiKeys.userId, userId))).returning({ id: consoleApiKeys.id })
  return removed.length > 0
}

/** Who a valid key acts for: the person, their roles in the key's team now, and the projects that it may open. */
export interface ConsoleApiKeyCaller {
  keyId: string
  user: { id: string, name: string, email: string }
  teamId: string
  teamName: string
  roles: string[]
  projectIds: string[] | null
  expiresAt: number
}

/** The API key of a request: `Authorization: Bearer vhk_...`. Other bearer tokens are not API keys. */
export function consoleApiKeyOf(request: Request): string | undefined {
  const match = /^Bearer\s+(\S+)$/iu.exec(request.headers.get("authorization") ?? "")
  return match?.[1]?.startsWith(consoleApiKeyPrefix) ? match[1] : undefined
}

/**
 * The caller of a key, or `undefined` when the key is unknown, revoked, expired, or the person is no longer a member of
 * the key's team. The roles come from the membership now, so a member who loses the admin role loses it for the key too.
 */
export async function verifyConsoleApiKey(db: ConsoleDatabase, key: string, now = Date.now()): Promise<ConsoleApiKeyCaller | undefined> {
  if (!key.startsWith(consoleApiKeyPrefix)) return undefined
  const [found] = await db.select({ key: consoleApiKeys, role: member.role, name: user.name, email: user.email, teamName: organization.name }).from(consoleApiKeys)
    .innerJoin(member, and(eq(member.organizationId, consoleApiKeys.teamId), eq(member.userId, consoleApiKeys.userId)))
    .innerJoin(organization, eq(organization.id, consoleApiKeys.teamId))
    .innerJoin(user, eq(user.id, consoleApiKeys.userId))
    .where(eq(consoleApiKeys.keyHash, await hashConsoleApiKey(key)))
    .limit(1)
  if (!found || found.key.expiresAt <= now) return undefined
  if (!found.key.lastUsedAt || now - found.key.lastUsedAt > 60_000) await db.update(consoleApiKeys).set({ lastUsedAt: now }).where(eq(consoleApiKeys.id, found.key.id))
  return {
    keyId: found.key.id,
    user: { id: found.key.userId, name: String(found.name), email: String(found.email) },
    teamId: found.key.teamId,
    teamName: String(found.teamName),
    roles: String(found.role).split(",").map(role => role.trim()),
    projectIds: found.key.projectIds ?? null,
    expiresAt: found.key.expiresAt,
  }
}
