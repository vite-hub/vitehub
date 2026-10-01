import { importSealKey, seal, sealedPayloadPattern, sealKeyId, unseal } from "@vite-hub/env/seal"
import { sql } from "drizzle-orm"
import * as v from "valibot"

import { connectionError } from "./errors.ts"

import type { ConnectionActivity, ConnectionActor, ConnectionStatus, ConnectionTokenSet } from "./types.ts"
import type { SQL } from "drizzle-orm"

/** Structural database handle. A ViteHub Drizzle SQLite database matches it. */
export interface ConnectionsDatabase {
  all: (query: SQL) => unknown[] | PromiseLike<unknown[]>
  run: (query: SQL) => unknown
}

export interface StoredGrant {
  account?: string
  connectedAt: string
  expiresAt?: number
  keyMatches: boolean
  lastError?: string
  leaseUntil?: number
  provider: string
  revision: string
  scopes: readonly string[]
  status: ConnectionStatus
  updatedAt: string
}

export interface PendingConnection {
  /** Actor that started the connect. The callback records activity for this actor. */
  actor: ConnectionActor
  name: string
  redirectUri: string
  state: string
  verifier: string
}

export interface ConnectionsStore {
  activity: (options: { before?: string, connection?: string, limit?: number }) => Promise<ConnectionActivity[]>
  append: (activity: ConnectionActivity) => Promise<void>
  consumePending: (state: string, now: number) => Promise<PendingConnection | undefined>
  createPending: (pending: PendingConnection & { expiresAt: number, ticket: string }) => Promise<void>
  /** Deletes the grant only at `revision`, so a newer connect survives a slow disconnect. */
  deleteGrant: (name: string, revision: string) => Promise<void>
  grant: (name: string) => Promise<StoredGrant | undefined>
  /** Takes the refresh lease when the revision is current and no lease is active. */
  lease: (name: string, revision: string, now: number, until: number) => Promise<boolean>
  openPending: (ticket: string, now: number) => Promise<PendingConnection | undefined>
  /** Clears the lease and sets a status without a new token. Only changes the grant at `revision`. */
  release: (name: string, revision: string, status: ConnectionStatus, lastError?: string) => Promise<void>
  /** One read of the grant, with its tokens when the key matches. Disconnect uses it as a consistent snapshot. */
  snapshot: (name: string) => Promise<{ grant: StoredGrant, tokens?: ConnectionTokenSet } | undefined>
  tokens: (name: string) => Promise<{ grant: StoredGrant, tokens: ConnectionTokenSet } | undefined>
  /** Writes a new token set. With `expectedRevision`, only replaces that revision. */
  write: (input: { expectedRevision?: string, name: string, provider: string, tokens: ConnectionTokenSet }) => Promise<StoredGrant>
}

const identifier = v.pipe(v.string(), v.minLength(1), v.maxLength(512))
const status = v.picklist(["active", "disconnected", "error", "needs-reconnect"])
const grantRow = v.object({
  account: v.nullable(v.string()),
  connected_at: v.string(),
  expires_at: v.nullable(v.number()),
  key_id: v.string(),
  last_error: v.nullable(v.string()),
  lease_until: v.nullable(v.number()),
  payload: v.pipe(v.string(), v.regex(sealedPayloadPattern)),
  provider: v.string(),
  revision: identifier,
  scopes: v.string(),
  status,
  updated_at: v.string(),
})
const tokenSet = v.object({
  accessToken: v.string(),
  account: v.optional(v.string()),
  expiresAt: v.optional(v.number()),
  refreshToken: v.optional(v.string()),
  scopes: v.array(v.string()),
  tokenType: v.string(),
})
const pendingRow = v.object({ expires_at: v.number(), name: identifier, payload: v.pipe(v.string(), v.regex(sealedPayloadPattern)), state: identifier })
const actor = v.object({ id: identifier, kind: v.picklist(["agent", "route", "schedule", "service", "user"]) })
const pendingPayload = v.object({ actor, redirectUri: v.string(), verifier: v.string() })
const activityPayload = v.object({
  action: v.picklist(["call", "connect", "disconnect", "refresh"]),
  actor,
  connection: identifier,
  durationMs: v.optional(v.number()),
  effect: v.optional(v.picklist(["read", "write"])),
  error: v.optional(v.string()),
  id: identifier,
  invocationId: v.optional(v.string()),
  operation: v.optional(v.string()),
  outcome: v.picklist(["approval-required", "denied", "failed", "skipped", "succeeded"]),
  runId: v.optional(v.string()),
  status: v.optional(v.number()),
  target: v.optional(v.string()),
  timestamp: v.string(),
  tool: v.optional(v.string()),
  traceId: v.optional(v.string()),
})
const activityRow = v.object({ id: identifier, payload: v.string() })

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  }
  catch {
    throw connectionError("invalid")
  }
}

function toGrant(row: v.InferOutput<typeof grantRow>, keyId: string): StoredGrant {
  return {
    connectedAt: row.connected_at,
    keyMatches: row.key_id === keyId,
    provider: row.provider,
    revision: row.revision,
    scopes: v.parse(v.array(v.string()), parseJson(row.scopes)),
    status: row.status,
    updatedAt: row.updated_at,
    ...(row.account ? { account: row.account } : {}),
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    ...(row.lease_until === null ? {} : { leaseUntil: row.lease_until }),
  }
}

/** Sealed grants, pending connects, and activity on the app database. */
export function createConnectionsStore(options: { db: ConnectionsDatabase, encryptionKey: Uint8Array }): ConnectionsStore {
  const { db } = options
  const key = importSealKey(options.encryptionKey)
  const keyId = sealKeyId(options.encryptionKey)
  const encoder = new TextEncoder()
  const grantAad = (name: string, revision: string) => encoder.encode(JSON.stringify(["connection-grant", name, revision]))
  const pendingAad = (state: string) => encoder.encode(JSON.stringify(["connection-pending", state]))
  let ready: Promise<void> | undefined
  const initialize = () => (ready ??= (async () => {
    await db.run(sql`CREATE TABLE IF NOT EXISTS vitehub_connection_grants (name TEXT PRIMARY KEY NOT NULL, provider TEXT NOT NULL, account TEXT, scopes TEXT NOT NULL, payload TEXT NOT NULL, key_id TEXT NOT NULL, revision TEXT NOT NULL, status TEXT NOT NULL, expires_at INTEGER, lease_until INTEGER, last_error TEXT, connected_at TEXT NOT NULL, updated_at TEXT NOT NULL)`)
    await db.run(sql`CREATE TABLE IF NOT EXISTS vitehub_connection_pending (state TEXT PRIMARY KEY NOT NULL, ticket TEXT NOT NULL UNIQUE, name TEXT NOT NULL, payload TEXT NOT NULL, opened INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL)`)
    await db.run(sql`CREATE TABLE IF NOT EXISTS vitehub_connection_activity (sequence INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL)`)
    await db.run(sql`CREATE INDEX IF NOT EXISTS vitehub_connection_activity_name ON vitehub_connection_activity (name, sequence)`)
  })().catch((error) => {
    ready = undefined
    throw error
  }))

  async function readRow(name: string): Promise<v.InferOutput<typeof grantRow> | undefined> {
    await initialize()
    const row = (await db.all(sql`SELECT provider, account, scopes, payload, key_id, revision, status, expires_at, lease_until, last_error, connected_at, updated_at FROM vitehub_connection_grants WHERE name = ${name}`))[0]
    return row === undefined ? undefined : v.parse(grantRow, row)
  }

  function readPending(row: unknown, aadState: string): Promise<PendingConnection> {
    const parsed = v.parse(pendingRow, row)
    return key.then(sealKey => unseal(sealKey, pendingAad(aadState), parsed.payload)).then((payload) => {
      const value = v.parse(pendingPayload, parseJson(payload))
      return { actor: value.actor, name: parsed.name, redirectUri: value.redirectUri, state: parsed.state, verifier: value.verifier }
    })
  }

  return {
    async activity({ before, connection, limit = 50 }) {
      await initialize()
      const size = Math.min(Math.max(limit, 1), 200)
      const cursor = before ? sql`AND sequence < (SELECT sequence FROM vitehub_connection_activity WHERE id = ${before})` : sql``
      const rows = connection
        ? await db.all(sql`SELECT id, payload FROM vitehub_connection_activity WHERE name = ${connection} ${cursor} ORDER BY sequence DESC LIMIT ${size}`)
        : await db.all(sql`SELECT id, payload FROM vitehub_connection_activity WHERE 1 = 1 ${cursor} ORDER BY sequence DESC LIMIT ${size}`)
      return rows.map((row) => {
        const stored = v.parse(activityRow, row)
        const event = v.parse(activityPayload, parseJson(stored.payload))
        if (event.id !== stored.id) throw connectionError("invalid")
        return event
      })
    },
    async append(activity) {
      await initialize()
      // A long route path must not store a row that `activity()` cannot read back.
      const value = v.parse(activityPayload, { ...activity, actor: { ...activity.actor, id: activity.actor.id.slice(0, 512) } })
      await db.run(sql`INSERT INTO vitehub_connection_activity (name, id, payload) VALUES (${value.connection}, ${value.id}, ${JSON.stringify(value)})`)
    },
    async consumePending(state, now) {
      await initialize()
      const row = (await db.all(sql`DELETE FROM vitehub_connection_pending WHERE state = ${state} AND opened = 1 RETURNING state, name, payload, expires_at`))[0]
      if (row === undefined) return
      const pending = await readPending(row, state)
      return v.parse(pendingRow, row).expires_at < now ? undefined : pending
    },
    async createPending(pending) {
      await initialize()
      await db.run(sql`DELETE FROM vitehub_connection_pending WHERE expires_at < ${Date.now()}`)
      // Parse with the read schema, so `openPending()` can always read the row back.
      const value = v.parse(pendingPayload, { actor: { ...pending.actor, id: pending.actor.id.slice(0, 512) }, redirectUri: pending.redirectUri, verifier: pending.verifier })
      const payload = await seal(await key, pendingAad(pending.state), JSON.stringify(value))
      await db.run(sql`INSERT INTO vitehub_connection_pending (state, ticket, name, payload, expires_at) VALUES (${pending.state}, ${pending.ticket}, ${pending.name}, ${payload}, ${pending.expiresAt})`)
    },
    async deleteGrant(name, revision) {
      await initialize()
      await db.run(sql`DELETE FROM vitehub_connection_grants WHERE name = ${name} AND revision = ${revision}`)
    },
    async grant(name) {
      const row = await readRow(name)
      return row && toGrant(row, await keyId)
    },
    async lease(name, revision, now, until) {
      await initialize()
      const rows = await db.all(sql`UPDATE vitehub_connection_grants SET lease_until = ${until} WHERE name = ${name} AND revision = ${revision} AND (lease_until IS NULL OR lease_until < ${now}) RETURNING name`)
      return rows.length === 1
    },
    async openPending(ticket, now) {
      await initialize()
      const row = (await db.all(sql`UPDATE vitehub_connection_pending SET opened = 1 WHERE ticket = ${ticket} AND opened = 0 AND expires_at >= ${now} RETURNING state, name, payload, expires_at`))[0]
      if (row === undefined) return
      return readPending(row, v.parse(pendingRow, row).state)
    },
    async release(name, revision, nextStatus, lastError) {
      await initialize()
      await db.run(sql`UPDATE vitehub_connection_grants SET lease_until = NULL, status = ${nextStatus}, last_error = ${lastError ?? null}, updated_at = ${new Date().toISOString()} WHERE name = ${name} AND revision = ${revision}`)
    },
    async snapshot(name) {
      const row = await readRow(name)
      if (!row) return
      const grant = toGrant(row, await keyId)
      if (!grant.keyMatches) return { grant }
      const value = await unseal(await key, grantAad(name, row.revision), row.payload)
      return { grant, tokens: v.parse(tokenSet, parseJson(value)) }
    },
    async tokens(name) {
      const row = await readRow(name)
      if (!row) return
      const grant = toGrant(row, await keyId)
      if (!grant.keyMatches) throw connectionError("key_mismatch", { connection: name })
      const value = await unseal(await key, grantAad(name, row.revision), row.payload)
      return { grant, tokens: v.parse(tokenSet, parseJson(value)) }
    },
    async write({ expectedRevision, name, provider, tokens }) {
      await initialize()
      const revision = crypto.randomUUID()
      const now = new Date().toISOString()
      const payload = await seal(await key, grantAad(name, revision), JSON.stringify(tokens))
      const scopes = JSON.stringify(tokens.scopes)
      const account = tokens.account ?? null
      const expiresAt = tokens.expiresAt ?? null
      const id = await keyId
      const rows = expectedRevision === undefined
        ? await db.all(sql`INSERT INTO vitehub_connection_grants (name, provider, account, scopes, payload, key_id, revision, status, expires_at, lease_until, last_error, connected_at, updated_at) VALUES (${name}, ${provider}, ${account}, ${scopes}, ${payload}, ${id}, ${revision}, 'active', ${expiresAt}, NULL, NULL, ${now}, ${now}) ON CONFLICT (name) DO UPDATE SET provider = excluded.provider, account = excluded.account, scopes = excluded.scopes, payload = excluded.payload, key_id = excluded.key_id, revision = excluded.revision, status = 'active', expires_at = excluded.expires_at, lease_until = NULL, last_error = NULL, connected_at = excluded.connected_at, updated_at = excluded.updated_at RETURNING name`)
        : await db.all(sql`UPDATE vitehub_connection_grants SET account = ${account}, scopes = ${scopes}, payload = ${payload}, key_id = ${id}, revision = ${revision}, status = 'active', expires_at = ${expiresAt}, lease_until = NULL, last_error = NULL, updated_at = ${now} WHERE name = ${name} AND revision = ${expectedRevision} RETURNING name`)
      if (rows.length !== 1) throw connectionError("unavailable", { connection: name })
      const row = await readRow(name)
      if (!row) throw connectionError("missing", { connection: name })
      return toGrant(row, id)
    },
  }
}
