import { and, eq, gt, isNotNull, isNull, lte } from "drizzle-orm"
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { authSqliteSchema } from "vite-hub/auth/schema"

import { encodeConsoleBase64url } from "@vite-hub/internal/console-signature"

import { consoleProjects } from "./projects.ts"
import { consoleSiteGrants } from "./site-access.ts"

import type { ConsoleDatabase } from "./projects.ts"

/**
 * One row for each sign-in of the hosted Comments embed. `/comments/<project>/authorize` writes the row with the
 * SHA-256 digest of a one-time code and the PKCE challenge of the embed. `/comments/<project>/redeem` uses the code
 * once: one statement clears `code_hash`, and the row then keeps only the SHA-256 digest of the bearer token. The
 * person is a member of the team (`user_id`), or the Site access pass that the browser had (`grant_id`). A revoked
 * pass, a deleted user, or an unlinked project deletes the row.
 */
export const consoleCommentSessions = sqliteTable("console_comment_sessions", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => consoleProjects.id, { onDelete: "cascade" }),
  userId: text("user_id").references(() => authSqliteSchema.user.id, { onDelete: "cascade" }),
  grantId: text("grant_id").references(() => consoleSiteGrants.id, { onDelete: "cascade" }),
  challenge: text("challenge").notNull(),
  codeHash: text("code_hash"),
  tokenHash: text("token_hash"),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
}, table => [
  uniqueIndex("console_comment_sessions_code_hash_uidx").on(table.codeHash),
  uniqueIndex("console_comment_sessions_token_hash_uidx").on(table.tokenHash),
  index("console_comment_sessions_project_idx").on(table.projectId, table.expiresAt),
])

/** The sessions of the hosted Comments embed, for `defineDatabase({ schema })` next to `consoleSchema`. */
export const consoleCommentSessionSchema = { consoleCommentSessions }

/** A code lasts 2 minutes: the embed redeems it when the page opens again. */
export const hostedCommentsCodeLifetime = 2 * 60_000
/** A bearer token lasts 12 hours. Each call also checks the membership or the pass again. */
export const hostedCommentsSessionLifetime = 12 * 3_600_000

/** Who signed in: a member of the team, or a Site access pass. A member's pass has both. */
export interface HostedCommentsHolder {
  userId: string | null
  grantId: string | null
}

export type HostedCommentsSessionRow = typeof consoleCommentSessions.$inferSelect

const secretPattern = /^[\w-]{43}$/
const verifierPattern = /^[\w.~-]{43,128}$/

/** A code, a token, or a PKCE S256 challenge: 32 bytes in base64url. */
export function isHostedCommentsSecret(value: unknown): value is string {
  return typeof value === "string" && secretPattern.test(value)
}

/** A PKCE code verifier of RFC 7636: 43 to 128 unreserved characters. */
export function isHostedCommentsVerifier(value: unknown): value is string {
  return typeof value === "string" && verifierPattern.test(value)
}

async function sha256(value: string): Promise<string> {
  return encodeConsoleBase64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))))
}

function newSecret(): string {
  return encodeConsoleBase64url(crypto.getRandomValues(new Uint8Array(32)))
}

/** Write a one-time code for `holder` and the PKCE `challenge`, and delete the ended sessions of the project. */
export async function issueHostedCommentsCode(db: ConsoleDatabase, input: { projectId: string, holder: HostedCommentsHolder, challenge: string, now: number }): Promise<string> {
  const { projectId, now } = input
  await db.delete(consoleCommentSessions).where(and(eq(consoleCommentSessions.projectId, projectId), lte(consoleCommentSessions.expiresAt, now)))
  const code = newSecret()
  await db.insert(consoleCommentSessions).values({
    id: crypto.randomUUID(),
    projectId,
    userId: input.holder.userId,
    grantId: input.holder.grantId,
    challenge: input.challenge,
    codeHash: await sha256(code),
    tokenHash: null,
    createdAt: now,
    expiresAt: now + hostedCommentsCodeLifetime,
  })
  return code
}

/**
 * Use a code once and return a bearer token. One statement clears the code and sets the token. Returns `undefined` for an unknown, used,
 * or expired code, a code of another project, or a wrong verifier.
 */
export async function redeemHostedCommentsCode(db: ConsoleDatabase, input: { projectId: string, code: string, verifier: string, now: number }): Promise<{ token: string, session: HostedCommentsSessionRow } | undefined> {
  const { now } = input
  const token = newSecret()
  const [session] = await db.update(consoleCommentSessions).set({ codeHash: null, tokenHash: await sha256(token), expiresAt: now + hostedCommentsSessionLifetime })
    .where(and(
      eq(consoleCommentSessions.projectId, input.projectId),
      eq(consoleCommentSessions.codeHash, await sha256(input.code)),
      eq(consoleCommentSessions.challenge, await sha256(input.verifier)),
      isNull(consoleCommentSessions.tokenHash),
      gt(consoleCommentSessions.expiresAt, now),
    ))
    .returning()
  return session && { token, session }
}

/** The session of a bearer token of the project, or `undefined` when it is unknown or expired. */
export async function hostedCommentsSession(db: ConsoleDatabase, input: { projectId: string, token: string, now: number }): Promise<HostedCommentsSessionRow | undefined> {
  const [session] = await db.select().from(consoleCommentSessions).where(and(
    eq(consoleCommentSessions.projectId, input.projectId),
    eq(consoleCommentSessions.tokenHash, await sha256(input.token)),
    gt(consoleCommentSessions.expiresAt, input.now),
  )).limit(1)
  return session
}

/** The session of a bearer token of any project, or `undefined` when it is unknown or expired. */
export async function hostedCommentsTokenSession(db: ConsoleDatabase, input: { token: string, now: number }): Promise<HostedCommentsSessionRow | undefined> {
  const [session] = await db.select().from(consoleCommentSessions).where(and(
    eq(consoleCommentSessions.tokenHash, await sha256(input.token)),
    gt(consoleCommentSessions.expiresAt, input.now),
  )).limit(1)
  return session
}

/** The sessions of the project that have a bearer token, also the expired ones. */
export async function hostedCommentsTokenSessions(db: ConsoleDatabase, projectId: string): Promise<HostedCommentsSessionRow[]> {
  return await db.select().from(consoleCommentSessions).where(and(
    eq(consoleCommentSessions.projectId, projectId),
    isNotNull(consoleCommentSessions.tokenHash),
  ))
}

/** End a session, such as when its person lost access. */
export async function endHostedCommentsSession(db: ConsoleDatabase, id: string): Promise<void> {
  await db.delete(consoleCommentSessions).where(eq(consoleCommentSessions.id, id))
}
