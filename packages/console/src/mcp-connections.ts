import { and, eq, inArray } from "drizzle-orm"
import { authSqliteSchema } from "vite-hub/auth/schema"

import type { ConsoleDatabase } from "./projects.ts"

const { oauthAccessToken, oauthClient, oauthConsent, oauthRefreshToken } = authSqliteSchema

/** An MCP client, such as T3 Code, that a person allowed to use the ViteHub MCP at `/mcp/account` as them. */
export interface ConsoleMcpConnection {
  clientId: string
  /** The name that the client gave when it registered, such as `T3 Code`. */
  name: string | null
  connectedAt: number | null
  /** When the Console last gave the client a token. */
  lastUsedAt: number | null
}

const time = (value: Date | null) => value ? value.getTime() : null
const latest = (current: number | null, next: number | null) => next !== null && (current === null || next > current) ? next : current

/**
 * The MCP clients that a person connected: each client with a consent or a token of the person, the most recent use
 * first. The OAuth provider of the Console serves only `/mcp/account`, so every client here uses the account MCP.
 */
export async function listConsoleMcpConnections(db: ConsoleDatabase, userId: string): Promise<ConsoleMcpConnection[]> {
  const consents = await db.select({ at: oauthConsent.createdAt, clientId: oauthConsent.clientId }).from(oauthConsent).where(eq(oauthConsent.userId, userId))
  const tokens = [
    ...await db.select({ at: oauthAccessToken.createdAt, clientId: oauthAccessToken.clientId }).from(oauthAccessToken).where(eq(oauthAccessToken.userId, userId)),
    ...await db.select({ at: oauthRefreshToken.createdAt, clientId: oauthRefreshToken.clientId }).from(oauthRefreshToken).where(eq(oauthRefreshToken.userId, userId)),
  ]
  const found = new Map<string, ConsoleMcpConnection>()
  const entry = (clientId: string) => {
    const known = found.get(clientId)
    if (known) return known
    const created: ConsoleMcpConnection = { clientId, connectedAt: null, lastUsedAt: null, name: null }
    found.set(clientId, created)
    return created
  }
  for (const consent of consents) {
    const connection = entry(consent.clientId)
    connection.connectedAt = latest(connection.connectedAt, time(consent.at))
  }
  for (const token of tokens) {
    const connection = entry(token.clientId)
    connection.lastUsedAt = latest(connection.lastUsedAt, time(token.at))
  }
  if (!found.size) return []
  const clients = await db.select({ clientId: oauthClient.clientId, disabled: oauthClient.disabled, name: oauthClient.name }).from(oauthClient).where(inArray(oauthClient.clientId, [...found.keys()]))
  return clients.flatMap((client) => {
    const connection = found.get(client.clientId)
    return connection && !client.disabled ? [{ ...connection, name: client.name || null }] : []
  })
    .sort((a, b) => (b.lastUsedAt ?? b.connectedAt ?? 0) - (a.lastUsedAt ?? a.connectedAt ?? 0))
}

/**
 * Disconnect an MCP client from a person: delete their consent and tokens for it. When no one else uses the client, the
 * Console deletes it too, so the access tokens that it already holds stop working at once. Returns `false` when the
 * person had no such connection.
 */
export async function revokeConsoleMcpConnection(db: ConsoleDatabase, userId: string, clientId: string): Promise<boolean> {
  const removed = [
    ...await db.delete(oauthAccessToken).where(and(eq(oauthAccessToken.clientId, clientId), eq(oauthAccessToken.userId, userId))).returning({ id: oauthAccessToken.id }),
    ...await db.delete(oauthRefreshToken).where(and(eq(oauthRefreshToken.clientId, clientId), eq(oauthRefreshToken.userId, userId))).returning({ id: oauthRefreshToken.id }),
    ...await db.delete(oauthConsent).where(and(eq(oauthConsent.clientId, clientId), eq(oauthConsent.userId, userId))).returning({ id: oauthConsent.id }),
  ]
  if (!removed.length) return false
  const inUse = (await Promise.all([oauthAccessToken, oauthRefreshToken, oauthConsent].map(table => db.select({ id: table.id }).from(table).where(eq(table.clientId, clientId)).limit(1)))).flat()
  if (!inUse.length) await db.delete(oauthClient).where(eq(oauthClient.clientId, clientId))
  return true
}
