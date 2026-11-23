import { OAuthClientInformationSchema, OAuthTokensSchema } from "@modelcontextprotocol/sdk/shared/auth.js"
import { and, asc, eq } from "drizzle-orm"
import { z } from "zod"

import { consoleMcpClients, consoleMcpConnections } from "./projects.ts"
import { openConsoleValue, sealConsoleValue } from "./token-box.ts"

import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js"
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js"
import type { ConsoleMcpAuth, ConsoleMcpIdentity, ConsoleMcpServerInfo, ConsoleMcpStatus } from "./mcp-client-types.ts"
import type { ConsoleDatabase } from "./projects.ts"

export interface PendingAuthorization {
  expiresAt: number
  prompt?: "login"
  state: string
  /** The authorization URL that the browser opens. */
  url?: string
  verifier?: string
}

export interface StoredOAuth {
  /** The registration of this grant, kept even when another first sign-in registers at the same time. */
  client?: OAuthClientInformationMixed
  discovery?: OAuthDiscoveryState
  pending?: PendingAuthorization
  /** When the tokens arrived, so `expires_in` becomes a date. */
  receivedAt?: number
  redirectUrl: string
  tokens?: OAuthTokens
}

/** One MCP connection of one person on one project, with its credentials. Only the Console server reads it. */
export interface StoredConnection {
  auth: Exclude<ConsoleMcpAuth, "console">
  bearer?: string
  createdAt: number
  error?: string
  id: string
  identity?: ConsoleMcpIdentity
  label: string
  /** The person named the connection. Otherwise a sign-in names it after its account. */
  labelled: boolean
  oauth?: StoredOAuth
  projectId: string
  protocolVersion?: string
  sameOrigin: boolean
  server?: ConsoleMcpServerInfo
  sessionId?: string
  status: ConsoleMcpStatus
  url: string
  usedAt?: number
  userId: string
}

/** Where the MCP client of the Console keeps connections and OAuth client registrations. */
export interface ConsoleMcpRecords {
  client: (key: string) => Promise<OAuthClientInformationMixed | undefined>
  connection: (userId: string, projectId: string, id: string) => Promise<StoredConnection | undefined>
  connections: (userId: string, projectId: string) => Promise<StoredConnection[]>
  remove: (connection: StoredConnection) => Promise<void>
  removeClient: (key: string) => Promise<void>
  save: (connection: StoredConnection) => Promise<void>
  saveClient: (key: string, client: OAuthClientInformationMixed) => Promise<void>
}

const optionalText = z.string().optional()
const clientSchema = z.custom<OAuthClientInformationMixed>(value => OAuthClientInformationSchema.safeParse(value).success)
const connectionSchema = z.object({
  auth: z.enum(["bearer", "none", "oauth"]),
  bearer: optionalText,
  createdAt: z.number(),
  error: optionalText,
  id: z.string(),
  identity: z.object({ email: optionalText, name: optionalText, picture: optionalText, subject: optionalText }).optional(),
  label: z.string(),
  labelled: z.boolean(),
  oauth: z.object({
    client: clientSchema.optional(),
    discovery: z.custom<OAuthDiscoveryState>(value => value instanceof Object && typeof Reflect.get(value, "authorizationServerUrl") === "string").optional(),
    pending: z.object({ expiresAt: z.number(), prompt: z.literal("login").optional(), state: z.string(), url: optionalText, verifier: optionalText }).optional(),
    receivedAt: z.number().optional(),
    redirectUrl: z.string(),
    tokens: z.custom<OAuthTokens>(value => OAuthTokensSchema.safeParse(value).success).optional(),
  }).optional(),
  projectId: z.string(),
  protocolVersion: optionalText,
  sameOrigin: z.boolean(),
  server: z.custom<ConsoleMcpServerInfo>(value => value instanceof Object && typeof Reflect.get(value, "name") === "string" && Reflect.get(value, "capabilities") instanceof Object).optional(),
  sessionId: optionalText,
  status: z.enum(["authorizing", "connected", "failed", "signed-out"]),
  url: z.string(),
  usedAt: z.number().optional(),
  userId: z.string(),
})

async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("")
}

const connectionContext = (connection: Pick<StoredConnection, "id" | "projectId" | "userId">) => `mcp connection\n${connection.userId}\n${connection.projectId}\n${connection.id}`
const clientContext = (id: string) => `mcp client\n${id}`

/**
 * Records in the Console database. Each row holds one value sealed with `VITEHUB_CONSOLE_SECRET`, bound to its person,
 * project, and id, so a value copied to another row does not open. A value that does not open, such as one sealed
 * before the secret changed, reads as missing.
 */
export function databaseConsoleMcpRecords(db: ConsoleDatabase, secret: string): ConsoleMcpRecords {
  async function open<Schema extends z.ZodType>(context: string, sealed: string, schema: Schema): Promise<z.infer<Schema> | undefined> {
    const opened = await openConsoleValue(secret, "mcp records", context, sealed)
    if (opened === undefined) return undefined
    let value: unknown
    try {
      value = JSON.parse(opened)
    }
    catch {
      return undefined
    }
    const parsed = schema.safeParse(value)
    return parsed.success ? parsed.data : undefined
  }
  const read = async (row: typeof consoleMcpConnections.$inferSelect): Promise<StoredConnection | undefined> => {
    const connection = await open(connectionContext(row), row.sealed, connectionSchema)
    return connection?.id === row.id && connection.userId === row.userId && connection.projectId === row.projectId ? connection : undefined
  }
  return {
    client: async (key) => {
      const id = await sha256(key)
      const [row] = await db.select().from(consoleMcpClients).where(eq(consoleMcpClients.id, id)).limit(1)
      return row ? open(clientContext(id), row.sealed, clientSchema) : undefined
    },
    connection: async (userId, projectId, id) => {
      const [row] = await db.select().from(consoleMcpConnections)
        .where(and(eq(consoleMcpConnections.id, id), eq(consoleMcpConnections.userId, userId), eq(consoleMcpConnections.projectId, projectId))).limit(1)
      return row ? read(row) : undefined
    },
    connections: async (userId, projectId) => {
      const rows = await db.select().from(consoleMcpConnections)
        .where(and(eq(consoleMcpConnections.userId, userId), eq(consoleMcpConnections.projectId, projectId)))
        .orderBy(asc(consoleMcpConnections.createdAt), asc(consoleMcpConnections.id))
      return (await Promise.all(rows.map(read))).filter(connection => connection !== undefined)
    },
    remove: async (connection) => {
      await db.delete(consoleMcpConnections).where(and(eq(consoleMcpConnections.id, connection.id), eq(consoleMcpConnections.userId, connection.userId)))
    },
    removeClient: async (key) => {
      await db.delete(consoleMcpClients).where(eq(consoleMcpClients.id, await sha256(key)))
    },
    save: async (connection) => {
      const sealed = await sealConsoleValue(secret, "mcp records", connectionContext(connection), JSON.stringify(connection))
      const now = Date.now()
      await db.insert(consoleMcpConnections)
        .values({ createdAt: connection.createdAt, id: connection.id, projectId: connection.projectId, sealed, updatedAt: now, userId: connection.userId })
        .onConflictDoUpdate({ set: { sealed, updatedAt: now }, target: consoleMcpConnections.id })
    },
    saveClient: async (key, client) => {
      const id = await sha256(key)
      const sealed = await sealConsoleValue(secret, "mcp records", clientContext(id), JSON.stringify(client))
      await db.insert(consoleMcpClients).values({ createdAt: Date.now(), id, sealed }).onConflictDoUpdate({ set: { sealed }, target: consoleMcpClients.id })
    },
  }
}
