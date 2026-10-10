import type { AgentStateCacheMutation } from "../internal/state-lock.ts"
import { mkdir, realpath } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { parseAgentStateQueueEntry } from "../internal/state-queue.ts"
import { parseAgentWebhookQueueDelivery } from "../internal/webhook-queue.ts"
import { isRuntimeBigInt, isRuntimeObject, isRuntimeString } from "../internal/runtime-value.ts"

import type { AgentWebhookQueueDelivery, AgentWebhookQueueLease, AgentWebhookQueueStateAdapter } from "../internal/webhook-queue.ts"

import type { Lock, QueueEntry } from "chat"
import { agentDiagnostics } from "../agent-diagnostics.ts"

type MaybePromise<T> = T | Promise<T>

const SQLITE_STATE_CLEANUP_INTERVAL_MS = 5 * 60 * 1000

export type SqliteAgentStateRow = Record<string, unknown>

export interface SqliteAgentStateResult {
  rows?: SqliteAgentStateRow[]
}

export interface SqliteAgentStateExecutor {
  execute: (statement: string, args?: unknown[]) => MaybePromise<SqliteAgentStateResult | SqliteAgentStateRow[] | void>
}

export interface SqliteAgentStateDriver extends SqliteAgentStateExecutor {
  connect?: () => MaybePromise<void>
  disconnect?: () => MaybePromise<void>
  transaction?: <T>(run: (executor: SqliteAgentStateExecutor) => MaybePromise<T>) => MaybePromise<T>
}

export interface SqliteAgentStateOptions {
  /** Custom drivers or clients must declare whether their storage survives a restart. */
  durable?: boolean
  driver: SqliteAgentStateDriver
  tablePrefix?: string
  /** Preserve Chat user transcripts, including existing rows, before expiry cleanup. */
  transcripts?: { retention: "forever" }
}

/** SQL access for a package that owns tables next to Agent State. */
export interface SqliteAgentStateExtensionExecutor {
  execute: (statement: string, args?: unknown[]) => Promise<SqliteAgentStateRow[]>
}

/**
 * Tables owned by one extension, such as the Babysitter PR inbox, in the Agent State database.
 * Writes share the adapter's in-process serialization and run in `BEGIN IMMEDIATE` transactions.
 */
export interface SqliteAgentStateExtension extends SqliteAgentStateExtensionExecutor {
  /** Prefix for the extension's own tables. It extends the Agent State table prefix. */
  readonly tablePrefix: string
  transaction: <T>(run: (executor: SqliteAgentStateExtensionExecutor) => Promise<T>) => Promise<T>
}

export interface LibsqlAgentStateClient {
  close?: () => MaybePromise<void>
  execute: (statement: string | { args?: unknown[]; sql: string }) => MaybePromise<SqliteAgentStateResult>
  transaction: (mode?: "deferred" | "read" | "write") => MaybePromise<{
    close?: () => MaybePromise<void>
    commit: () => MaybePromise<void>
    execute: (statement: string | { args?: unknown[]; sql: string }) => MaybePromise<SqliteAgentStateResult>
    rollback: () => MaybePromise<void>
  }>
}

export interface LibsqlAgentStateOptions extends Omit<SqliteAgentStateOptions, "driver"> {
  authToken?: string
  client?: LibsqlAgentStateClient
  /** Owned file databases default to WAL. Use delete on volumes without shared-memory support. */
  journalMode?: "wal" | "delete"
  url?: string
}

interface StateTables {
  cache: string
  lists: string
  locks: string
  queue: string
  schemaVersion: string
  subscriptions: string
  webhookQueue: string
}

function randomToken(): string {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function tableName(prefix: string, name: string): string {
  const candidate = `${prefix}${name}`
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(candidate)) {
    throw agentDiagnostics.AGENT_R0849({ message: `[vitehub] Invalid SQLite Agent State table name "${candidate}". Use an alphanumeric tablePrefix.` })
  }
  return candidate
}

function createTables(prefix = "vitehub_agent_state_"): StateTables {
  return {
    cache: tableName(prefix, "cache"),
    lists: tableName(prefix, "lists"),
    locks: tableName(prefix, "locks"),
    queue: tableName(prefix, "queue"),
    schemaVersion: tableName(prefix, "schema_version"),
    subscriptions: tableName(prefix, "subscriptions"),
    webhookQueue: tableName(prefix, "webhook_queue"),
  }
}

function rows(result: SqliteAgentStateResult | SqliteAgentStateRow[] | void): SqliteAgentStateRow[] {
  if (Array.isArray(result)) return result
  if (Array.isArray(result?.rows)) return result.rows
  return []
}

function numberValue(value: unknown): number {
  return isRuntimeBigInt(value) ? Number(value) : Number(value || 0)
}

async function execute(executor: SqliteAgentStateExecutor, statement: string, args: unknown[] = []): Promise<SqliteAgentStateRow[]> {
  return rows(await executor.execute(statement, args))
}

function isSqliteBusy(error: unknown): boolean {
  let current = error
  while (current && isRuntimeObject(current)) {
    // SAFETY: The owning Agent runtime boundary establishes the asserted representation before this value is used.
    if ((current as { code?: unknown }).code === "SQLITE_BUSY") return true
    // SAFETY: The owning Agent runtime boundary establishes the asserted representation before this value is used.
    current = (current as { cause?: unknown }).cause
  }
  return false
}

async function retrySqliteBusy<T>(operation: () => Promise<T>, timeoutMs?: number): Promise<T> {
  const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation()
    } catch (error) {
      if (!isSqliteBusy(error) || (deadline === undefined ? attempt >= 7 : Date.now() >= deadline)) throw error
      await new Promise((resolve) => setTimeout(resolve, Math.min(deadline === undefined ? 50 : 250, 2 ** attempt)))
    }
  }
}

export class ViteHubSqliteAgentStateAdapter implements AgentWebhookQueueStateAdapter {
  readonly durable: boolean
  private readonly preserveTranscripts: boolean
  private connected = false
  private connectPromise?: Promise<void>
  private readonly driver: SqliteAgentStateDriver
  private nextCleanupAt = 0
  private readonly tables: StateTables
  private transactionTail: Promise<void> = Promise.resolve()

  private readonly tablePrefix: string

  constructor(options: SqliteAgentStateOptions) {
    if (!options.driver) {
      throw agentDiagnostics.AGENT_R0850({ message: "[vitehub] SQLite Agent State requires a driver." })
    }
    this.durable = options.durable === true
    this.preserveTranscripts = options.transcripts?.retention === "forever"
    this.driver = options.driver
    this.tablePrefix = options.tablePrefix ?? "vitehub_agent_state_"
    this.tables = createTables(options.tablePrefix)
  }

  /**
   * Opens SQL access for tables that `name` owns in this database. Table names start with
   * `tablePrefix`. The extension creates and migrates its own tables.
   */
  extension(name: string): SqliteAgentStateExtension {
    if (!/^[a-z][a-z0-9_]*$/.test(name)) {
      throw agentDiagnostics.AGENT_R0849({ message: `[vitehub] Invalid SQLite Agent State extension name "${name}". Use lowercase letters, digits, and underscores.` })
    }
    const tablePrefix = `${this.tablePrefix}${name}_`
    tableName(tablePrefix, "x")
    const executor = (target: SqliteAgentStateExecutor): SqliteAgentStateExtensionExecutor => ({
      execute: async (statement, args = []) => await execute(target, statement, args),
    })
    return {
      tablePrefix,
      execute: async (statement, args = []) => {
        await this.connect()
        return await this.serialize(async () => await retrySqliteBusy(async () => await execute(this.driver, statement, args)))
      },
      transaction: async (run) => {
        await this.connect()
        return await retrySqliteBusy(async () => await this.transaction(async tx => await run(executor(tx))))
      },
    }
  }

  async acquireLock(threadId: string, ttlMs: number): Promise<Lock | null> {
    return await retrySqliteBusy(async () => {
      await this.cleanupExpiredStateIfDue()
      return await this.transaction(async (tx) => {
        const now = Date.now()
        await execute(tx, `DELETE FROM ${this.tables.locks} WHERE thread_id = ? AND expires_at <= ?`, [threadId, now])
        const existing = await execute(tx, `SELECT 1 FROM ${this.tables.locks} WHERE thread_id = ? LIMIT 1`, [threadId])
        if (existing.length > 0) return null

        const token = randomToken()
        const expiresAt = now + ttlMs
        await execute(tx, `INSERT INTO ${this.tables.locks} (thread_id, token, expires_at) VALUES (?, ?, ?)`, [threadId, token, expiresAt])
        return { expiresAt, threadId, token }
      })
    })
  }

  async appendToList(key: string, value: unknown, options?: { maxLength?: number; ttlMs?: number }): Promise<void> {
    await this.cleanupExpiredStateIfDue()
    const now = Date.now()
    const transcript = /^(?:chat:.*:)?transcripts:user:/.test(key)
    const expiresAt = this.preserveTranscripts && transcript ? null : options?.ttlMs ? now + options.ttlMs : null
    await this.transaction(async (tx) => {
      await execute(tx, `DELETE FROM ${this.tables.lists} WHERE key = ? AND expires_at IS NOT NULL AND expires_at <= ?`, [key, now])
      await execute(tx, `INSERT INTO ${this.tables.lists} (key, value, expires_at) VALUES (?, ?, ?)`, [key, JSON.stringify(value), expiresAt])
      await execute(tx, `UPDATE ${this.tables.lists} SET expires_at = ? WHERE key = ?`, [expiresAt, key])
      if (options?.maxLength != null && options.maxLength > 0) {
        await execute(
          tx,
          `DELETE FROM ${this.tables.lists} WHERE key = ? AND id NOT IN (
            SELECT id FROM ${this.tables.lists} WHERE key = ? ORDER BY id DESC LIMIT ?
          )`,
          [key, key, options.maxLength],
        )
      }
    })
  }

  async cleanupExpiredState(): Promise<void> {
    this.ensureConnected()
    const now = Date.now()
    await this.deleteExpiredRows(now)
    this.nextCleanupAt = now + SQLITE_STATE_CLEANUP_INTERVAL_MS
  }

  async claimWebhookDelivery(scope: string): Promise<AgentWebhookQueueLease | null> {
    await this.cleanupExpiredStateIfDue()
    return await this.transaction(async (tx) => {
      const now = Date.now()
      const candidates = await execute(
        tx,
        `SELECT candidate.delivery_id, candidate.value, candidate.status, candidate.concurrency_group,
            candidate.concurrency_key, candidate.concurrency_limit, candidate.lease_ttl_ms, candidate.attempts
          FROM ${this.tables.webhookQueue} AS candidate
          WHERE candidate.scope = ? AND candidate.available_at <= ?
            AND (candidate.status = 'queued' OR (candidate.status IN ('running', 'steering', 'notifying') AND COALESCE(candidate.lease_expires_at, 0) <= ?))
            AND (
              SELECT COUNT(*) FROM ${this.tables.webhookQueue} AS active_group
              WHERE active_group.status = 'running' AND active_group.lease_expires_at > ?
                AND active_group.concurrency_group = candidate.concurrency_group
            ) < candidate.concurrency_limit
            AND (
              candidate.concurrency_key IS NULL OR NOT EXISTS (
                SELECT 1 FROM ${this.tables.webhookQueue} AS active_key
                WHERE active_key.status = 'running' AND active_key.lease_expires_at > ?
                  AND active_key.concurrency_key = candidate.concurrency_key
              ) AND NOT EXISTS (
                SELECT 1 FROM ${this.tables.locks} AS fence
                WHERE fence.thread_id = ('webhook-fence:' || candidate.concurrency_key)
                  AND fence.expires_at > ?
              )
            )
          ORDER BY candidate.id ASC
          LIMIT 1`,
        [scope, now, now, now, now, now],
      )
      for (const candidate of candidates) {
        const leaseToken = randomToken()
        const leaseTtlMs = numberValue(candidate.lease_ttl_ms)
        const claimed = await execute(
          tx,
          `UPDATE ${this.tables.webhookQueue}
            SET attempts = attempts + CASE WHEN status IN ('running', 'steering') THEN 1 ELSE 0 END,
              status = 'running', lease_token = ?, lease_expires_at = ?
            WHERE scope = ? AND delivery_id = ?
              AND (status = 'queued' OR (status IN ('running', 'steering', 'notifying') AND COALESCE(lease_expires_at, 0) <= ?))
            RETURNING value`,
          [leaseToken, now + leaseTtlMs, scope, candidate.delivery_id, now],
        )
        if (claimed.length === 0 || !isRuntimeString(candidate.value)) continue
        return {
          ...parseAgentWebhookQueueDelivery(candidate.value),
          attempts: numberValue(candidate.attempts) + (candidate.status === "running" || candidate.status === "steering" ? 1 : 0),
          leaseExpiresAt: now + leaseTtlMs,
          leaseToken,
        }
      }
      return null
    })
  }

  async claimWebhookSteering(delivery: AgentWebhookQueueDelivery, leaseToken: string, leaseExpiresAt: number): Promise<boolean> {
    const inserted = await retrySqliteBusy(async () => {
      await this.cleanupExpiredStateIfDue()
      return await this.transaction(
        async (tx) =>
          await execute(
            tx,
            `INSERT OR IGNORE INTO ${this.tables.webhookQueue} (
          scope, delivery_id, value, concurrency_group, concurrency_key, concurrency_limit,
          lease_ttl_ms, status, enqueued_at, available_at, attempts, lease_token, lease_expires_at
        ) SELECT ?, ?, ?, ?, ?, ?, ?, 'steering', ?, ?, 0, ?, ?
          WHERE NOT EXISTS (
            SELECT 1 FROM ${this.tables.webhookQueue}
            WHERE scope = ? AND concurrency_key = ? AND status = 'queued'
          )
          RETURNING delivery_id`,
            [
              delivery.scope,
              delivery.deliveryId,
              JSON.stringify(delivery),
              delivery.concurrencyGroup,
              delivery.concurrencyKey || null,
              delivery.concurrencyLimit,
              delivery.leaseTtlMs,
              delivery.enqueuedAt,
              delivery.enqueuedAt,
              leaseToken,
              leaseExpiresAt,
              delivery.scope,
              delivery.concurrencyKey || null,
            ],
          ),
      )
    })
    return inserted.length > 0
  }

  async completeWebhookDelivery(scope: string, deliveryId: string, leaseToken: string): Promise<boolean> {
    const completed = await retrySqliteBusy(async () => {
      await this.cleanupExpiredStateIfDue()
      return await this.transaction(
        async (tx) =>
          await execute(
            tx,
            `UPDATE ${this.tables.webhookQueue}
          SET status = 'completed', value = '{}', lease_token = NULL, lease_expires_at = NULL
          WHERE scope = ? AND delivery_id = ? AND status IN ('running', 'steering', 'notifying') AND lease_token = ?
          RETURNING delivery_id`,
            [scope, deliveryId, leaseToken],
          ),
      )
    })
    return completed.length > 0
  }

  async beginWebhookFailureNotification(scope: string, deliveryId: string, leaseToken: string): Promise<boolean> {
    const claimed = await retrySqliteBusy(() => this.transaction(async tx => {
      const current = await execute(tx, `SELECT value FROM ${this.tables.webhookQueue}
        WHERE scope = ? AND delivery_id = ? AND status IN ('running', 'steering') AND lease_token = ?`, [scope, deliveryId, leaseToken])
      if (current.length === 0 || !isRuntimeString(current[0]?.value)) return []
      const delivery = parseAgentWebhookQueueDelivery(current[0].value)
      if (!delivery.failure || delivery.failure.notificationStarted) return []
      delivery.failure.notificationStarted = true
      // Fence dispatch permanently, but retain the lease so finalization can
      // recover even when no state write succeeds after the callback.
      return await execute(tx, `UPDATE ${this.tables.webhookQueue}
        SET status = 'notifying', value = ?
        WHERE scope = ? AND delivery_id = ? AND status IN ('running', 'steering') AND lease_token = ?
        RETURNING delivery_id`, [JSON.stringify(delivery), scope, deliveryId, leaseToken])
    }))
    return claimed.length > 0
  }

  async markWebhookDeliveryFailure(scope: string, deliveryId: string, leaseToken: string, failure: { error: string, attempts: number, invocationStarted?: false }): Promise<boolean> {
    const marked = await retrySqliteBusy(async () => {
      await this.cleanupExpiredStateIfDue()
      return await this.transaction(async tx => {
        const current = await execute(tx, `SELECT value FROM ${this.tables.webhookQueue}
          WHERE scope = ? AND delivery_id = ? AND status IN ('running', 'steering') AND lease_token = ?`, [scope, deliveryId, leaseToken])
        if (current.length === 0 || !isRuntimeString(current[0]?.value)) return []
        const delivery = parseAgentWebhookQueueDelivery(current[0].value)
        delivery.failure = failure
        return await execute(tx, `UPDATE ${this.tables.webhookQueue}
          SET value = ?
          WHERE scope = ? AND delivery_id = ? AND status IN ('running', 'steering') AND lease_token = ?
          RETURNING delivery_id`, [JSON.stringify(delivery), scope, deliveryId, leaseToken])
      })
    })
    return marked.length > 0
  }

  async connect(): Promise<void> {
    if (this.connectPromise) {
      await this.connectPromise
      return
    }
    if (this.connected) return
    this.connectPromise ??= this.doConnect().finally(() => {
      this.connectPromise = undefined
    })
    await this.connectPromise
  }

  private async doConnect(): Promise<void> {
    await this.driver.connect?.()
    this.connected = true
    try {
      await this.migrate()
      if (this.preserveTranscripts) {
        await this.transaction(tx => execute(tx, `UPDATE ${this.tables.lists} SET expires_at = NULL
          WHERE expires_at IS NOT NULL AND (key GLOB 'chat:*:transcripts:user:*' OR key GLOB 'transcripts:user:*')`))
      }
      await this.cleanupExpiredState()
    } catch (error) {
      this.connected = false
      throw error
    }
  }

  async delete(key: string): Promise<void> {
    await this.cleanupExpiredStateIfDue()
    await this.transaction(async (tx) => {
      await execute(tx, `DELETE FROM ${this.tables.cache} WHERE key = ?`, [key])
      await execute(tx, `DELETE FROM ${this.tables.lists} WHERE key = ?`, [key])
    })
  }

  async dequeue(threadId: string): Promise<QueueEntry | null> {
    await this.cleanupExpiredStateIfDue()
    return await this.transaction(async (tx) => {
      const now = Date.now()
      await execute(tx, `DELETE FROM ${this.tables.queue} WHERE thread_id = ? AND expires_at <= ?`, [threadId, now])
      const queueRows = await execute(tx, `SELECT id, value FROM ${this.tables.queue} WHERE thread_id = ? ORDER BY id ASC LIMIT 1`, [threadId])
      const row = queueRows[0]
      if (!row) return null
      await execute(tx, `DELETE FROM ${this.tables.queue} WHERE id = ?`, [row.id])
      return isRuntimeString(row.value) ? parseAgentStateQueueEntry(row.value) : null
    })
  }

  async disconnect(): Promise<void> {
    this.connected = false
    await this.driver.disconnect?.()
  }

  async enqueueWebhookDelivery(delivery: AgentWebhookQueueDelivery): Promise<boolean> {
    const inserted = await retrySqliteBusy(async () => {
      await this.cleanupExpiredStateIfDue()
      return await this.transaction(
        async (tx) =>
          await execute(
            tx,
            `INSERT OR IGNORE INTO ${this.tables.webhookQueue} (
        scope, delivery_id, value, concurrency_group, concurrency_key, concurrency_limit,
        lease_ttl_ms, status, enqueued_at, available_at, attempts
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, 0) RETURNING delivery_id`,
            [
              delivery.scope,
              delivery.deliveryId,
              JSON.stringify(delivery),
              delivery.concurrencyGroup,
              delivery.concurrencyKey || null,
              delivery.concurrencyLimit,
              delivery.leaseTtlMs,
              delivery.enqueuedAt,
              delivery.enqueuedAt,
            ],
          ),
      )
    })
    return inserted.length > 0
  }

  async enqueue(threadId: string, entry: QueueEntry, maxSize: number): Promise<number> {
    await this.cleanupExpiredStateIfDue()
    return await this.transaction(async (tx) => {
      await execute(tx, `INSERT INTO ${this.tables.queue} (thread_id, value, enqueued_at, expires_at) VALUES (?, ?, ?, ?)`, [
        threadId,
        JSON.stringify(entry),
        entry.enqueuedAt,
        entry.expiresAt,
      ])
      await execute(
        tx,
        `DELETE FROM ${this.tables.queue} WHERE thread_id = ? AND id NOT IN (
          SELECT id FROM ${this.tables.queue} WHERE thread_id = ? ORDER BY id DESC LIMIT ?
        )`,
        [threadId, threadId, maxSize],
      )
      const countRows = await execute(tx, `SELECT COUNT(*) as count FROM ${this.tables.queue} WHERE thread_id = ?`, [threadId])
      return numberValue(countRows[0]?.count)
    })
  }

  async queuePeek(threadId: string): Promise<QueueEntry | null> {
    await this.cleanupExpiredStateIfDue()
    return await this.transaction(async (tx) => {
      await execute(tx, `DELETE FROM ${this.tables.queue} WHERE thread_id = ? AND expires_at <= ?`, [threadId, Date.now()])
      const queue = await execute(tx, `SELECT value FROM ${this.tables.queue} WHERE thread_id = ? ORDER BY id ASC LIMIT 1`, [threadId])
      return isRuntimeString(queue[0]?.value) ? parseAgentStateQueueEntry(queue[0].value) : null
    })
  }

  async queueReplaceHead(threadId: string, expected: QueueEntry | null, replacement: QueueEntry[], maxSize: number): Promise<boolean> {
    await this.cleanupExpiredStateIfDue()
    return await this.transaction(async (tx) => {
      await execute(tx, `DELETE FROM ${this.tables.queue} WHERE thread_id = ? AND expires_at <= ?`, [threadId, Date.now()])
      const queue = await execute(tx, `SELECT id, value FROM ${this.tables.queue} WHERE thread_id = ? ORDER BY id ASC`, [threadId])
      const current = isRuntimeString(queue[0]?.value) ? queue[0].value : null
      if (current !== (expected === null ? null : JSON.stringify(expected))) return false
      const retained = queue.slice(expected === null ? 0 : 1).flatMap((row) => (isRuntimeString(row.value) ? [parseAgentStateQueueEntry(row.value)] : []))
      const next = maxSize > 0 ? [...replacement, ...retained].slice(-maxSize) : [...replacement, ...retained]
      await execute(tx, `DELETE FROM ${this.tables.queue} WHERE thread_id = ?`, [threadId])
      for (const entry of next) {
        await execute(tx, `INSERT INTO ${this.tables.queue} (thread_id, value, enqueued_at, expires_at) VALUES (?, ?, ?, ?)`, [
          threadId,
          JSON.stringify(entry),
          entry.enqueuedAt,
          entry.expiresAt,
        ])
      }
      return true
    })
  }

  async extendLock(lock: Lock, ttlMs: number): Promise<boolean> {
    await this.cleanupExpiredStateIfDue()
    return await this.transaction(async (tx) => {
      const now = Date.now()
      const updated = await execute(
        tx,
        `UPDATE ${this.tables.locks} SET expires_at = ?
          WHERE thread_id = ? AND token = ? AND expires_at > ?
          RETURNING thread_id`,
        [now + ttlMs, lock.threadId, lock.token, now],
      )
      return updated.length > 0
    })
  }

  async extendWebhookDeliveryLease(scope: string, deliveryId: string, leaseToken: string, ttlMs: number): Promise<boolean> {
    await this.cleanupExpiredStateIfDue()
    const now = Date.now()
    const extended = await this.transaction(
      async (tx) =>
        await execute(
          tx,
          `UPDATE ${this.tables.webhookQueue} AS candidate SET lease_expires_at = ?
        WHERE candidate.scope = ? AND candidate.delivery_id = ? AND candidate.status IN ('running', 'steering')
          AND candidate.lease_token = ?
          AND (
            candidate.status = 'steering' OR candidate.lease_expires_at > ? OR (
              (
                SELECT COUNT(*) FROM ${this.tables.webhookQueue} AS active_group
                WHERE active_group.status = 'running' AND active_group.lease_expires_at > ?
                  AND active_group.concurrency_group = candidate.concurrency_group
              ) < candidate.concurrency_limit
              AND (
                candidate.concurrency_key IS NULL OR NOT EXISTS (
                  SELECT 1 FROM ${this.tables.webhookQueue} AS active_key
                  WHERE active_key.status = 'running' AND active_key.lease_expires_at > ?
                    AND active_key.concurrency_key = candidate.concurrency_key
                )
              )
            )
          )
        RETURNING delivery_id`,
          [now + ttlMs, scope, deliveryId, leaseToken, now, now, now],
        ),
    )
    return extended.length > 0
  }

  async forceReleaseLock(threadId: string): Promise<void> {
    await this.cleanupExpiredStateIfDue()
    await this.transaction(async (tx) => await execute(tx, `DELETE FROM ${this.tables.locks} WHERE thread_id = ?`, [threadId]))
  }

  async get<T = unknown>(
    key: string,
    parse: (value: unknown) => T = (value) => {
      // SAFETY: State values are JSON-compatible and callers may provide a parser when they require a narrower runtime contract.
      return value as T
    },
  ): Promise<T | null> {
    await this.cleanupExpiredStateIfDue()
    const valueRows = await execute(this.driver, `SELECT value FROM ${this.tables.cache} WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)`, [
      key,
      Date.now(),
    ])
    const value = valueRows[0]?.value
    if (!isRuntimeString(value)) return null
    const parsed: unknown = JSON.parse(value)
    return parse(parsed)
  }

  async getList<T = unknown>(
    key: string,
    parse: (value: unknown) => T = (value) => {
      // SAFETY: State list values are JSON-compatible and callers may provide a parser when they require a narrower runtime contract.
      return value as T
    },
  ): Promise<T[]> {
    await this.cleanupExpiredStateIfDue()
    const now = Date.now()
    const valueRows = await this.transaction(async (tx) => {
      await execute(tx, `DELETE FROM ${this.tables.lists} WHERE key = ? AND expires_at IS NOT NULL AND expires_at <= ?`, [key, now])
      return await execute(tx, `SELECT value FROM ${this.tables.lists} WHERE key = ? ORDER BY id ASC`, [key])
    })
    return valueRows.map((row) => {
      const value: unknown = JSON.parse(String(row.value))
      return parse(value)
    })
  }

  async isSubscribed(threadId: string): Promise<boolean> {
    await this.cleanupExpiredStateIfDue()
    const subscriptions = await execute(this.driver, `SELECT 1 FROM ${this.tables.subscriptions} WHERE thread_id = ? LIMIT 1`, [threadId])
    return subscriptions.length > 0
  }

  async queueDepth(threadId: string): Promise<number> {
    await this.cleanupExpiredStateIfDue()
    const countRows = await execute(this.driver, `SELECT COUNT(*) as count FROM ${this.tables.queue} WHERE thread_id = ? AND expires_at > ?`, [
      threadId,
      Date.now(),
    ])
    return numberValue(countRows[0]?.count)
  }

  async mutateWithLock(lock: Lock, mutations: readonly AgentStateCacheMutation[]): Promise<boolean> {
    return await retrySqliteBusy(() => this.transaction(async (tx) => {
      const held = await execute(tx, `SELECT 1 FROM ${this.tables.locks} WHERE thread_id = ? AND token = ? AND expires_at > ?`, [lock.threadId, lock.token, Date.now()])
      if (held.length === 0) return false
      for (const mutation of mutations) {
        if (mutation.type === "delete") await execute(tx, `DELETE FROM ${this.tables.cache} WHERE key = ?`, [mutation.key])
        else await execute(tx, `INSERT OR REPLACE INTO ${this.tables.cache} (key, value, expires_at) VALUES (?, ?, NULL)`, [mutation.key, JSON.stringify(mutation.value)])
      }
      return true
    }))
  }

  async releaseLock(lock: Lock): Promise<void> {
    await retrySqliteBusy(async () => {
      await this.cleanupExpiredStateIfDue()
      await this.transaction(async (tx) => await execute(tx, `DELETE FROM ${this.tables.locks} WHERE thread_id = ? AND token = ?`, [lock.threadId, lock.token]))
    })
  }

  async retryWebhookDelivery(
    scope: string,
    deliveryId: string,
    leaseToken: string,
    availableAt: number,
    options?: { incrementAttempts?: boolean },
  ): Promise<boolean> {
    const retried = await retrySqliteBusy(async () => {
      await this.cleanupExpiredStateIfDue()
      return await this.transaction(
        async (tx) =>
          await execute(
            tx,
            `UPDATE ${this.tables.webhookQueue}
        SET status = 'queued', available_at = ?, attempts = attempts + ?,
          lease_token = NULL, lease_expires_at = NULL
        WHERE scope = ? AND delivery_id = ? AND status IN ('running', 'steering') AND lease_token = ?
        RETURNING delivery_id`,
            [availableAt, options?.incrementAttempts === false ? 0 : 1, scope, deliveryId, leaseToken],
          ),
      )
    })
    return retried.length > 0
  }

  async webhookDeliveries(scope: string): Promise<AgentWebhookQueueDelivery[]> {
    await this.cleanupExpiredStateIfDue()
    const rows = await execute(
      this.driver,
      `SELECT value FROM ${this.tables.webhookQueue}
        WHERE scope = ? AND status != 'completed'
        ORDER BY id ASC`,
      [scope],
    )
    return rows.flatMap((row) => (isRuntimeString(row.value) ? [parseAgentWebhookQueueDelivery(row.value)] : []))
  }

  async webhookDeliveryScopes(): Promise<string[]> {
    await this.cleanupExpiredStateIfDue()
    const scopeRows = await execute(
      this.driver,
      `SELECT DISTINCT scope FROM ${this.tables.webhookQueue}
        WHERE status != 'completed'
        ORDER BY scope ASC`,
    )
    return scopeRows.flatMap((row) => (isRuntimeString(row.scope) ? [row.scope] : []))
  }

  async set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
    await this.cleanupExpiredStateIfDue()
    const expiresAt = ttlMs ? Date.now() + ttlMs : null
    await retrySqliteBusy(
      async () =>
        await this.transaction(
          async (tx) =>
            await execute(tx, `INSERT OR REPLACE INTO ${this.tables.cache} (key, value, expires_at) VALUES (?, ?, ?)`, [key, JSON.stringify(value), expiresAt]),
        ),
    )
  }

  async setIfNotExists(key: string, value: unknown, ttlMs?: number): Promise<boolean> {
    await this.cleanupExpiredStateIfDue()
    return await retrySqliteBusy(
      async () =>
        await this.transaction(async (tx) => {
          const now = Date.now()
          const existing = await execute(tx, `SELECT 1 FROM ${this.tables.cache} WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)`, [key, now])
          if (existing.length > 0) return false

          await execute(tx, `DELETE FROM ${this.tables.cache} WHERE key = ? AND expires_at IS NOT NULL AND expires_at <= ?`, [key, now])
          const expiresAt = ttlMs ? Date.now() + ttlMs : null
          await execute(tx, `INSERT INTO ${this.tables.cache} (key, value, expires_at) VALUES (?, ?, ?)`, [key, JSON.stringify(value), expiresAt])
          return true
        }),
    )
  }

  async subscribe(threadId: string): Promise<void> {
    await this.cleanupExpiredStateIfDue()
    await this.transaction(async (tx) => await execute(tx, `INSERT OR IGNORE INTO ${this.tables.subscriptions} (thread_id) VALUES (?)`, [threadId]))
  }

  async unsubscribe(threadId: string): Promise<void> {
    await this.cleanupExpiredStateIfDue()
    await this.transaction(async (tx) => await execute(tx, `DELETE FROM ${this.tables.subscriptions} WHERE thread_id = ?`, [threadId]))
  }

  private ensureConnected(): void {
    if (!this.connected) {
      throw agentDiagnostics.AGENT_R0851({ message: "[vitehub] SQLite Agent State is not connected. Call connect() before using state." })
    }
  }

  private async cleanupExpiredStateIfDue(): Promise<void> {
    this.ensureConnected()
    const now = Date.now()
    if (this.nextCleanupAt > now) {
      return
    }
    await this.deleteExpiredRows(now)
    this.nextCleanupAt = now + SQLITE_STATE_CLEANUP_INTERVAL_MS
  }

  private async deleteExpiredRows(now: number): Promise<void> {
    await this.serialize(async () => {
      await execute(this.driver, `DELETE FROM ${this.tables.locks} WHERE expires_at <= ?`, [now])
      await execute(this.driver, `DELETE FROM ${this.tables.cache} WHERE expires_at IS NOT NULL AND expires_at <= ?`, [now])
      await execute(this.driver, `DELETE FROM ${this.tables.queue} WHERE expires_at <= ?`, [now])
      await execute(this.driver, `DELETE FROM ${this.tables.lists} WHERE expires_at IS NOT NULL AND expires_at <= ?`, [now])
    })
  }

  private async migrate(): Promise<void> {
    // A current database does not need a write transaction just to read its
    // schema version. Keeping reconnects read-only avoids holding a libSQL
    // statement open while a large on-disk database is being opened.
    let currentVersion = 0
    try {
      const rows = await execute(this.driver, `SELECT COALESCE(MAX(version), 0) as version FROM ${this.tables.schemaVersion}`)
      currentVersion = numberValue(rows[0]?.version)
      if (currentVersion >= 5) return
    } catch (error) {
      if (!(error instanceof Error) || !/no such table/i.test(error.message)) throw error
    }
    await this.transaction(async (tx) => {
      await execute(tx, `CREATE TABLE IF NOT EXISTS ${this.tables.schemaVersion} (version INTEGER PRIMARY KEY)`)
      const versionRows = await execute(tx, `SELECT COALESCE(MAX(version), 0) as version FROM ${this.tables.schemaVersion}`)
      const version = numberValue(versionRows[0]?.version)
      if (version < 1) {
        await execute(tx, `CREATE TABLE IF NOT EXISTS ${this.tables.subscriptions} (thread_id TEXT PRIMARY KEY)`)
        await execute(tx, `CREATE TABLE IF NOT EXISTS ${this.tables.locks} (thread_id TEXT PRIMARY KEY, token TEXT NOT NULL, expires_at INTEGER NOT NULL)`)
        await execute(tx, `CREATE TABLE IF NOT EXISTS ${this.tables.cache} (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER)`)
        await execute(tx, `CREATE INDEX IF NOT EXISTS idx_${this.tables.locks}_expires ON ${this.tables.locks}(expires_at)`)
        await execute(tx, `CREATE INDEX IF NOT EXISTS idx_${this.tables.cache}_expires ON ${this.tables.cache}(expires_at) WHERE expires_at IS NOT NULL`)
        await execute(tx, `INSERT INTO ${this.tables.schemaVersion} (version) VALUES (1)`)
      }
      if (version < 2) {
        await execute(
          tx,
          `CREATE TABLE IF NOT EXISTS ${this.tables.queue} (id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, value TEXT NOT NULL, enqueued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`,
        )
        await execute(tx, `CREATE INDEX IF NOT EXISTS idx_${this.tables.queue}_thread ON ${this.tables.queue}(thread_id, id)`)
        await execute(tx, `CREATE INDEX IF NOT EXISTS idx_${this.tables.queue}_expires ON ${this.tables.queue}(expires_at)`)
        await execute(
          tx,
          `CREATE TABLE IF NOT EXISTS ${this.tables.lists} (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, value TEXT NOT NULL, expires_at INTEGER)`,
        )
        await execute(tx, `CREATE INDEX IF NOT EXISTS idx_${this.tables.lists}_key ON ${this.tables.lists}(key, id)`)
        await execute(tx, `CREATE INDEX IF NOT EXISTS idx_${this.tables.lists}_expires ON ${this.tables.lists}(expires_at) WHERE expires_at IS NOT NULL`)
        await execute(tx, `INSERT INTO ${this.tables.schemaVersion} (version) VALUES (2)`)
      }
      if (version < 3) {
        await execute(
          tx,
          `CREATE TABLE IF NOT EXISTS ${this.tables.webhookQueue} (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          scope TEXT NOT NULL,
          delivery_id TEXT NOT NULL,
          value TEXT NOT NULL,
          concurrency_group TEXT NOT NULL,
          concurrency_key TEXT,
          concurrency_limit INTEGER NOT NULL,
          lease_ttl_ms INTEGER NOT NULL,
          status TEXT NOT NULL,
          enqueued_at INTEGER NOT NULL,
          available_at INTEGER NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          lease_token TEXT,
          lease_expires_at INTEGER,
          UNIQUE (scope, delivery_id)
        )`,
        )
        await execute(tx, `CREATE INDEX IF NOT EXISTS idx_${this.tables.webhookQueue}_claim ON ${this.tables.webhookQueue}(scope, status, available_at, id)`)
        await execute(
          tx,
          `CREATE INDEX IF NOT EXISTS idx_${this.tables.webhookQueue}_group ON ${this.tables.webhookQueue}(concurrency_group, status, lease_expires_at)`,
        )
        await execute(
          tx,
          `CREATE INDEX IF NOT EXISTS idx_${this.tables.webhookQueue}_key ON ${this.tables.webhookQueue}(concurrency_key, status, lease_expires_at) WHERE concurrency_key IS NOT NULL`,
        )
        await execute(tx, `INSERT INTO ${this.tables.schemaVersion} (version) VALUES (3)`)
        await execute(tx, `INSERT INTO ${this.tables.schemaVersion} (version) VALUES (4)`)
      } else if (version < 4) {
        const migratedWebhookQueue = `${this.tables.webhookQueue}_v4`
        await execute(
          tx,
          `CREATE TABLE ${migratedWebhookQueue} (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          scope TEXT NOT NULL,
          delivery_id TEXT NOT NULL,
          value TEXT NOT NULL,
          concurrency_group TEXT NOT NULL,
          concurrency_key TEXT,
          concurrency_limit INTEGER NOT NULL,
          lease_ttl_ms INTEGER NOT NULL,
          status TEXT NOT NULL,
          enqueued_at INTEGER NOT NULL,
          available_at INTEGER NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          lease_token TEXT,
          lease_expires_at INTEGER,
          UNIQUE (scope, delivery_id)
        )`,
        )
        await execute(
          tx,
          `INSERT INTO ${migratedWebhookQueue} (
          scope, delivery_id, value, concurrency_group, concurrency_key, concurrency_limit,
          lease_ttl_ms, status, enqueued_at, available_at, attempts, lease_token, lease_expires_at
        ) SELECT
          scope, delivery_id, value, concurrency_group, concurrency_key, concurrency_limit,
          lease_ttl_ms, status, enqueued_at, available_at, attempts, lease_token, lease_expires_at
        FROM ${this.tables.webhookQueue} ORDER BY enqueued_at ASC, rowid ASC`,
        )
        await execute(tx, `DROP TABLE ${this.tables.webhookQueue}`)
        await execute(tx, `ALTER TABLE ${migratedWebhookQueue} RENAME TO ${this.tables.webhookQueue}`)
        await execute(tx, `CREATE INDEX idx_${this.tables.webhookQueue}_claim ON ${this.tables.webhookQueue}(scope, status, available_at, id)`)
        await execute(tx, `CREATE INDEX idx_${this.tables.webhookQueue}_group ON ${this.tables.webhookQueue}(concurrency_group, status, lease_expires_at)`)
        await execute(
          tx,
          `CREATE INDEX idx_${this.tables.webhookQueue}_key ON ${this.tables.webhookQueue}(concurrency_key, status, lease_expires_at) WHERE concurrency_key IS NOT NULL`,
        )
        await execute(tx, `INSERT INTO ${this.tables.schemaVersion} (version) VALUES (4)`)
      }
      if (version < 5) {
        await execute(
          tx,
          `CREATE INDEX IF NOT EXISTS idx_${this.tables.webhookQueue}_active_scope ON ${this.tables.webhookQueue}(scope) WHERE status != 'completed'`,
        )
        await execute(tx, `INSERT INTO ${this.tables.schemaVersion} (version) VALUES (5)`)
      }
    })
  }

  private async transaction<T>(run: (executor: SqliteAgentStateExecutor) => MaybePromise<T>): Promise<T> {
    return await this.serialize(async () => {
      this.ensureConnected()
      if (this.driver.transaction) {
        return await this.driver.transaction(run)
      }
      await execute(this.driver, "BEGIN IMMEDIATE")
      try {
        const result = await run(this.driver)
        await execute(this.driver, "COMMIT")
        return result
      } catch (error) {
        await execute(this.driver, "ROLLBACK").catch(() => undefined)
        throw error
      }
    })
  }

  private async serialize<T>(run: () => MaybePromise<T>): Promise<T> {
    const previous = this.transactionTail
    let release!: () => void
    this.transactionTail = new Promise((resolve) => (release = resolve))
    await previous
    try {
      return await run()
    } finally {
      release()
    }
  }
}

export function createSqliteAgentState(options: SqliteAgentStateOptions): ViteHubSqliteAgentStateAdapter {
  return new ViteHubSqliteAgentStateAdapter(options)
}

function libsqlExecute(client: Pick<LibsqlAgentStateClient, "execute">): SqliteAgentStateExecutor["execute"] {
  return async (statement, args = []) => await client.execute({ args, sql: statement })
}

// Local libSQL clients can leave native statements busy when independent writers
// contend. Coordinate Agent State transactions across adapters for the same database.
const libsqlWriteTails = new Map<string | LibsqlAgentStateClient, Promise<void>>()

async function serializeLibsqlWrite<T>(key: string | LibsqlAgentStateClient | undefined, run: () => Promise<T>): Promise<T> {
  if (key === undefined) return await run()
  const previous = libsqlWriteTails.get(key)
  let release!: () => void
  const tail = new Promise<void>(resolve => { release = resolve })
  libsqlWriteTails.set(key, tail)
  await previous
  try {
    return await run()
  } finally {
    if (libsqlWriteTails.get(key) === tail) libsqlWriteTails.delete(key)
    release()
  }
}

function libsqlFilePath(url: string | undefined): string | undefined {
  if (!url || !/^file:/i.test(url)) return
  // libSQL accepts relative file: paths, which the standard URL parser does not.
  const path = /^file:\/\//i.test(url)
    ? fileURLToPath(url)
    : decodeURIComponent(url.slice(5).split(/[?#]/, 1)[0]!)
  if (path === ":memory:" || /[?&]mode=memory(?:&|$)/.test(url)) return
  return resolve(path)
}

function libsqlSharedMemoryKey(url: string | undefined): string | undefined {
  if (!url || !/^file:/i.test(url)) return
  const [path, query] = url.slice(5).split("?", 2)
  // libSQL accepts percent-encoded paths and query parameters. SQLite uses
  // the last cache parameter when it occurs more than once.
  if (decodeURIComponent(path!) === ":memory:" && new URLSearchParams(query).getAll("cache").at(-1) === "shared") {
    return "file::memory:?cache=shared"
  }
}

export function createLibsqlAgentState(options: LibsqlAgentStateOptions): ViteHubSqliteAgentStateAdapter {
  if (!options.client && !options.url) {
    throw agentDiagnostics.AGENT_R0852({ message: "[vitehub] libSQL Agent State requires `url` or `client`." })
  }
  const ownsClient = !options.client
  let client: LibsqlAgentStateClient | undefined
  let writeKey: string | LibsqlAgentStateClient | undefined
  const openClient = async () => {
    if (options.client) return options.client
    const filePath = libsqlFilePath(options.url)
    if (filePath) {
      const directory = dirname(filePath)
      if (directory && directory !== ".") await mkdir(directory, { recursive: true })
    }
    const { createClient } = await import("@libsql/client")
    // SAFETY: The owning Agent runtime boundary establishes the asserted representation before this value is used.
    const opened = createClient({ authToken: options.authToken, url: options.url! }) as LibsqlAgentStateClient
    if (filePath) {
      try {
        // A retained read snapshot must not block queue and lease commits.
        // Configure only owned persistent files, leaving supplied clients and
        // remote databases under their caller's connection policy.
        // Give legacy readers a startup window to release the exclusive mode-change lock.
        const requested = options.journalMode === "delete" ? "delete" : "wal"
        const result = await retrySqliteBusy(async () => await opened.execute(`PRAGMA journal_mode = ${requested.toUpperCase()}`), 30_000)
        const actual = rows(result)[0]?.journal_mode
        if (actual !== requested) throw agentDiagnostics.AGENT_R0947({ requested, actual: String(actual) })
      } catch (error) {
        await opened.close?.()
        throw error
      }
    }
    return opened
  }

  return createSqliteAgentState({
    ...options,
    durable: options.client ? options.durable === true : options.url
      ? !options.url.includes(":memory:") && !/[?&]mode=memory(?:&|$)/.test(options.url) && options.durable !== false
      : options.durable === true,
    driver: {
      async connect() {
        writeKey = options.client ?? libsqlSharedMemoryKey(options.url)
        const path = options.client ? undefined : libsqlFilePath(options.url)
        if (path) {
          await mkdir(dirname(path), { recursive: true })
          writeKey = await realpath(path).catch(async () => join(await realpath(dirname(path)), basename(path)))
        }
        client ||= await serializeLibsqlWrite(writeKey, openClient)
        if (options.url === ":memory:" || /^file:/i.test(options.url || "")) writeKey ??= client
      },
      async disconnect() {
        const closing = client
        client = undefined
        await serializeLibsqlWrite(writeKey, async () => {
          if (ownsClient) await closing?.close?.()
        })
      },
      async execute(statement, args) {
        if (!client) throw agentDiagnostics.AGENT_R0853({ message: "[vitehub] libSQL Agent State is not connected." })
        const connected = client
        return await serializeLibsqlWrite(writeKey, async () => await libsqlExecute(connected)(statement, args))
      },
      async transaction(run) {
        if (!client) throw agentDiagnostics.AGENT_R0854({ message: "[vitehub] libSQL Agent State is not connected." })
        if (!client.transaction) {
          throw agentDiagnostics.AGENT_R0855({ message: "[vitehub] libSQL Agent State clients must support transactions." })
        }
        const connected = client
        return await serializeLibsqlWrite(writeKey, async () => {
          const transaction = await connected.transaction("write")
          try {
            const result = await run({ execute: libsqlExecute(transaction) })
            await transaction.commit()
            return result
          } catch (error) {
            await Promise.resolve(transaction.rollback()).catch(() => undefined)
            throw error
          } finally {
            await transaction.close?.()
          }
        })
      },
    },
  })
}
