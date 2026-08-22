import { DurableObject } from "cloudflare:workers"

import { parseAgentStateQueueEntry } from "../internal/state-queue.ts"
import { isRuntimeNumber, isRuntimeString } from "../internal/runtime-value.ts"

import type { Lock } from "chat"

interface CloudflareSqlCursor {
  one(): Record<string, unknown>
  toArray(): Array<Record<string, unknown>>
}

interface CloudflareSqlStorage {
  exec(query: string, ...bindings: unknown[]): CloudflareSqlCursor
}

interface CloudflareDurableObjectStorage {
  setAlarm(timestamp: number): Promise<void>
  sql: CloudflareSqlStorage
  transactionSync<T>(callback: () => T): T
}

interface CloudflareDurableObjectState {
  blockConcurrencyWhile(callback: () => Promise<void>): void
  storage: CloudflareDurableObjectStorage
}

export class ViteHubAgentStateDO<TEnv = unknown> extends DurableObject<TEnv> {
  declare protected ctx: CloudflareDurableObjectState
  private readonly sql: CloudflareSqlStorage

  constructor(ctx: CloudflareDurableObjectState, env: TEnv) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    ctx.blockConcurrencyWhile(async () => {
      this.migrate()
    })
  }

  acquireLock(threadId: string, ttlMs: number): Lock | null {
    const result = this.ctx.storage.transactionSync(() => {
      const now = Date.now()
      this.sql.exec("DELETE FROM locks WHERE thread_id = ? AND expires_at <= ?", threadId, now)
      const existing = this.sql.exec("SELECT 1 FROM locks WHERE thread_id = ? LIMIT 1", threadId).toArray()
      if (existing.length > 0) return null

      const token = crypto.randomUUID()
      const expiresAt = now + ttlMs
      this.sql.exec("INSERT INTO locks (thread_id, token, expires_at) VALUES (?, ?, ?)", threadId, token, expiresAt)
      return { expiresAt, threadId, token }
    })
    if (result) this.scheduleCleanupIfNeeded()
    return result
  }

  alarm(): Promise<void> {
    return this.cleanupExpiredState()
  }

  cacheDelete(key: string): void {
    this.sql.exec("DELETE FROM cache WHERE key = ?", key)
    this.sql.exec("DELETE FROM lists WHERE key = ?", key)
  }

  cacheGet(key: string): string | null {
    const rows = this.sql.exec("SELECT value FROM cache WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)", key, Date.now()).toArray()
    return isRuntimeString(rows[0]?.value) ? rows[0].value : null
  }

  cacheSet(key: string, value: string, ttlMs?: number): void {
    const expiresAt = ttlMs ? Date.now() + ttlMs : null
    this.sql.exec("INSERT OR REPLACE INTO cache (key, value, expires_at) VALUES (?, ?, ?)", key, value, expiresAt)
    if (expiresAt !== null) this.scheduleCleanupIfNeeded()
  }

  cacheSetIfNotExists(key: string, value: string, ttlMs?: number): boolean {
    const now = Date.now()
    const result = this.ctx.storage.transactionSync(() => {
      const existing = this.sql.exec("SELECT 1 FROM cache WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)", key, now).toArray()
      if (existing.length > 0) return { expiresAt: null, inserted: false }

      this.sql.exec("DELETE FROM cache WHERE key = ? AND expires_at IS NOT NULL AND expires_at <= ?", key, now)
      const expiresAt = ttlMs ? Date.now() + ttlMs : null
      this.sql.exec("INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?)", key, value, expiresAt)
      return { expiresAt, inserted: true }
    })
    if (result.inserted && result.expiresAt !== null) this.scheduleCleanupIfNeeded()
    return result.inserted
  }

  dequeue(threadId: string): string | null {
    return this.ctx.storage.transactionSync(() => {
      const now = Date.now()
      this.sql.exec("DELETE FROM queue WHERE thread_id = ? AND expires_at <= ?", threadId, now)
      const rows = this.sql.exec("SELECT id, value FROM queue WHERE thread_id = ? ORDER BY id ASC LIMIT 1", threadId).toArray()
      const row = rows[0]
      if (!row) return null
      this.sql.exec("DELETE FROM queue WHERE id = ?", row.id)
      return isRuntimeString(row.value) ? row.value : null
    })
  }

  enqueue(threadId: string, value: string, maxSize: number): number {
    const entry = parseAgentStateQueueEntry(value)
    const result = this.ctx.storage.transactionSync(() => {
      this.sql.exec("INSERT INTO queue (thread_id, value, enqueued_at, expires_at) VALUES (?, ?, ?, ?)", threadId, value, entry.enqueuedAt, entry.expiresAt)
      this.sql.exec(
        `DELETE FROM queue WHERE thread_id = ? AND id NOT IN (
          SELECT id FROM queue WHERE thread_id = ? ORDER BY id DESC LIMIT ?
        )`,
        threadId,
        threadId,
        maxSize,
      )
      return Number(this.sql.exec("SELECT COUNT(*) as cnt FROM queue WHERE thread_id = ?", threadId).one().cnt)
    })
    this.scheduleCleanupIfNeeded()
    return result
  }

  queuePeek(threadId: string): string | null {
    return this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM queue WHERE thread_id = ? AND expires_at <= ?", threadId, Date.now())
      const row = this.sql.exec("SELECT value FROM queue WHERE thread_id = ? ORDER BY id ASC LIMIT 1", threadId).toArray()[0]
      return isRuntimeString(row?.value) ? row.value : null
    })
  }

  queueReplaceHead(threadId: string, expected: string | null, replacement: string[], maxSize: number): boolean {
    const replaced = this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM queue WHERE thread_id = ? AND expires_at <= ?", threadId, Date.now())
      const queue = this.sql.exec("SELECT value FROM queue WHERE thread_id = ? ORDER BY id ASC", threadId).toArray()
      const current = isRuntimeString(queue[0]?.value) ? queue[0].value : null
      if (current !== expected) return false
      const retained = queue.slice(expected === null ? 0 : 1).flatMap((row) => (isRuntimeString(row.value) ? [row.value] : []))
      const next = maxSize > 0 ? [...replacement, ...retained].slice(-maxSize) : [...replacement, ...retained]
      this.sql.exec("DELETE FROM queue WHERE thread_id = ?", threadId)
      for (const value of next) {
        const entry = parseAgentStateQueueEntry(value)
        this.sql.exec("INSERT INTO queue (thread_id, value, enqueued_at, expires_at) VALUES (?, ?, ?, ?)", threadId, value, entry.enqueuedAt, entry.expiresAt)
      }
      return true
    })
    if (replaced) this.scheduleCleanupIfNeeded()
    return replaced
  }

  extendLock(threadId: string, token: string, ttlMs: number): boolean {
    return this.ctx.storage.transactionSync(() => {
      const now = Date.now()
      const rows = this.sql
        .exec(
          `UPDATE locks SET expires_at = ?
          WHERE thread_id = ? AND token = ? AND expires_at > ?
          RETURNING thread_id`,
          now + ttlMs,
          threadId,
          token,
          now,
        )
        .toArray()
      return rows.length > 0
    })
  }

  forceReleaseLock(threadId: string): void {
    this.sql.exec("DELETE FROM locks WHERE thread_id = ?", threadId)
  }

  isSubscribed(threadId: string): boolean {
    return this.sql.exec("SELECT 1 FROM subscriptions WHERE thread_id = ? LIMIT 1", threadId).toArray().length > 0
  }

  listAppend(key: string, value: string, maxLength?: number, ttlMs?: number): void {
    const expiresAt = ttlMs ? Date.now() + ttlMs : null
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("INSERT INTO lists (key, value, expires_at) VALUES (?, ?, ?)", key, value, expiresAt)
      this.sql.exec("UPDATE lists SET expires_at = ? WHERE key = ?", expiresAt, key)
      if (maxLength != null && maxLength > 0) {
        this.sql.exec(
          `DELETE FROM lists WHERE key = ? AND id NOT IN (
            SELECT id FROM lists WHERE key = ? ORDER BY id DESC LIMIT ?
          )`,
          key,
          key,
          maxLength,
        )
      }
    })
    if (expiresAt !== null) this.scheduleCleanupIfNeeded()
  }

  listGet(key: string): string[] {
    const now = Date.now()
    this.sql.exec("DELETE FROM lists WHERE key = ? AND expires_at IS NOT NULL AND expires_at <= ?", key, now)
    return this.sql
      .exec("SELECT value FROM lists WHERE key = ? ORDER BY id ASC", key)
      .toArray()
      .map((row: { value?: unknown }) => (isRuntimeString(row.value) ? row.value : JSON.stringify(row.value)))
  }

  queueDepth(threadId: string): number {
    return Number(this.sql.exec("SELECT COUNT(*) as cnt FROM queue WHERE thread_id = ? AND expires_at > ?", threadId, Date.now()).one().cnt)
  }

  releaseLock(threadId: string, token: string): void {
    this.sql.exec("DELETE FROM locks WHERE thread_id = ? AND token = ?", threadId, token)
  }

  subscribe(threadId: string): void {
    this.sql.exec("INSERT OR IGNORE INTO subscriptions (thread_id) VALUES (?)", threadId)
  }

  unsubscribe(threadId: string): void {
    this.sql.exec("DELETE FROM subscriptions WHERE thread_id = ?", threadId)
  }

  private async cleanupExpiredState(): Promise<void> {
    try {
      const now = Date.now()
      this.sql.exec("DELETE FROM locks WHERE expires_at <= ?", now)
      this.sql.exec("DELETE FROM cache WHERE expires_at IS NOT NULL AND expires_at <= ?", now)
      this.sql.exec("DELETE FROM queue WHERE expires_at <= ?", now)
      this.sql.exec("DELETE FROM lists WHERE expires_at IS NOT NULL AND expires_at <= ?", now)
      const next = this.nextExpiry()
      if (next !== null) await this.ctx.storage.setAlarm(next)
    } catch {
      await this.ctx.storage.setAlarm(Date.now() + 30_000)
    }
  }

  private migrate(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS _schema_version (
        version INTEGER PRIMARY KEY
      );
    `)
    const row = this.sql.exec("SELECT COALESCE(MAX(version), 0) as version FROM _schema_version").one()
    const version = Number(row.version || 0)
    if (version < 1) {
      this.sql.exec(`
        CREATE TABLE subscriptions (
          thread_id TEXT PRIMARY KEY
        );

        CREATE TABLE locks (
          thread_id TEXT PRIMARY KEY,
          token TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        );

        CREATE TABLE cache (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          expires_at INTEGER
        );

        CREATE INDEX idx_locks_expires ON locks(expires_at);
        CREATE INDEX idx_cache_expires ON cache(expires_at)
          WHERE expires_at IS NOT NULL;

        INSERT INTO _schema_version (version) VALUES (1);
      `)
    }
    if (version < 2) {
      this.sql.exec(`
        CREATE TABLE queue (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          thread_id TEXT NOT NULL,
          value TEXT NOT NULL,
          enqueued_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );

        CREATE INDEX idx_queue_thread ON queue(thread_id, id);
        CREATE INDEX idx_queue_expires ON queue(expires_at);

        CREATE TABLE lists (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          expires_at INTEGER
        );

        CREATE INDEX idx_lists_key ON lists(key, id);
        CREATE INDEX idx_lists_expires ON lists(expires_at)
          WHERE expires_at IS NOT NULL;

        INSERT INTO _schema_version (version) VALUES (2);
      `)
    }
  }

  private nextExpiry(): number | null {
    const now = Date.now()
    const row = this.sql
      .exec(
        `SELECT MIN(expires_at) as next_expiry FROM (
        SELECT expires_at FROM locks WHERE expires_at > ?
        UNION ALL
        SELECT expires_at FROM cache WHERE expires_at IS NOT NULL AND expires_at > ?
        UNION ALL
        SELECT expires_at FROM queue WHERE expires_at > ?
        UNION ALL
        SELECT expires_at FROM lists WHERE expires_at IS NOT NULL AND expires_at > ?
      )`,
        now,
        now,
        now,
        now,
      )
      .one()
    return isRuntimeNumber(row.next_expiry) ? row.next_expiry : null
  }

  private scheduleCleanupIfNeeded(): void {
    const next = this.nextExpiry()
    if (next !== null) {
      this.ctx.storage.setAlarm(next).catch(() => undefined)
    }
  }
}
