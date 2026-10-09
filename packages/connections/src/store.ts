import { createEnvBridge } from "@vite-hub/env/bridge"
import { createDatabaseEnvStore } from "@vite-hub/env/database"
import { importSealKey, unseal } from "@vite-hub/env/seal"
import { sql } from "drizzle-orm"
import * as v from "valibot"

import { ConnectionError } from "./errors.ts"

import type { EnvAccessStore, EnvBridge, EnvSecretStore } from "@vite-hub/env/bridge"
import type { EnvDatabase } from "@vite-hub/env/database"
import type { ConnectionApproval, ConnectionApprovalPage, ConnectionApprovalStatus } from "./types.ts"

export interface ConnectionState {
  accountEmail?: string
  accountId?: string
  connectedAt?: string
  name: string
  refreshedAt?: string
  scopes: string[]
  status: "connected" | "reauth_required" | "revoked"
  updatedAt: string
}

export interface ConnectionAuthorization {
  actor: string
  expiresAt: number
  name: string
  redirectUri: string
  state: string
  verifier: string
}

/** Storage for Connections. Tokens live in the Env Bridge secret store. */
export interface ConnectionStore {
  approvals: {
    /** Mark expired approval executions as failed with an unknown provider outcome. Never replay them. */
    recover: (before: string) => Promise<void>
    /** Extend an active execution lease. Terminal approvals are not changed. */
    renew: (id: string, expiresAt: string) => Promise<boolean>
    create: (approval: ConnectionApproval) => Promise<void>
    get: (id: string) => Promise<ConnectionApproval | undefined>
    /** Return at most 100 approvals in insertion order, newest first. */
    list: (input: { before?: string, name?: string, status?: ConnectionApprovalStatus }) => Promise<ConnectionApprovalPage>
    /** Count pending approvals for the configured Connection names without loading call inputs. */
    pendingCounts: (names: readonly string[]) => Promise<Record<string, number>>
    /** Move an approval from one status to another. Returns `undefined` when the status was not `from`. */
    transition: (id: string, from: ConnectionApprovalStatus, to: ConnectionApprovalStatus, patch?: { decidedAt?: string, decidedBy?: string, error?: string, executionExpiresAt?: string }) => Promise<ConnectionApproval | undefined>
  }
  authorizations: {
    put: (authorization: ConnectionAuthorization) => Promise<void>
    /** Read and delete one pending authorization. */
    take: (state: string) => Promise<ConnectionAuthorization | undefined>
  }
  /** Serialize callback exchange, refresh, and revoke across runtimes. Never replace an unresolved expired lease. */
  refreshLeases: {
    claim: (input: { expiresAt: number, name: string, now: number, owner: string, revision: string }) => Promise<"acquired" | "busy" | "expired">
    release: (name: string, owner: string) => Promise<void>
  }
  bridge: EnvBridge
  secrets: EnvSecretStore
  access: EnvAccessStore
  state: {
    get: (name: string) => Promise<ConnectionState | undefined>
    put: (state: ConnectionState) => Promise<void>
    /** Write metadata only while the Connection token still has this revision. */
    putForToken: (state: ConnectionState, revision: string | null) => Promise<boolean>
  }
}

const identifier = v.pipe(v.string(), v.minLength(1), v.maxLength(512))
const stateRow = v.object({
  account_email: v.nullable(v.string()),
  account_id: v.nullable(v.string()),
  connected_at: v.nullable(v.string()),
  name: identifier,
  refreshed_at: v.nullable(v.string()),
  scopes: v.string(),
  status: v.picklist(["connected", "reauth_required", "revoked"]),
  updated_at: v.string(),
})
const authorizationRow = v.object({
  actor: identifier,
  expires_at: v.number(),
  name: identifier,
  redirect_uri: v.string(),
  state: identifier,
  verifier: identifier,
})
const approvalRow = v.object({
  action: identifier,
  actor: identifier,
  created_at: v.string(),
  decided_at: v.nullable(v.string()),
  decided_by: v.nullable(v.string()),
  error: v.nullable(v.string()),
  id: identifier,
  input: v.string(),
  invocation_id: v.nullable(v.string()),
  name: identifier,
  status: v.picklist(["approved", "denied", "executed", "failed", "pending"]),
  trace_id: v.nullable(v.string()),
})
const legacyGrantRow = v.object({ name: identifier, provider: v.string(), account: v.nullable(v.string()), scopes: v.string(), payload: v.string(), revision: identifier, status: v.picklist(["active", "disconnected", "error", "needs-reconnect"]), connected_at: v.string(), updated_at: v.string(), expires_at: v.nullable(v.number()) })
const legacyPendingRow = v.object({ state: identifier, name: identifier, payload: v.string(), expires_at: v.number(), opened: v.number() })
const legacyTokenSet = v.object({ accessToken: v.string(), account: v.optional(v.string()), expiresAt: v.optional(v.number()), refreshToken: v.optional(v.string()), scopes: v.array(v.string()), tokenType: v.string() })

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  }
  catch {
    throw new ConnectionError("invalid", "Stored Connection data is invalid.")
  }
}

function stringArray(value: string): string[] {
  const parsed = parseJson(value)
  const result = v.safeParse(v.array(v.string()), parsed)
  if (!result.success) throw new ConnectionError("invalid", "Stored Connection scopes are invalid.")
  return result.output
}

function toApproval(row: unknown): ConnectionApproval {
  const stored = v.parse(approvalRow, row)
  const approval: ConnectionApproval = {
    action: stored.action,
    actor: stored.actor,
    createdAt: stored.created_at,
    id: stored.id,
    input: parseJson(stored.input),
    name: stored.name,
    status: stored.status,
  }
  if (stored.decided_at) approval.decidedAt = stored.decided_at
  if (stored.decided_by) approval.decidedBy = stored.decided_by
  if (stored.error) approval.error = stored.error
  if (stored.invocation_id) approval.invocationId = stored.invocation_id
  if (stored.trace_id) approval.traceId = stored.trace_id
  return approval
}

/**
 * Store Connections in a ViteHub SQLite database. Tokens are encrypted with
 * AES-GCM through the Env Bridge store in the `connections` namespace.
 */
export function createDatabaseConnectionStore(options: { db: EnvDatabase, encryptionKey: Uint8Array }): ConnectionStore {
  const envStore = createDatabaseEnvStore({ db: options.db, encryptionKey: options.encryptionKey, namespace: "connections" })
  const bridge = createEnvBridge({
    ...envStore,
    // Connections never resolves tokens as an Env provider. Each call gets a narrow context from Env.
    runtimeActor: { id: "connections", kind: "service" },
  })
  const db = options.db
  let ready: Promise<void> | undefined
  const initialize = () =>
    (ready ??= (async () => {
      await db.run(
        sql`CREATE TABLE IF NOT EXISTS vitehub_connection_state (name TEXT PRIMARY KEY, status TEXT NOT NULL, account_id TEXT, account_email TEXT, scopes TEXT NOT NULL, connected_at TEXT, refreshed_at TEXT, updated_at TEXT NOT NULL)`,
      )
      await db.run(
        sql`CREATE TABLE IF NOT EXISTS vitehub_connection_authorizations (state TEXT PRIMARY KEY, name TEXT NOT NULL, actor TEXT NOT NULL, verifier TEXT NOT NULL, redirect_uri TEXT NOT NULL, expires_at INTEGER NOT NULL)`,
      )
      await db.run(
        sql`CREATE TABLE IF NOT EXISTS vitehub_connection_approvals (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, input TEXT NOT NULL, status TEXT NOT NULL, trace_id TEXT, invocation_id TEXT, created_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT, error TEXT, execution_expires_at TEXT)`,
      )
      await db.run(sql`CREATE TABLE IF NOT EXISTS vitehub_connection_refresh_leases (name TEXT PRIMARY KEY, owner TEXT NOT NULL, revision TEXT NOT NULL, expires_at INTEGER NOT NULL)`)
      // Move data from the original sealed-grant/pending tables before serving reads.
      const legacyTables = await db.all(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('vitehub_connection_grants', 'vitehub_connection_pending')`)
      const legacyNames = new Set(legacyTables.map(row => v.parse(v.object({ name: v.string() }), row).name))
      if (legacyNames.has("vitehub_connection_grants")) {
        const key = await importSealKey(options.encryptionKey)
        const rows = await db.all(sql`SELECT name, provider, account, scopes, payload, revision, status, connected_at, updated_at, expires_at FROM vitehub_connection_grants`)
        for (const row of rows) {
          const grant = v.parse(legacyGrantRow, row)
          const legacyToken = v.parse(legacyTokenSet, JSON.parse(await unseal(key, new TextEncoder().encode(JSON.stringify(["connection-grant", grant.name, grant.revision])), grant.payload)))
          const token = { ...legacyToken, ...(legacyToken.account ? { accountId: legacyToken.account } : {}) }
          const secretKey = `connection/${grant.name}`
          if (!(await envStore.secrets.inspect(secretKey))) {
            await envStore.secrets.replace({ key: secretKey, value: JSON.stringify(token), expectedRevision: null })
          }
          await db.run(sql`INSERT INTO vitehub_connection_state (name, status, account_id, account_email, scopes, connected_at, refreshed_at, updated_at) VALUES (${grant.name}, ${grant.status === "active" ? "connected" : grant.status === "needs-reconnect" ? "reauth_required" : "revoked"}, ${token.accountId ?? null}, ${grant.account ?? null}, ${JSON.stringify(token.scopes)}, ${grant.connected_at}, ${grant.updated_at}, ${grant.updated_at}) ON CONFLICT (name) DO NOTHING`)
        }
      }
      if (legacyNames.has("vitehub_connection_pending")) {
        const key = await importSealKey(options.encryptionKey)
        const now = Date.now()
        const rows = await db.all(sql`SELECT state, name, payload, expires_at, opened FROM vitehub_connection_pending WHERE opened = 1 AND expires_at > ${now}`)
        for (const row of rows) {
          const pending = v.parse(legacyPendingRow, row)
          const value = v.parse(v.object({ actor: v.object({ id: v.string(), kind: v.string() }), redirectUri: v.string(), verifier: v.string() }), JSON.parse(await unseal(key, new TextEncoder().encode(JSON.stringify(["connection-pending", pending.state])), pending.payload)))
          await db.run(sql`INSERT INTO vitehub_connection_authorizations (state, name, actor, verifier, redirect_uri, expires_at) VALUES (${pending.state}, ${pending.name}, ${`${value.actor.kind}:${value.actor.id}`}, ${value.verifier}, ${value.redirectUri}, ${pending.expires_at}) ON CONFLICT (state) DO NOTHING`)
          // Remove migrated rows so a consumed authorization cannot be restored on restart.
          await db.run(sql`DELETE FROM vitehub_connection_pending WHERE state = ${pending.state}`)
        }
      }
      const columns = await db.all(sql`PRAGMA table_info(vitehub_connection_approvals)`)
      if (
        !columns.some(
          (column) =>
            v.parse(v.object({ name: v.string() }), column).name === "execution_expires_at",
        )
      ) {
        try {
          await db.run(
            sql`ALTER TABLE vitehub_connection_approvals ADD COLUMN execution_expires_at TEXT`,
          )
        } catch (error) {
          const updated = await db.all(sql`PRAGMA table_info(vitehub_connection_approvals)`)
          if (
            !updated.some(
              (column) =>
                v.parse(v.object({ name: v.string() }), column).name === "execution_expires_at",
            )
          )
            throw error
        }
      }
      await db.run(
        sql`CREATE INDEX IF NOT EXISTS vitehub_connection_approvals_status ON vitehub_connection_approvals (status, sequence)`,
      )
    })().catch((error: unknown) => {
      ready = undefined
      throw error
    }))
  const approvalColumns = sql`id, name, actor, action, input, status, trace_id, invocation_id, created_at, decided_at, decided_by, error`

  return {
    ...envStore,
    secrets: {
      async inspect(key) {
        await initialize()
        return envStore.secrets.inspect(key)
      },
      async read(key) {
        await initialize()
        return envStore.secrets.read(key)
      },
      async replace(input) {
        await initialize()
        return envStore.secrets.replace(input)
      },
    },
    bridge,
    refreshLeases: {
      async claim(input) {
        await initialize()
        const rows = await db.all(sql`INSERT INTO vitehub_connection_refresh_leases (name, owner, revision, expires_at) VALUES (${input.name}, ${input.owner}, ${input.revision}, ${input.expiresAt}) ON CONFLICT (name) DO NOTHING RETURNING name`)
        if (rows.length === 1) return "acquired"
        const current = (await db.all(sql`SELECT revision, expires_at FROM vitehub_connection_refresh_leases WHERE name = ${input.name}`))[0]
        const lease = v.safeParse(v.object({ expires_at: v.number(), revision: v.string() }), current)
        return lease.success && lease.output.expires_at <= input.now ? "expired" : "busy"
      },
      async release(name, owner) {
        await initialize()
        await db.run(sql`DELETE FROM vitehub_connection_refresh_leases WHERE name = ${name} AND owner = ${owner}`)
      },
    },
    state: {
      async get(name) {
        await initialize()
        const row = (await db.all(sql`SELECT name, status, account_id, account_email, scopes, connected_at, refreshed_at, updated_at FROM vitehub_connection_state WHERE name = ${name}`))[0]
        if (row === undefined) return undefined
        const stored = v.parse(stateRow, row)
        const state: ConnectionState = {
          name: stored.name,
          scopes: stringArray(stored.scopes),
          status: stored.status,
          updatedAt: stored.updated_at,
        }
        if (stored.account_email) state.accountEmail = stored.account_email
        if (stored.account_id) state.accountId = stored.account_id
        if (stored.connected_at) state.connectedAt = stored.connected_at
        if (stored.refreshed_at) state.refreshedAt = stored.refreshed_at
        return state
      },
      async put(state) {
        await initialize()
        await db.run(sql`INSERT INTO vitehub_connection_state (name, status, account_id, account_email, scopes, connected_at, refreshed_at, updated_at) VALUES (${state.name}, ${state.status}, ${state.accountId ?? null}, ${state.accountEmail ?? null}, ${JSON.stringify(state.scopes)}, ${state.connectedAt ?? null}, ${state.refreshedAt ?? null}, ${state.updatedAt}) ON CONFLICT (name) DO UPDATE SET status = excluded.status, account_id = excluded.account_id, account_email = excluded.account_email, scopes = excluded.scopes, connected_at = excluded.connected_at, refreshed_at = excluded.refreshed_at, updated_at = excluded.updated_at`)
      },
      async putForToken(state, revision) {
        await initialize()
        const condition = await envStore.revisionCondition(`connection/${state.name}`, revision)
        const rows = await db.all(sql`INSERT INTO vitehub_connection_state (name, status, account_id, account_email, scopes, connected_at, refreshed_at, updated_at) SELECT ${state.name}, ${state.status}, ${state.accountId ?? null}, ${state.accountEmail ?? null}, ${JSON.stringify(state.scopes)}, ${state.connectedAt ?? null}, ${state.refreshedAt ?? null}, ${state.updatedAt} WHERE ${condition} ON CONFLICT (name) DO UPDATE SET status = excluded.status, account_id = excluded.account_id, account_email = excluded.account_email, scopes = excluded.scopes, connected_at = excluded.connected_at, refreshed_at = excluded.refreshed_at, updated_at = excluded.updated_at WHERE ${condition} RETURNING name`)
        return rows.length === 1
      },
    },
    authorizations: {
      async put(authorization) {
        await initialize()
        await db.run(sql`DELETE FROM vitehub_connection_authorizations WHERE expires_at < ${Date.now()}`)
        await db.run(sql`INSERT INTO vitehub_connection_authorizations (state, name, actor, verifier, redirect_uri, expires_at) VALUES (${authorization.state}, ${authorization.name}, ${authorization.actor}, ${authorization.verifier}, ${authorization.redirectUri}, ${authorization.expiresAt})`)
      },
      async take(state) {
        await initialize()
        const row = (await db.all(sql`DELETE FROM vitehub_connection_authorizations WHERE state = ${state} RETURNING state, name, actor, verifier, redirect_uri, expires_at`))[0]
        if (row === undefined) return undefined
        const stored = v.parse(authorizationRow, row)
        return { actor: stored.actor, expiresAt: stored.expires_at, name: stored.name, redirectUri: stored.redirect_uri, state: stored.state, verifier: stored.verifier }
      },
    },
    approvals: {
      async recover(before) {
        await initialize()
        await db.run(
          sql`UPDATE vitehub_connection_approvals SET status = 'failed', error = 'CONNECTION_EXECUTION_UNKNOWN' WHERE status = 'approved' AND (execution_expires_at <= ${before} OR (execution_expires_at IS NULL AND (decided_at IS NULL OR decided_at <= ${new Date(Date.parse(before) - 5 * 60_000).toISOString()})))`,
        )
      },
      async renew(id, expiresAt) {
        await initialize()
        const rows = await db.all(
          sql`UPDATE vitehub_connection_approvals SET execution_expires_at = ${expiresAt} WHERE id = ${id} AND status = 'approved' RETURNING id`,
        )
        return rows.length > 0
      },
      async create(approval) {
        await initialize()
        await db.run(sql`INSERT INTO vitehub_connection_approvals (id, name, actor, action, input, status, trace_id, invocation_id, created_at) VALUES (${approval.id}, ${approval.name}, ${approval.actor}, ${approval.action}, ${JSON.stringify(approval.input ?? null)}, ${approval.status}, ${approval.traceId ?? null}, ${approval.invocationId ?? null}, ${approval.createdAt})`)
      },
      async get(id) {
        await initialize()
        const row = (await db.all(sql`SELECT ${approvalColumns} FROM vitehub_connection_approvals WHERE id = ${id}`))[0]
        return row === undefined ? undefined : toApproval(row)
      },
      async list({ before, name, status }) {
        await initialize()
        const rows = await db.all(sql`SELECT ${approvalColumns} FROM vitehub_connection_approvals WHERE 1 = 1 ${name ? sql`AND name = ${name}` : sql``} ${status ? sql`AND status = ${status}` : sql``} ${before ? sql`AND sequence < (SELECT sequence FROM vitehub_connection_approvals WHERE id = ${before})` : sql``} ORDER BY sequence DESC LIMIT 101`)
        const approvals = rows.slice(0, 100).map(toApproval)
        const nextCursor = rows.length > 100 ? approvals.at(-1)?.id : undefined
        return nextCursor ? { approvals, nextCursor } : { approvals }
      },
      async pendingCounts(names) {
        await initialize()
        if (!names.length) return {}
        const rows = await db.all(sql`SELECT name, COUNT(*) AS count FROM vitehub_connection_approvals WHERE status = 'pending' AND name IN (${sql.join(names.map(name => sql`${name}`), sql`, `)}) GROUP BY name`)
        return Object.fromEntries(rows.map(row => {
          const stored = v.parse(v.object({ name: identifier, count: v.pipe(v.number(), v.integer(), v.minValue(0)) }), row)
          return [stored.name, stored.count]
        }))
      },
      async transition(id, from, to, patch = {}) {
        await initialize()
        const row = (await db.all(sql`UPDATE vitehub_connection_approvals SET status = ${to}, decided_at = COALESCE(${patch.decidedAt ?? null}, decided_at), decided_by = COALESCE(${patch.decidedBy ?? null}, decided_by), error = COALESCE(${patch.error ?? null}, error), execution_expires_at = COALESCE(${patch.executionExpiresAt ?? null}, execution_expires_at) WHERE id = ${id} AND status = ${from} RETURNING ${approvalColumns}`))[0]
        return row === undefined ? undefined : toApproval(row)
      },
    },
  }
}
