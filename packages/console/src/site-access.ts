import { and, desc, eq, exists, gt, isNull, ne, notExists, sql } from "drizzle-orm"
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { authSqliteSchema } from "vite-hub/auth/schema"

import { encodeConsoleBase64url } from "@vite-hub/internal/console-signature"
import { userAgentDevice } from "@vite-hub/internal/runtime/user-agent"
import { signSiteToken, siteTokenUrl } from "@vite-hub/internal/site-token"

import { consoleProjects } from "./projects.ts"

import type { ConsoleSigningKey } from "@vite-hub/internal/console-signature"
import type { SiteAccessPolicy } from "@vite-hub/internal/site-token"
import type { ConsoleDatabase, ConsoleProject } from "./projects.ts"

const { member, user: authUser } = authSqliteSchema

/**
 * One row for each browser that Site access knows by a pass: a cookie of the Console origin that holds a random secret,
 * of which the row keeps only the SHA-256 digest. A guest gets a pass when they open an invite, and a member gets one
 * when they open a one-time code, such as on a phone. While the pass is good, the Console signs a new Site access token
 * for that browser each time the app asks. A revoke or the end of `expires_at` stops new tokens. `expires_at` moves
 * forward with each token. A member's pass also needs the membership of the team. `roles` are the roles of a guest's
 * invite, and for a member the roles of the last token. A link makes one pass: the pass of a link is made in the
 * statement that checks the link, so it opens once.
 */
export const consoleSiteGrants = sqliteTable("console_site_grants", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => consoleProjects.id, { onDelete: "cascade" }),
  kind: text("kind").$type<"member" | "guest" | "comments">().notNull(),
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
 * `/go/<secret>`. The row keeps only the SHA-256 digest of the secret. A link opens once: it is used when a pass has
 * its `link_id`, so the pass is the only write.
 */
export const consoleSiteLinks = sqliteTable("console_site_links", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => consoleProjects.id, { onDelete: "cascade" }),
  kind: text("kind").$type<"invite" | "code" | "comments">().notNull(),
  secretHash: text("secret_hash").notNull(),
  userId: text("user_id").references(() => authSqliteSchema.user.id, { onDelete: "cascade" }),
  name: text("name"),
  roles: text("roles", { mode: "json" }).$type<string[]>(),
  path: text("path").notNull(),
  createdBy: text("created_by").notNull(),
  createdByName: text("created_by_name").notNull(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
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
/** The longest guest name. It is the author of their comments. */
export const siteGuestNameLength = 64

const siteCodeLifetime = 10 * 60_000
const sitePassLifetime = 7 * 86_400_000

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

async function siteSecretHash(secret: string): Promise<string> {
  return encodeConsoleBase64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret))))
}

function newSecret(): string {
  return encodeConsoleBase64url(crypto.getRandomValues(new Uint8Array(32)))
}

/** The roles of a member: `console` and the roles of the app's {@link SiteAccessPolicy}. */
export function siteMemberRoles(policy: SiteAccessPolicy): string[] {
  return [siteConsoleRole, ...policy.roles.map(role => role.id).filter(role => role !== siteConsoleRole)]
}

/**
 * The roles of a guest invite, or the message that says why they are refused. A member gives only roles of their policy,
 * and never a `membersOnly` role.
 */
export function readGuestRoles(roles: readonly string[], policy: SiteAccessPolicy): string[] | { error: string } {
  const unique = [...new Set(roles)]
  if (unique.includes(siteConsoleRole)) return { error: "Guests never get the Console. Invite them with the roles of the page tools, such as comments-write." }
  const membersOnly = unique.filter(role => policy.roles.some(known => known.id === role && known.membersOnly))
  if (membersOnly.length) return { error: `Only members get ${membersOnly.join(", ")}. Guests never get it.` }
  const known = new Set(policy.roles.map(role => role.id))
  const unknown = unique.filter(role => !known.has(role))
  if (unknown.length) return { error: `Site access gives you no role ${unknown.join(", ")} to give.` }
  if (!unique.length) return { error: "Pick at least one role." }
  return unique
}

/** The cookie of the Console origin that holds the pass of one project. `__Host-` needs HTTPS, so a local Console uses the plain name. */
export function sitePassCookie(projectId: string, secure: boolean, surface: "site" | "comments" = "site"): string {
  return `${secure ? "__Host-" : ""}vitehub-${surface}-pass-${projectId}`
}

/** The `set-cookie` value of a pass, or of its removal when `secret` is empty. */
export function sitePassSetCookie(projectId: string, secret: string, secure: boolean, surface: "site" | "comments" = "site", expiresAt = Date.now() + sitePassLifetime): string {
  const maxAge = secret ? Math.max(0, Math.ceil((expiresAt - Date.now()) / 1_000)) : 0
  return `${sitePassCookie(projectId, secure, surface)}=${secret}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`
}

async function isTeamMember(db: ConsoleDatabase, teamId: string, userId: string): Promise<boolean> {
  const [row] = await db.select({ id: member.id }).from(member).where(and(eq(member.organizationId, teamId), eq(member.userId, userId))).limit(1)
  return Boolean(row)
}

async function personOf(db: ConsoleDatabase, userId: string): Promise<ConsoleSitePerson | undefined> {
  const [row] = await db.select({ email: authUser.email, image: authUser.image, name: authUser.name }).from(authUser).where(eq(authUser.id, userId)).limit(1)
  if (!row) return undefined
  return { id: userId, name: row.name || row.email, email: row.email, ...(row.image ? { image: row.image } : {}) }
}

/** The person of a member of the project's team, or `undefined` when they are no member. */
export async function siteMember(db: ConsoleDatabase, project: Pick<ConsoleProject, "teamId">, userId: string): Promise<ConsoleSitePerson | undefined> {
  if (!await isTeamMember(db, project.teamId, userId)) return undefined
  return await personOf(db, userId)
}

/**
 * The URL that ends a visit: `<app>/_vitehub/site?token=…`, with a token that the key of the link signs for the person,
 * the roles, the state hash that the app sent, and the app path to open.
 */
export async function siteTokenLocation(input: { project: Pick<ConsoleProject, "url">, key: ConsoleSigningKey, person: ConsoleSitePerson, roles: string[], state: string, path: string }): Promise<string> {
  const { person } = input
  const token = await signSiteToken({
    key: input.key,
    claims: { aud: input.project.url, sub: person.id, name: person.name, ...(person.email ? { email: person.email } : {}), ...(person.image ? { image: person.image } : {}), roles: input.roles, kind: "site", path: input.path, state: input.state },
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
  /** Keep the roles of the last token of a member's pass, which the Site access page shows. */
  issued(id: string, roles: string[]): Promise<void>
  /** The browsers with a good pass, most recently used first, with the roles of the guest invite or the member's last token. */
  sessions(): Promise<ConsoleSiteSession[]>
  /** Revoke a pass: the Console signs no new token for it. Returns the kind of the pass, or `undefined` when there is none. */
  revoke(id: string): Promise<{ kind: "member" | "guest" } | undefined>
}

export type ConsoleSiteGrantRow = typeof consoleSiteGrants.$inferSelect

function iso(time: number): string {
  return new Date(time).toISOString()
}

function linkUnused(db: ConsoleDatabase) {
  return notExists(db.select({ id: consoleSiteGrants.id }).from(consoleSiteGrants).where(eq(consoleSiteGrants.linkId, consoleSiteLinks.id)))
}

export function createConsoleSiteStore(db: ConsoleDatabase, projectId: string, surface: "site" | "comments" = "site"): ConsoleSiteStore {
  const inProject = (table: typeof consoleSiteGrants | typeof consoleSiteLinks) => eq(table.projectId, projectId)
  const inviteKind = surface === "comments" ? "comments" : "invite"
  const inSurface = surface === "comments" ? eq(consoleSiteGrants.kind, "comments") : ne(consoleSiteGrants.kind, "comments")
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
      const now = Date.now()
      const row = { id: crypto.randomUUID(), projectId, kind: inviteKind, secretHash: await siteSecretHash(secret), userId: null, name, roles, path, createdBy: createdBy.id, createdByName: createdBy.name, createdAt: now, expiresAt: now + days * 86_400_000, revokedAt: null } satisfies typeof consoleSiteLinks.$inferSelect
      await db.insert(consoleSiteLinks).values(row)
      return { secret, invite: toInvite(row) }
    },
    async invites() {
      const rows = await db.select().from(consoleSiteLinks)
        .where(and(inProject(consoleSiteLinks), eq(consoleSiteLinks.kind, inviteKind), linkUnused(db), isNull(consoleSiteLinks.revokedAt), gt(consoleSiteLinks.expiresAt, Date.now())))
        .orderBy(desc(consoleSiteLinks.createdAt))
      return rows.map(toInvite)
    },
    async revokeInvite(id) {
      const revoked = await db.update(consoleSiteLinks).set({ revokedAt: Date.now() })
        .where(and(inProject(consoleSiteLinks), eq(consoleSiteLinks.id, id), eq(consoleSiteLinks.kind, inviteKind), linkUnused(db), isNull(consoleSiteLinks.revokedAt)))
        .returning({ id: consoleSiteLinks.id })
      return revoked.length > 0
    },
    async code({ userId, path, createdBy }) {
      const secret = newSecret()
      const now = Date.now()
      const expiresAt = now + siteCodeLifetime
      await db.insert(consoleSiteLinks).values({ id: crypto.randomUUID(), projectId, kind: "code", secretHash: await siteSecretHash(secret), userId, path, createdBy: createdBy.id, createdByName: createdBy.name, createdAt: now, expiresAt })
      return { secret, expiresAt: iso(expiresAt) }
    },
    async pass(secret) {
      const now = Date.now()
      const [grant] = await db.update(consoleSiteGrants).set({ lastSeenAt: now, ...(surface === "site" ? { expiresAt: now + sitePassLifetime } : {}) })
        .where(and(inProject(consoleSiteGrants), inSurface, eq(consoleSiteGrants.secretHash, await siteSecretHash(secret)), isNull(consoleSiteGrants.revokedAt), gt(consoleSiteGrants.expiresAt, now)))
        .returning()
      return grant
    },
    async issued(id, roles) {
      await db.update(consoleSiteGrants).set({ roles }).where(and(inProject(consoleSiteGrants), eq(consoleSiteGrants.id, id), eq(consoleSiteGrants.kind, "member")))
    },
    async sessions() {
      const rows = await db.select({ grant: consoleSiteGrants, email: authUser.email, image: authUser.image, userName: authUser.name }).from(consoleSiteGrants)
        .leftJoin(authUser, eq(authUser.id, consoleSiteGrants.userId))
        .where(and(inProject(consoleSiteGrants), inSurface, isNull(consoleSiteGrants.revokedAt), gt(consoleSiteGrants.expiresAt, Date.now())))
        .orderBy(desc(consoleSiteGrants.lastSeenAt))
      return rows.map(({ grant, email, image, userName }) => ({
        id: grant.id,
        kind: grant.kind === "member" ? "member" : "guest",
        person: { id: grant.userId ?? grant.id, name: userName || grant.name, ...(grant.kind === "member" && email ? { email } : {}), ...(grant.kind === "member" && image ? { image } : {}) },
        grants: grant.roles,
        device: grant.device,
        createdAt: iso(grant.createdAt),
        lastSeenAt: iso(grant.lastSeenAt),
        expiresAt: iso(grant.expiresAt),
      }))
    },
    async revoke(id) {
      const [revoked] = await db.update(consoleSiteGrants).set({ revokedAt: Date.now() })
        .where(and(inProject(consoleSiteGrants), inSurface, eq(consoleSiteGrants.id, id), isNull(consoleSiteGrants.revokedAt)))
        .returning({ kind: consoleSiteGrants.kind })
      return revoked && { kind: revoked.kind === "member" ? "member" : "guest" }
    },
  }
}

/** The link that a browser opens, as `openConsoleSiteLink()` passes it to `allow` before it makes a pass. */
export interface ConsoleSiteLinkOwner {
  projectId: string
  teamId: string
  path: string
  kind: "invite" | "code" | "comments"
  userId: string | null
  roles: string[] | null
  createdBy: string
}

/**
 * Open an invite or a code once, and make a pass for the browser. `allow` checks the link first, such as the current
 * Site access of a code's member; a refusal leaves the link open. One statement makes the pass, and only while the link
 * is open, has no pass, and for a code, its person is a member of the team. The pass is the only write, so a failed
 * write uses no link and a link makes one pass. Returns the project, the pass secret, and the app path; `forbidden` when
 * `allow` refuses or the code's person left the team; or `undefined` for a used, revoked, expired, or unknown link.
 */
export async function openConsoleSiteLink(db: ConsoleDatabase, input: { kind: ConsoleSiteLinkOwner["kind"], secret: string, userAgent: string, allow: (link: ConsoleSiteLinkOwner) => Promise<boolean> }): Promise<{ projectId: string, pass: string, path: string, expiresAt: number } | "forbidden" | undefined> {
  const { kind } = input
  const now = Date.now()
  const open = and(eq(consoleSiteLinks.kind, kind), eq(consoleSiteLinks.secretHash, await siteSecretHash(input.secret)), linkUnused(db), isNull(consoleSiteLinks.revokedAt), gt(consoleSiteLinks.expiresAt, now))
  const [found] = await db.select({ link: consoleSiteLinks, teamId: consoleProjects.teamId }).from(consoleSiteLinks)
    .innerJoin(consoleProjects, eq(consoleProjects.id, consoleSiteLinks.projectId)).where(open).limit(1)
  if (!found) return undefined
  const { link, teamId } = found
  const person = kind === "code" && link.userId ? await siteMember(db, { teamId }, link.userId) : undefined
  if (kind === "code" && !person) return "forbidden"
  if (!await input.allow({ projectId: link.projectId, teamId, path: link.path, kind, userId: link.userId, roles: link.roles, createdBy: link.createdBy })) return "forbidden"
  const pass = newSecret()
  const grant: ConsoleSiteGrantRow = {
    id: crypto.randomUUID(),
    projectId: link.projectId,
    kind: kind === "comments" ? "comments" : kind === "code" ? "member" : "guest",
    userId: kind === "code" ? link.userId : null,
    name: person?.name ?? link.name ?? "Guest",
    roles: kind === "code" ? [] : link.roles ?? [],
    secretHash: await siteSecretHash(pass),
    device: userAgentDevice(input.userAgent),
    linkId: link.id,
    createdBy: link.createdBy,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: kind === "comments" ? link.expiresAt : now + sitePassLifetime,
    revokedAt: null,
  }
  const value = <T>(field: T) => sql<T>`${field instanceof Object ? JSON.stringify(field) : field}`
  const inTeam = link.userId ? exists(db.select({ id: member.id }).from(member).where(and(eq(member.organizationId, teamId), eq(member.userId, link.userId)))) : undefined
  const created = await db.insert(consoleSiteGrants).select(db.select({
    id: value(grant.id).as("id"),
    projectId: consoleSiteLinks.projectId,
    kind: value(grant.kind).as("kind"),
    userId: consoleSiteLinks.userId,
    name: value(grant.name).as("name"),
    roles: value(grant.roles).as("roles"),
    secretHash: value(grant.secretHash).as("secret_hash"),
    device: value(grant.device).as("device"),
    linkId: consoleSiteLinks.id,
    createdBy: consoleSiteLinks.createdBy,
    createdAt: value(now).as("created_at"),
    lastSeenAt: value(now).as("last_seen_at"),
    expiresAt: value(grant.expiresAt).as("expires_at"),
    revokedAt: sql<null>`null`.as("revoked_at"),
  }).from(consoleSiteLinks).where(and(eq(consoleSiteLinks.id, link.id), open, kind === "code" ? inTeam : undefined))).returning({ id: consoleSiteGrants.id })
  if (!created.length) return kind === "code" && !await isTeamMember(db, teamId, link.userId ?? "") ? "forbidden" : undefined
  return { projectId: link.projectId, pass, path: link.path, expiresAt: grant.expiresAt }
}
