import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"

import type { AgentWebhookQueueDelivery, AgentWebhookQueueLease, AgentWebhookQueueStateAdapter } from "../internal/webhook-queue.ts"

import type { Lock, QueueEntry } from "chat"

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
  driver: SqliteAgentStateDriver
  tablePrefix?: string
}

export interface LibsqlAgentStateClient {
  close?: () => MaybePromise<void>
  execute: (statement: string | { args?: unknown[], sql: string }) => MaybePromise<SqliteAgentStateResult>
  transaction?: (mode?: "deferred" | "read" | "write") => MaybePromise<{
    close?: () => MaybePromise<void>
    commit: () => MaybePromise<void>
    execute: (statement: string | { args?: unknown[], sql: string }) => MaybePromise<SqliteAgentStateResult>
    rollback: () => MaybePromise<void>
  }>
}

export interface LibsqlAgentStateOptions extends Omit<SqliteAgentStateOptions, "driver"> {
  authToken?: string
  client?: LibsqlAgentStateClient
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
    throw new Error(`[vitehub] Invalid SQLite Agent State table name "${candidate}". Use an alphanumeric tablePrefix.`)
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
  return typeof value === "bigint" ? Number(value) : Number(value || 0)
}

async function execute(executor: SqliteAgentStateExecutor, statement: string, args: unknown[] = []): Promise<SqliteAgentStateRow[]> {
  return rows(await executor.execute(statement, args))
}

export class ViteHubSqliteAgentStateAdapter implements AgentWebhookQueueStateAdapter {
  private connected = false
  private connectPromise?: Promise<void>
  private readonly driver: SqliteAgentStateDriver
  private nextCleanupAt = 0
  private readonly tables: StateTables

  constructor(options: SqliteAgentStateOptions) {
    if (!options.driver) {
      throw new Error("[vitehub] SQLite Agent State requires a driver.")
    }
    this.driver = options.driver
    this.tables = createTables(options.tablePrefix)
  }

  async acquireLock(threadId: string, ttlMs: number): Promise<Lock | null> {
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
  }

  async appendToList(key: string, value: unknown, options?: { maxLength?: number, ttlMs?: number }): Promise<void> {
    await this.cleanupExpiredStateIfDue()
    const now = Date.now()
    const expiresAt = options?.ttlMs ? now + options.ttlMs : null
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
        `SELECT delivery_id, value, concurrency_group, concurrency_key, concurrency_limit, lease_ttl_ms, attempts
          FROM ${this.tables.webhookQueue}
          WHERE scope = ? AND available_at <= ?
            AND (status = 'queued' OR (status = 'running' AND lease_expires_at <= ?))
          ORDER BY enqueued_at ASC LIMIT 100`,
        [scope, now, now],
      )
      for (const candidate of candidates) {
        const group = String(candidate.concurrency_group)
        const limit = numberValue(candidate.concurrency_limit)
        const activeGroup = await execute(
          tx,
          `SELECT COUNT(*) AS count FROM ${this.tables.webhookQueue}
            WHERE status = 'running' AND lease_expires_at > ? AND concurrency_group = ?`,
          [now, group],
        )
        if (numberValue(activeGroup[0]?.count) >= limit) continue
        const concurrencyKey = typeof candidate.concurrency_key === "string" ? candidate.concurrency_key : undefined
        if (concurrencyKey) {
          const activeKey = await execute(
            tx,
            `SELECT 1 FROM ${this.tables.webhookQueue}
              WHERE status = 'running' AND lease_expires_at > ? AND concurrency_key = ? LIMIT 1`,
            [now, concurrencyKey],
          )
          if (activeKey.length > 0) continue
        }
        const leaseToken = randomToken()
        const leaseTtlMs = numberValue(candidate.lease_ttl_ms)
        const claimed = await execute(
          tx,
          `UPDATE ${this.tables.webhookQueue}
            SET status = 'running', lease_token = ?, lease_expires_at = ?
            WHERE scope = ? AND delivery_id = ?
              AND (status = 'queued' OR (status = 'running' AND lease_expires_at <= ?))
            RETURNING value`,
          [leaseToken, now + leaseTtlMs, scope, candidate.delivery_id, now],
        )
        if (claimed.length === 0 || typeof candidate.value !== "string") continue
        return {
          ...JSON.parse(candidate.value) as AgentWebhookQueueDelivery,
          attempts: numberValue(candidate.attempts),
          leaseExpiresAt: now + leaseTtlMs,
          leaseToken,
        }
      }
      return null
    })
  }

  async completeWebhookDelivery(scope: string, deliveryId: string, leaseToken: string): Promise<boolean> {
    await this.cleanupExpiredStateIfDue()
    const completed = await execute(
      this.driver,
      `UPDATE ${this.tables.webhookQueue}
        SET status = 'completed', value = '{}', lease_token = NULL, lease_expires_at = NULL
        WHERE scope = ? AND delivery_id = ? AND status = 'running' AND lease_token = ?
        RETURNING delivery_id`,
      [scope, deliveryId, leaseToken],
    )
    return completed.length > 0
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
      await this.cleanupExpiredState()
    }
    catch (error) {
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
      return typeof row.value === "string" ? JSON.parse(row.value) as QueueEntry : null
    })
  }

  async disconnect(): Promise<void> {
    this.connected = false
    await this.driver.disconnect?.()
  }

  async enqueueWebhookDelivery(delivery: AgentWebhookQueueDelivery): Promise<boolean> {
    await this.cleanupExpiredStateIfDue()
    const inserted = await execute(
      this.driver,
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
    )
    return inserted.length > 0
  }

  async enqueue(threadId: string, entry: QueueEntry, maxSize: number): Promise<number> {
    await this.cleanupExpiredStateIfDue()
    return await this.transaction(async (tx) => {
      await execute(
        tx,
        `INSERT INTO ${this.tables.queue} (thread_id, value, enqueued_at, expires_at) VALUES (?, ?, ?, ?)`,
        [threadId, JSON.stringify(entry), entry.enqueuedAt, entry.expiresAt],
      )
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
    const extended = await execute(
      this.driver,
      `UPDATE ${this.tables.webhookQueue} SET lease_expires_at = ?
        WHERE scope = ? AND delivery_id = ? AND status = 'running'
          AND lease_token = ? AND lease_expires_at > ? RETURNING delivery_id`,
      [now + ttlMs, scope, deliveryId, leaseToken, now],
    )
    return extended.length > 0
  }

  async forceReleaseLock(threadId: string): Promise<void> {
    await this.cleanupExpiredStateIfDue()
    await execute(this.driver, `DELETE FROM ${this.tables.locks} WHERE thread_id = ?`, [threadId])
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    await this.cleanupExpiredStateIfDue()
    const valueRows = await execute(
      this.driver,
      `SELECT value FROM ${this.tables.cache} WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)`,
      [key, Date.now()],
    )
    const value = valueRows[0]?.value
    return typeof value === "string" ? JSON.parse(value) as T : null
  }

  async getList<T = unknown>(key: string): Promise<T[]> {
    await this.cleanupExpiredStateIfDue()
    const now = Date.now()
    await execute(this.driver, `DELETE FROM ${this.tables.lists} WHERE key = ? AND expires_at IS NOT NULL AND expires_at <= ?`, [key, now])
    const valueRows = await execute(this.driver, `SELECT value FROM ${this.tables.lists} WHERE key = ? ORDER BY id ASC`, [key])
    return valueRows.map(row => JSON.parse(String(row.value)) as T)
  }

  async isSubscribed(threadId: string): Promise<boolean> {
    await this.cleanupExpiredStateIfDue()
    const subscriptions = await execute(this.driver, `SELECT 1 FROM ${this.tables.subscriptions} WHERE thread_id = ? LIMIT 1`, [threadId])
    return subscriptions.length > 0
  }

  async queueDepth(threadId: string): Promise<number> {
    await this.cleanupExpiredStateIfDue()
    const countRows = await execute(
      this.driver,
      `SELECT COUNT(*) as count FROM ${this.tables.queue} WHERE thread_id = ? AND expires_at > ?`,
      [threadId, Date.now()],
    )
    return numberValue(countRows[0]?.count)
  }

  async releaseLock(lock: Lock): Promise<void> {
    await this.cleanupExpiredStateIfDue()
    await execute(this.driver, `DELETE FROM ${this.tables.locks} WHERE thread_id = ? AND token = ?`, [lock.threadId, lock.token])
  }

  async retryWebhookDelivery(scope: string, deliveryId: string, leaseToken: string, availableAt: number): Promise<boolean> {
    await this.cleanupExpiredStateIfDue()
    const retried = await execute(
      this.driver,
      `UPDATE ${this.tables.webhookQueue}
        SET status = 'queued', available_at = ?, attempts = attempts + 1,
          lease_token = NULL, lease_expires_at = NULL
        WHERE scope = ? AND delivery_id = ? AND status = 'running' AND lease_token = ?
        RETURNING delivery_id`,
      [availableAt, scope, deliveryId, leaseToken],
    )
    return retried.length > 0
  }

  async set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
    await this.cleanupExpiredStateIfDue()
    const expiresAt = ttlMs ? Date.now() + ttlMs : null
    await execute(this.driver, `INSERT OR REPLACE INTO ${this.tables.cache} (key, value, expires_at) VALUES (?, ?, ?)`, [key, JSON.stringify(value), expiresAt])
  }

  async setIfNotExists(key: string, value: unknown, ttlMs?: number): Promise<boolean> {
    await this.cleanupExpiredStateIfDue()
    return await this.transaction(async (tx) => {
      const now = Date.now()
      const existing = await execute(
        tx,
        `SELECT 1 FROM ${this.tables.cache} WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)`,
        [key, now],
      )
      if (existing.length > 0) return false

      await execute(tx, `DELETE FROM ${this.tables.cache} WHERE key = ? AND expires_at IS NOT NULL AND expires_at <= ?`, [key, now])
      const expiresAt = ttlMs ? Date.now() + ttlMs : null
      await execute(tx, `INSERT INTO ${this.tables.cache} (key, value, expires_at) VALUES (?, ?, ?)`, [key, JSON.stringify(value), expiresAt])
      return true
    })
  }

  async subscribe(threadId: string): Promise<void> {
    await this.cleanupExpiredStateIfDue()
    await execute(this.driver, `INSERT OR IGNORE INTO ${this.tables.subscriptions} (thread_id) VALUES (?)`, [threadId])
  }

  async unsubscribe(threadId: string): Promise<void> {
    await this.cleanupExpiredStateIfDue()
    await execute(this.driver, `DELETE FROM ${this.tables.subscriptions} WHERE thread_id = ?`, [threadId])
  }

  private ensureConnected(): void {
    if (!this.connected) {
      throw new Error("[vitehub] SQLite Agent State is not connected. Call connect() before using state.")
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
    await execute(this.driver, `DELETE FROM ${this.tables.locks} WHERE expires_at <= ?`, [now])
    await execute(this.driver, `DELETE FROM ${this.tables.cache} WHERE expires_at IS NOT NULL AND expires_at <= ?`, [now])
    await execute(this.driver, `DELETE FROM ${this.tables.queue} WHERE expires_at <= ?`, [now])
    await execute(this.driver, `DELETE FROM ${this.tables.lists} WHERE expires_at IS NOT NULL AND expires_at <= ?`, [now])
  }

  private async migrate(): Promise<void> {
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
        await execute(tx, `CREATE TABLE IF NOT EXISTS ${this.tables.queue} (id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, value TEXT NOT NULL, enqueued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`)
        await execute(tx, `CREATE INDEX IF NOT EXISTS idx_${this.tables.queue}_thread ON ${this.tables.queue}(thread_id, id)`)
        await execute(tx, `CREATE INDEX IF NOT EXISTS idx_${this.tables.queue}_expires ON ${this.tables.queue}(expires_at)`)
        await execute(tx, `CREATE TABLE IF NOT EXISTS ${this.tables.lists} (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, value TEXT NOT NULL, expires_at INTEGER)`)
        await execute(tx, `CREATE INDEX IF NOT EXISTS idx_${this.tables.lists}_key ON ${this.tables.lists}(key, id)`)
        await execute(tx, `CREATE INDEX IF NOT EXISTS idx_${this.tables.lists}_expires ON ${this.tables.lists}(expires_at) WHERE expires_at IS NOT NULL`)
        await execute(tx, `INSERT INTO ${this.tables.schemaVersion} (version) VALUES (2)`)
      }
      if (version < 3) {
        await execute(tx, `CREATE TABLE IF NOT EXISTS ${this.tables.webhookQueue} (
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
          PRIMARY KEY (scope, delivery_id)
        )`)
        await execute(tx, `CREATE INDEX IF NOT EXISTS idx_${this.tables.webhookQueue}_claim ON ${this.tables.webhookQueue}(scope, status, available_at, enqueued_at)`)
        await execute(tx, `CREATE INDEX IF NOT EXISTS idx_${this.tables.webhookQueue}_group ON ${this.tables.webhookQueue}(concurrency_group, status, lease_expires_at)`)
        await execute(tx, `CREATE INDEX IF NOT EXISTS idx_${this.tables.webhookQueue}_key ON ${this.tables.webhookQueue}(concurrency_key, status, lease_expires_at) WHERE concurrency_key IS NOT NULL`)
        await execute(tx, `INSERT INTO ${this.tables.schemaVersion} (version) VALUES (3)`)
      }
    })
  }

  private async transaction<T>(run: (executor: SqliteAgentStateExecutor) => MaybePromise<T>): Promise<T> {
    this.ensureConnected()
    if (this.driver.transaction) {
      return await this.driver.transaction(run)
    }
    await execute(this.driver, "BEGIN IMMEDIATE")
    try {
      const result = await run(this.driver)
      await execute(this.driver, "COMMIT")
      return result
    }
    catch (error) {
      await execute(this.driver, "ROLLBACK").catch(() => undefined)
      throw error
    }
  }
}

export function createSqliteAgentState(options: SqliteAgentStateOptions): ViteHubSqliteAgentStateAdapter {
  return new ViteHubSqliteAgentStateAdapter(options)
}

function libsqlExecute(client: LibsqlAgentStateClient): SqliteAgentStateExecutor["execute"] {
  return async (statement, args = []) => await client.execute({ args, sql: statement })
}

export function createLibsqlAgentState(options: LibsqlAgentStateOptions): ViteHubSqliteAgentStateAdapter {
  if (!options.client && !options.url) {
    throw new Error("[vitehub] libSQL Agent State requires `url` or `client`.")
  }
  const ownsClient = !options.client
  let client: LibsqlAgentStateClient | undefined
  const openClient = async () => {
    if (options.client) return options.client
    if (options.url?.startsWith("file:")) {
      const filePath = options.url.startsWith("file://")
        ? fileURLToPath(options.url)
        : options.url.slice("file:".length)
      const directory = dirname(filePath)
      if (directory && directory !== ".") await mkdir(directory, { recursive: true })
    }
    const { createClient } = await import("@libsql/client")
    return createClient({ authToken: options.authToken, url: options.url! }) as LibsqlAgentStateClient
  }

  return createSqliteAgentState({
    ...options,
    driver: {
      async connect() {
        client ||= await openClient()
      },
      async disconnect() {
        if (ownsClient) await client?.close?.()
        client = undefined
      },
      async execute(statement, args) {
        if (!client) throw new Error("[vitehub] libSQL Agent State is not connected.")
        return await libsqlExecute(client)(statement, args)
      },
      async transaction(run) {
        if (!client) throw new Error("[vitehub] libSQL Agent State is not connected.")
        if (!client.transaction) {
          return await run({ execute: libsqlExecute(client) })
        }
        const transaction = await client.transaction("write")
        try {
          const result = await run({ execute: libsqlExecute(transaction) })
          await transaction.commit()
          return result
        }
        catch (error) {
          await Promise.resolve(transaction.rollback()).catch(() => undefined)
          throw error
        }
        finally {
          await transaction.close?.()
        }
      },
    },
  })
}
