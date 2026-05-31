import { appendFile } from "node:fs/promises"
import { join } from "node:path"

import type { Nitro } from "nitro/types"
import type { ResolvedAgentModuleOptions } from "../../types.ts"

const AGENT_STATE_BINDING_NAME = "CHAT_STATE"
const AGENT_STATE_CLASS_NAME = "ViteHubAgentStateDO"
const AGENT_STATE_MIGRATION_TAG = "vitehub-agent-state-v1"

interface WranglerDurableObjectBinding {
  class_name: string
  name: string
  script_name?: string
}

interface WranglerMigration {
  new_sqlite_classes?: string[]
  tag: string
}

interface WranglerConfig {
  durable_objects?: {
    bindings?: WranglerDurableObjectBinding[]
  }
  migrations?: WranglerMigration[]
}

interface NitroCloudflareOptions {
  cloudflare?: {
    wrangler?: WranglerConfig
  }
}

export function isCloudflarePreset(nitro: Nitro): boolean {
  return Boolean(nitro.options.preset?.includes("cloudflare"))
}

function isCloudflareAgentStateProvider(provider: string): boolean {
  return provider === "auto" || provider === "cloudflare" || provider === "cloudflare-agents"
}

function isExplicitCloudflareAgentStateProvider(provider: string): boolean {
  return provider === "cloudflare" || provider === "cloudflare-agents"
}

function installCloudflareAgentStateMigration(wrangler: WranglerConfig): void {
  wrangler.migrations ||= []
  const migration = wrangler.migrations.find(entry => entry.tag === AGENT_STATE_MIGRATION_TAG)
  if (migration) {
    migration.new_sqlite_classes ||= []
    if (!migration.new_sqlite_classes.includes(AGENT_STATE_CLASS_NAME)) {
      migration.new_sqlite_classes.push(AGENT_STATE_CLASS_NAME)
    }
    return
  }
  wrangler.migrations.push({
    new_sqlite_classes: [AGENT_STATE_CLASS_NAME],
    tag: AGENT_STATE_MIGRATION_TAG,
  })
}

export function installCloudflareAgentStateProvider(nitro: Nitro, options: false | ResolvedAgentModuleOptions): boolean {
  if (!options || !isCloudflarePreset(nitro) || !isCloudflareAgentStateProvider(options.providers.state.provider)) {
    return false
  }

  const target = nitro.options as Nitro["options"] & NitroCloudflareOptions
  target.cloudflare ||= {}
  target.cloudflare.wrangler ||= {}
  const wrangler = target.cloudflare.wrangler as WranglerConfig
  wrangler.durable_objects ||= { bindings: [] }
  const durableObjects = wrangler.durable_objects
  durableObjects.bindings ||= []

  const existing = durableObjects.bindings.find(binding => binding.name === AGENT_STATE_BINDING_NAME)
  if (existing) {
    if (existing.class_name === AGENT_STATE_CLASS_NAME && !existing.script_name) {
      installCloudflareAgentStateMigration(wrangler)
      return true
    }
    if (isExplicitCloudflareAgentStateProvider(options.providers.state.provider)) {
      throw new Error(`[vitehub] Agent State Provider "cloudflare" requires CHAT_STATE to be bound to ${AGENT_STATE_CLASS_NAME}. Remove the existing CHAT_STATE Durable Object binding or configure chat({ state }) for a custom state provider.`)
    }
    return false
  }

  durableObjects.bindings.push({
    class_name: AGENT_STATE_CLASS_NAME,
    name: AGENT_STATE_BINDING_NAME,
  })
  installCloudflareAgentStateMigration(wrangler)
  return true
}

export async function appendCloudflareAgentStateClassExport(nitro: Nitro): Promise<void> {
  await appendFile(join(nitro.options.output.serverDir, "index.mjs"), createCloudflareAgentStateClassExport(), "utf8")
}

function createCloudflareAgentStateClassExport(): string {
  return `
import { DurableObject as ViteHubAgentStateDurableObject } from "cloudflare:workers"

export class ${AGENT_STATE_CLASS_NAME} extends ViteHubAgentStateDurableObject {
  constructor(ctx, env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    ctx.blockConcurrencyWhile(async () => {
      this.migrate()
    })
  }

  acquireLock(threadId, ttlMs) {
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

  async alarm() {
    await this.cleanupExpiredState()
  }

  cacheDelete(key) {
    this.sql.exec("DELETE FROM cache WHERE key = ?", key)
  }

  cacheGet(key) {
    const rows = this.sql.exec(
      "SELECT value FROM cache WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)",
      key,
      Date.now(),
    ).toArray()
    return typeof rows[0]?.value === "string" ? rows[0].value : null
  }

  cacheSet(key, value, ttlMs) {
    const expiresAt = ttlMs ? Date.now() + ttlMs : null
    this.sql.exec("INSERT OR REPLACE INTO cache (key, value, expires_at) VALUES (?, ?, ?)", key, value, expiresAt)
    if (expiresAt !== null) this.scheduleCleanupIfNeeded()
  }

  cacheSetIfNotExists(key, value, ttlMs) {
    const now = Date.now()
    const result = this.ctx.storage.transactionSync(() => {
      const existing = this.sql.exec(
        "SELECT 1 FROM cache WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)",
        key,
        now,
      ).toArray()
      if (existing.length > 0) return { expiresAt: null, inserted: false }

      this.sql.exec("DELETE FROM cache WHERE key = ? AND expires_at IS NOT NULL AND expires_at <= ?", key, now)
      const expiresAt = ttlMs ? Date.now() + ttlMs : null
      this.sql.exec("INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?)", key, value, expiresAt)
      return { expiresAt, inserted: true }
    })
    if (result.inserted && result.expiresAt !== null) this.scheduleCleanupIfNeeded()
    return result.inserted
  }

  dequeue(threadId) {
    return this.ctx.storage.transactionSync(() => {
      const now = Date.now()
      this.sql.exec("DELETE FROM queue WHERE thread_id = ? AND expires_at <= ?", threadId, now)
      const rows = this.sql.exec("SELECT id, value FROM queue WHERE thread_id = ? ORDER BY id ASC LIMIT 1", threadId).toArray()
      const row = rows[0]
      if (!row) return null
      this.sql.exec("DELETE FROM queue WHERE id = ?", row.id)
      return typeof row.value === "string" ? row.value : null
    })
  }

  enqueue(threadId, value, maxSize) {
    const entry = JSON.parse(value)
    const result = this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        "INSERT INTO queue (thread_id, value, enqueued_at, expires_at) VALUES (?, ?, ?, ?)",
        threadId,
        value,
        entry.enqueuedAt,
        entry.expiresAt,
      )
      this.sql.exec(
        \`DELETE FROM queue WHERE thread_id = ? AND id NOT IN (
          SELECT id FROM queue WHERE thread_id = ? ORDER BY id DESC LIMIT ?
        )\`,
        threadId,
        threadId,
        maxSize,
      )
      return Number(this.sql.exec("SELECT COUNT(*) as cnt FROM queue WHERE thread_id = ?", threadId).one().cnt)
    })
    this.scheduleCleanupIfNeeded()
    return result
  }

  extendLock(threadId, token, ttlMs) {
    return this.ctx.storage.transactionSync(() => {
      const now = Date.now()
      const rows = this.sql.exec(
        \`UPDATE locks SET expires_at = ?
          WHERE thread_id = ? AND token = ? AND expires_at > ?
          RETURNING thread_id\`,
        now + ttlMs,
        threadId,
        token,
        now,
      ).toArray()
      return rows.length > 0
    })
  }

  forceReleaseLock(threadId) {
    this.sql.exec("DELETE FROM locks WHERE thread_id = ?", threadId)
  }

  isSubscribed(threadId) {
    return this.sql.exec("SELECT 1 FROM subscriptions WHERE thread_id = ? LIMIT 1", threadId).toArray().length > 0
  }

  listAppend(key, value, maxLength, ttlMs) {
    const expiresAt = ttlMs ? Date.now() + ttlMs : null
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("INSERT INTO lists (key, value, expires_at) VALUES (?, ?, ?)", key, value, expiresAt)
      if (expiresAt !== null) {
        this.sql.exec("UPDATE lists SET expires_at = ? WHERE key = ?", expiresAt, key)
      }
      if (maxLength != null && maxLength > 0) {
        this.sql.exec(
          \`DELETE FROM lists WHERE key = ? AND id NOT IN (
            SELECT id FROM lists WHERE key = ? ORDER BY id DESC LIMIT ?
          )\`,
          key,
          key,
          maxLength,
        )
      }
    })
    if (expiresAt !== null) this.scheduleCleanupIfNeeded()
  }

  listGet(key) {
    const now = Date.now()
    this.sql.exec("DELETE FROM lists WHERE key = ? AND expires_at IS NOT NULL AND expires_at <= ?", key, now)
    return this.sql.exec("SELECT value FROM lists WHERE key = ? ORDER BY id ASC", key)
      .toArray()
      .map(row => typeof row.value === "string" ? row.value : JSON.stringify(row.value))
  }

  queueDepth(threadId) {
    return Number(this.sql.exec(
      "SELECT COUNT(*) as cnt FROM queue WHERE thread_id = ? AND expires_at > ?",
      threadId,
      Date.now(),
    ).one().cnt)
  }

  releaseLock(threadId, token) {
    this.sql.exec("DELETE FROM locks WHERE thread_id = ? AND token = ?", threadId, token)
  }

  subscribe(threadId) {
    this.sql.exec("INSERT OR IGNORE INTO subscriptions (thread_id) VALUES (?)", threadId)
  }

  unsubscribe(threadId) {
    this.sql.exec("DELETE FROM subscriptions WHERE thread_id = ?", threadId)
  }

  async cleanupExpiredState() {
    try {
      const now = Date.now()
      this.sql.exec("DELETE FROM locks WHERE expires_at <= ?", now)
      this.sql.exec("DELETE FROM cache WHERE expires_at IS NOT NULL AND expires_at <= ?", now)
      this.sql.exec("DELETE FROM queue WHERE expires_at <= ?", now)
      this.sql.exec("DELETE FROM lists WHERE expires_at IS NOT NULL AND expires_at <= ?", now)
      const next = this.nextExpiry()
      if (next !== null) await this.ctx.storage.setAlarm(next)
    }
    catch {
      await this.ctx.storage.setAlarm(Date.now() + 30000)
    }
  }

  migrate() {
    this.sql.exec(\`
      CREATE TABLE IF NOT EXISTS _schema_version (
        version INTEGER PRIMARY KEY
      );
    \`)
    const row = this.sql.exec("SELECT COALESCE(MAX(version), 0) as version FROM _schema_version").one()
    const version = Number(row.version || 0)
    if (version < 1) {
      this.sql.exec(\`
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
      \`)
    }
    if (version < 2) {
      this.sql.exec(\`
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
      \`)
    }
  }

  nextExpiry() {
    const now = Date.now()
    const row = this.sql.exec(
      \`SELECT MIN(expires_at) as next_expiry FROM (
        SELECT expires_at FROM locks WHERE expires_at > ?
        UNION ALL
        SELECT expires_at FROM cache WHERE expires_at IS NOT NULL AND expires_at > ?
        UNION ALL
        SELECT expires_at FROM queue WHERE expires_at > ?
        UNION ALL
        SELECT expires_at FROM lists WHERE expires_at IS NOT NULL AND expires_at > ?
      )\`,
      now,
      now,
      now,
      now,
    ).one()
    return typeof row.next_expiry === "number" ? row.next_expiry : null
  }

  scheduleCleanupIfNeeded() {
    const next = this.nextExpiry()
    if (next !== null) {
      this.ctx.storage.setAlarm(next).catch(() => undefined)
    }
  }
}
`
}
