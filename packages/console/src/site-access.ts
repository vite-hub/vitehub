import { and, desc, eq, gt, isNull } from "drizzle-orm"
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { authSqliteSchema } from "vite-hub/auth/schema"

import { encodeConsoleBase64url } from "@vite-hub/internal/console-signature"
import { userAgentDevice } from "@vite-hub/internal/runtime/user-agent"
import { siteAccessRoles, signSiteToken, siteTokenUrl } from "@vite-hub/internal/site-token"

import { consoleProjects } from "./projects.ts"

import type { ConsoleSigningKey } from "@vite-hub/internal/console-signature"
import type { SiteAccessRole } from "@vite-hub/internal/site-token"
import type { ConsoleDatabase, ConsoleProject } from "./projects.ts"

const { member, user: authUser } = authSqliteSchema

/**
 * One row for each browser that Site access knows by a pass: a cookie of the Console origin that holds a random secret,
 * of which the row keeps only the SHA-256 digest. A guest gets a pass when they open an invite, and a member gets one
 * when they open a one-time code, such as on a phone. While the pass is good, the Console signs a new Site access token
 * for that browser each time the app asks. A revoke or the end of `expires_at` stops new tokens. `expires_at` moves
 * forward with each token. A member's pass also needs the membership of the team, and gives the roles of a member.
 */
export const consoleSiteGrants = sqliteTable("console_site_grants", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => consoleProjects.id, { onDelete: "cascade" }),
  kind: text("kind").$type<"member" | "guest">().notNull(),
  userId: text("user_id").references(() => authSqliteSchema.user.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  roles: text("roles", { mode: "json" }).$type<string[]>().notNull(),
  secretHash: text("secret_hash").notNull(),
  device: text("device").notNull(),
  linkId: text("link_id"),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at").notNull(),
  lastSeenAt: integer("last_seen_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  revokedAt: integer("revoked_at"),
}, table => [
  uniqueIndex("console_site_grants_secret_hash_uidx").on(table.secretHash),
  index("console_site_grants_project_idx").on(table.projectId),
])

/**
 * One row for each link that makes a pass: a guest invite, `/i/<secret>`, or a member's one-time code,
 * `/go/<secret>`. The row keeps only the SHA-256 digest of the secret. A link opens once: the first open sets
 * `used_at` in the same statement that checks it.
 */
export const consoleSiteLinks = sqliteTable("console_site_links", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => consoleProjects.id, { onDelete: "cascade" }),
  kind: text("kind").$type<"invite" | "code">().notNull(),
  secretHash: text("secret_hash").notNull(),
  userId: text("user_id").references(() => authSqliteSchema.user.id, { onDelete: "cascade" }),
  name: text("name"),
  roles: text("roles", { mode: "json" }).$type<string[]>(),
  path: text("path").notNull(),
  createdBy: text("created_by").notNull(),
  createdByName: text("created_by_name").notNull(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  usedAt: integer("used_at"),
  revokedAt: integer("revoked_at"),
}, table => [
  uniqueIndex("console_site_links_secret_hash_uidx").on(table.secretHash),
  index("console_site_links_project_idx").on(table.projectId),
])

/** The Site access tables, for `defineDatabase({ schema })` next to `consoleSchema`. */
export const consoleSiteSchema = { consoleSiteGrants, consoleSiteLinks }

/** The role of a member that opens the Console from the pill. Guests never get it. */
export const siteConsoleRole = "console"
/** The invite lifetimes that a member can pick, in days. */
export const siteInviteDays = [1, 7, 30] as const
/** A one-time code is scanned with another device, which takes longer than a click, so it lasts 10 minutes. */
export const siteCodeLifetime = 10 * 60_000
/** A pass is good this long after the last token that it got. */
export const sitePassLifetime = 7 * 86_400_000
/** The longest guest name. It is the author of their comments. */
export const siteGuestNameLength = 64

/** The person that a pass or a Console session signs in to the app. */
export interface ConsoleSitePerson {
  id: string
  name: string
  email?: string
  image?: string
}

/** A browser with a pass, as the Site access page shows it. */
export interface ConsoleSiteSession {
  id: string
  kind: "member" | "guest"
  person: ConsoleSitePerson
  grants: string[]
  device: string
  createdAt: string
  lastSeenAt: string
  expiresAt: string
}

/** A guest invite that nobody opened yet. */
export interface ConsoleSiteInvite {
  id: string
  name: string
  grants: string[]
  path: string
  expiresAt: string
  createdBy: { id: string, name: string }
}

/** A member of the team, who opens the site through the membership. */
export interface ConsoleSiteMember {
  id: string
  name: string
  email: string
  image?: string
  role: string
}

/** The SHA-256 digest of a pass or link secret, base64url. Secrets are random, so a plain digest is enough. */
export async function siteSecretHash(secret: string): Promise<string> {
  return encodeConsoleBase64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret))))
}

function newSecret(): string {
  return encodeConsoleBase64url(crypto.getRandomValues(new Uint8Array(32)))
}

/** The roles of a member: every role of Site access. */
export function siteMemberRoles(): string[] {
  return siteAccessRoles.map(role => role.id)
}

/** The roles that a member can give a guest: every role but the members-only ones. */
export function siteGuestRoles(): SiteAccessRole[] {
  return siteAccessRoles.filter(role => !role.membersOnly)
}

/** The roles of a guest invite, or the message that says why they are refused. */
export function readGuestRoles(roles: readonly string[]): string[] | { error: string } {
  const unique = [...new Set(roles)]
  if (unique.includes(siteConsoleRole)) return { error: "Guests never get the Console. Invite them with the roles of the page tools, such as comments-write." }
  const known = new Set(siteGuestRoles().map(role => role.id))
  const unknown = unique.filter(role => !known.has(role))
  if (unknown.length) return { error: `Site access gives no role ${unknown.join(", ")}.` }
  if (!unique.length) return { error: "Pick at least one role." }
  return unique
}

/** The cookie of the Console origin that holds the pass of one project. `__Host-` needs HTTPS, so a local Console uses the plain name. */
export function sitePassCookie(projectId: string, secure: boolean): string {
  return `${secure ? "__Host-" : ""}vitehub-site-pass-${projectId}`
}

/** The `set-cookie` value of a pass, or of its removal when `secret` is empty. */
export function sitePassSetCookie(projectId: string, secret: string, secure: boolean): string {
  const maxAge = secret ? Math.floor(sitePassLifetime / 1_000) : 0
  return `${sitePassCookie(projectId, secure)}=${secret}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`
}

/** Whether a person is a member of a team. A member's pass and Console session give the site only while this holds. */
export async function isTeamMember(db: ConsoleDatabase, teamId: string, userId: string): Promise<boolean> {
  const [row] = await db.select({ id: member.id }).from(member).where(and(eq(member.organizationId, teamId), eq(member.userId, userId))).limit(1)
  return Boolean(row)
}

async function personOf(db: ConsoleDatabase, userId: string): Promise<ConsoleSitePerson | undefined> {
  const [row] = await db.select({ email: authUser.email, image: authUser.image, name: authUser.name }).from(authUser).where(eq(authUser.id, userId)).limit(1)
  if (!row) return undefined
  return { id: userId, name: row.name || row.email, email: row.email, ...(row.image ? { image: row.image } : {}) }
}

/** The person and the roles of a member of the project's team, or `undefined` when they are no member. */
export async function siteMember(db: ConsoleDatabase, project: Pick<ConsoleProject, "teamId">, userId: string): Promise<{ person: ConsoleSitePerson, roles: string[] } | undefined> {
  if (!await isTeamMember(db, project.teamId, userId)) return undefined
  const person = await personOf(db, userId)
  return person ? { person, roles: siteMemberRoles() } : undefined
}

/**
 * The URL that ends a visit: `<app>/_vitehub/site?token=…`, with a token that the key of the link signs for the person,
 * the roles, the state hash that the app sent, and the app path to open.
 */
export async function siteTokenLocation(input: { project: Pick<ConsoleProject, "url">, key: ConsoleSigningKey, person: ConsoleSitePerson, roles: string[], state: string, path: string, now?: number }): Promise<string> {
  const { person } = input
  const token = await signSiteToken({
    key: input.key,
    claims: { aud: input.project.url, sub: person.id, name: person.name, ...(person.email ? { email: person.email } : {}), ...(person.image ? { image: person.image } : {}), roles: input.roles, kind: "site", path: input.path, state: input.state },
    ...(input.now === undefined ? {} : { now: input.now }),
  })
  return siteTokenUrl(input.project.url, token)
}

/** The Site access state of one project: its passes, invites, and one-time codes. */
export interface ConsoleSiteStore {
  /** A guest invite. Returns the secret of `/i/<secret>`, which the Console shows once. */
  invite(input: { name: string, roles: string[], days: number, path: string, createdBy: { id: string, name: string } }): Promise<{ secret: string, invite: ConsoleSiteInvite }>
  /** The guest invites that nobody opened, revoked, or let expire, newest first. */
  invites(): Promise<ConsoleSiteInvite[]>
  revokeInvite(id: string): Promise<boolean>
  /** A one-time code for a member, `/go/<secret>`. It lasts 10 minutes. */
  code(input: { userId: string, path: string, createdBy: { id: string, name: string } }): Promise<{ secret: string, expiresAt: string }>
  /** The grant of a good pass, with its expiry moved forward, or `undefined`. A member's grant is checked by the caller. */
  pass(secret: string): Promise<ConsoleSiteGrantRow | undefined>
  /** The browsers with a good pass, most recently used first. */
  sessions(): Promise<ConsoleSiteSession[]>
  /** Revoke a pass: the Console signs no new token for it. Returns the kind of the pass, or `undefined` when there is none. */
  revoke(id: string): Promise<{ kind: "member" | "guest" } | undefined>
}

export type ConsoleSiteGrantRow = typeof consoleSiteGrants.$inferSelect

function iso(time: number): string {
  return new Date(time).toISOString()
}

export function createConsoleSiteStore(database: ConsoleDatabase | (() => ConsoleDatabase), projectId: string, clock: () => number = Date.now): ConsoleSiteStore {
  const db = typeof database === "function" ? database : () => database
  const inProject = (table: typeof consoleSiteGrants | typeof consoleSiteLinks) => eq(table.projectId, projectId)
  const toInvite = (row: typeof consoleSiteLinks.$inferSelect): ConsoleSiteInvite => ({
    id: row.id,
    name: row.name ?? "",
    grants: row.roles ?? [],
    path: row.path,
    expiresAt: iso(row.expiresAt),
    createdBy: { id: row.createdBy, name: row.createdByName },
  })
  return {
    async invite({ name, roles, days, path, createdBy }) {
      const secret = newSecret()
      const now = clock()
      const row = { id: crypto.randomUUID(), projectId, kind: "invite" as const, secretHash: await siteSecretHash(secret), userId: null, name, roles, path, createdBy: createdBy.id, createdByName: createdBy.name, createdAt: now, expiresAt: now + days * 86_400_000, usedAt: null, revokedAt: null }
      await db().insert(consoleSiteLinks).values(row)
      return { secret, invite: toInvite(row) }
    },
    async invites() {
      const rows = await db().select().from(consoleSiteLinks)
        .where(and(inProject(consoleSiteLinks), eq(consoleSiteLinks.kind, "invite"), isNull(consoleSiteLinks.usedAt), isNull(consoleSiteLinks.revokedAt), gt(consoleSiteLinks.expiresAt, clock())))
        .orderBy(desc(consoleSiteLinks.createdAt))
      return rows.map(toInvite)
    },
    async revokeInvite(id) {
      const revoked = await db().update(consoleSiteLinks).set({ revokedAt: clock() })
        .where(and(inProject(consoleSiteLinks), eq(consoleSiteLinks.id, id), eq(consoleSiteLinks.kind, "invite"), isNull(consoleSiteLinks.usedAt), isNull(consoleSiteLinks.revokedAt)))
        .returning({ id: consoleSiteLinks.id })
      return revoked.length > 0
    },
    async code({ userId, path, createdBy }) {
      const secret = newSecret()
      const now = clock()
      const expiresAt = now + siteCodeLifetime
      await db().insert(consoleSiteLinks).values({ id: crypto.randomUUID(), projectId, kind: "code", secretHash: await siteSecretHash(secret), userId, path, createdBy: createdBy.id, createdByName: createdBy.name, createdAt: now, expiresAt })
      return { secret, expiresAt: iso(expiresAt) }
    },
    async pass(secret) {
      const now = clock()
      const [grant] = await db().update(consoleSiteGrants).set({ lastSeenAt: now, expiresAt: now + sitePassLifetime })
        .where(and(inProject(consoleSiteGrants), eq(consoleSiteGrants.secretHash, await siteSecretHash(secret)), isNull(consoleSiteGrants.revokedAt), gt(consoleSiteGrants.expiresAt, now)))
        .returning()
      return grant
    },
    async sessions() {
      const rows = await db().select({ grant: consoleSiteGrants, email: authUser.email, image: authUser.image, userName: authUser.name }).from(consoleSiteGrants)
        .leftJoin(authUser, eq(authUser.id, consoleSiteGrants.userId))
        .where(and(inProject(consoleSiteGrants), isNull(consoleSiteGrants.revokedAt), gt(consoleSiteGrants.expiresAt, clock())))
        .orderBy(desc(consoleSiteGrants.lastSeenAt))
      return rows.map(({ grant, email, image, userName }) => ({
        id: grant.id,
        kind: grant.kind,
        person: { id: grant.userId ?? grant.id, name: userName || grant.name, ...(grant.kind === "member" && email ? { email } : {}), ...(grant.kind === "member" && image ? { image } : {}) },
        grants: grant.kind === "member" ? siteMemberRoles() : grant.roles,
        device: grant.device,
        createdAt: iso(grant.createdAt),
        lastSeenAt: iso(grant.lastSeenAt),
        expiresAt: iso(grant.expiresAt),
      }))
    },
    async revoke(id) {
      const [revoked] = await db().update(consoleSiteGrants).set({ revokedAt: clock() })
        .where(and(inProject(consoleSiteGrants), eq(consoleSiteGrants.id, id), isNull(consoleSiteGrants.revokedAt)))
        .returning({ kind: consoleSiteGrants.kind })
      return revoked
    },
  }
}

/**
 * Open an invite or a code once: the link is used in the same statement that checks it, and a pass is made for the
 * browser. Returns the project, the pass secret, and the app path, or `undefined` for a used, revoked, expired, or
 * unknown link.
 */
export async function openConsoleSiteLink(db: ConsoleDatabase, kind: "invite" | "code", secret: string, userAgent: string, now = Date.now()): Promise<{ projectId: string, pass: string, path: string, grant: ConsoleSiteGrantRow } | undefined> {
  const [link] = await db.update(consoleSiteLinks).set({ usedAt: now })
    .where(and(eq(consoleSiteLinks.kind, kind), eq(consoleSiteLinks.secretHash, await siteSecretHash(secret)), isNull(consoleSiteLinks.usedAt), isNull(consoleSiteLinks.revokedAt), gt(consoleSiteLinks.expiresAt, now)))
    .returning()
  if (!link) return undefined
  const person = kind === "code" && link.userId ? await personOf(db, link.userId) : undefined
  if (kind === "code" && !person) return undefined
  const pass = newSecret()
  const grant: ConsoleSiteGrantRow = {
    id: crypto.randomUUID(),
    projectId: link.projectId,
    kind: kind === "code" ? "member" : "guest",
    userId: kind === "code" ? link.userId : null,
    name: person?.name ?? link.name ?? "Guest",
    roles: kind === "code" ? [] : link.roles ?? [],
    secretHash: await siteSecretHash(pass),
    device: userAgentDevice(userAgent),
    linkId: link.id,
    createdBy: link.createdBy,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: now + sitePassLifetime,
    revokedAt: null,
  }
  await db.insert(consoleSiteGrants).values(grant)
  return { projectId: link.projectId, pass, path: link.path, grant }
}

/** The person and roles of a good pass: a guest as invited, a member while they are in the team. */
export async function sitePassPerson(db: ConsoleDatabase, project: Pick<ConsoleProject, "teamId">, grant: ConsoleSiteGrantRow): Promise<{ person: ConsoleSitePerson, roles: string[] } | undefined> {
  if (grant.kind === "guest") return { person: { id: `site-guest:${grant.id}`, name: grant.name }, roles: grant.roles }
  return grant.userId ? await siteMember(db, project, grant.userId) : undefined
}

/** The members of a team, who open the site through the membership, by name. */
export async function siteTeamMembers(db: ConsoleDatabase, teamId: string): Promise<ConsoleSiteMember[]> {
  const rows = await db.select({ id: authUser.id, name: authUser.name, email: authUser.email, image: authUser.image, role: member.role }).from(member)
    .innerJoin(authUser, eq(authUser.id, member.userId))
    .where(eq(member.organizationId, teamId))
  return rows
    .map(row => ({ id: row.id, name: row.name || row.email, email: row.email, ...(row.image ? { image: row.image } : {}), role: String(row.role) }))
    .sort((a, b) => a.name.localeCompare(b.name))
}
