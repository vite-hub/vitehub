import { and, asc, desc, eq, inArray, lt, or, sql } from "drizzle-orm"
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

import { webhooksErrors } from "./errors.ts"

import type { AnyRelations } from "drizzle-orm"
import type { SQLiteAsyncDatabase } from "drizzle-orm/sqlite-core"

/** Where a delivery is. `sending` holds a claim while one server posts it. */
export type WebhookDeliveryState = "pending" | "sending" | "sent" | "dead" | "cancelled"

const states = ["pending", "sending", "sent", "dead", "cancelled"] as const satisfies readonly WebhookDeliveryState[]

/**
 * One row for each delivery. A debounced webhook keeps one `pending` row for each `(webhook, key)`: each send replaces
 * its `body`, raises `revision` and `count`, and moves `due_at`. Times are milliseconds since the epoch.
 */
export const webhookDeliveries = sqliteTable("vitehub_webhook_deliveries", {
  id: text("id").primaryKey(),
  webhook: text("webhook").notNull(),
  /** The debounce key. `null` for a webhook without a debounce and for a redelivery: those rows never collapse. */
  key: text("key"),
  event: text("event").notNull(),
  /** The JSON text that the receiver gets, byte for byte. */
  body: text("body").notNull(),
  revision: integer("revision").notNull(),
  /** How many sends this delivery collapses. The receiver gets it in `x-vitehub-events`. */
  count: integer("count").notNull(),
  state: text("state", { enum: states }).notNull(),
  attempts: integer("attempts").notNull(),
  lastStatus: integer("last_status"),
  lastError: text("last_error"),
  dueAt: integer("due_at").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  sentAt: integer("sent_at"),
}, table => [
  uniqueIndex("vitehub_webhook_deliveries_pending").on(table.webhook, table.key).where(sql`state = 'pending'`),
  index("vitehub_webhook_deliveries_webhook").on(table.webhook, table.createdAt),
  index("vitehub_webhook_deliveries_state").on(table.state, table.dueAt),
])

/** How a member endpoint receives: a signed `POST` to a URL, or an inbox that the member's agent reads. */
export type MemberEndpointKind = "url" | "inbox"

const endpointKinds = ["url", "inbox"] as const satisfies readonly MemberEndpointKind[]

/**
 * One row for each member endpoint, at most one for each owner. `sealed` holds the URL and secret, encrypted with
 * `VITEHUB_WEBHOOKS_KEY`, and `null` for an inbox. `host` is the only part of the URL in plain text.
 */
export const webhookEndpoints = sqliteTable("vitehub_webhook_endpoints", {
  id: text("id").primaryKey(),
  owner: text("owner").notNull(),
  name: text("name").notNull(),
  kind: text("kind", { enum: endpointKinds }).notNull(),
  agent: text("agent"),
  host: text("host"),
  sealed: text("sealed"),
  disabledAt: integer("disabled_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, table => [
  uniqueIndex("vitehub_webhook_endpoints_owner").on(table.owner),
])

/** The table of Webhooks, for `defineDatabase({ schema })` or a Database contribution. */
export const webhooksSchema = { webhookDeliveries }

/** The table of member endpoints. Webhooks adds it only when a feature of the app uses member endpoints. */
export const webhookEndpointsSchema = { webhookEndpoints }

export { webhookEndpointsTableNames, webhooksTableNames } from "./table-names.ts"

/** The tables of `webhooksSchema` and `webhookEndpointsSchema` as SQLite statements that are safe to run on every start. */
export const webhooksTables: readonly string[] = [
  "CREATE TABLE IF NOT EXISTS `vitehub_webhook_deliveries` (`id` text PRIMARY KEY NOT NULL, `webhook` text NOT NULL, `key` text, `event` text NOT NULL, `body` text NOT NULL, `revision` integer NOT NULL, `count` integer NOT NULL, `state` text NOT NULL, `attempts` integer NOT NULL, `last_status` integer, `last_error` text, `due_at` integer NOT NULL, `created_at` integer NOT NULL, `updated_at` integer NOT NULL, `sent_at` integer)",
  "CREATE UNIQUE INDEX IF NOT EXISTS `vitehub_webhook_deliveries_pending` ON `vitehub_webhook_deliveries` (`webhook`,`key`) WHERE state = 'pending'",
  "CREATE INDEX IF NOT EXISTS `vitehub_webhook_deliveries_webhook` ON `vitehub_webhook_deliveries` (`webhook`,`created_at`)",
  "CREATE INDEX IF NOT EXISTS `vitehub_webhook_deliveries_state` ON `vitehub_webhook_deliveries` (`state`,`due_at`)",
  "CREATE TABLE IF NOT EXISTS `vitehub_webhook_endpoints` (`id` text PRIMARY KEY NOT NULL, `owner` text NOT NULL, `name` text NOT NULL, `kind` text NOT NULL, `agent` text, `host` text, `sealed` text, `disabled_at` integer, `created_at` integer NOT NULL, `updated_at` integer NOT NULL)",
  "CREATE UNIQUE INDEX IF NOT EXISTS `vitehub_webhook_endpoints_owner` ON `vitehub_webhook_endpoints` (`owner`)",
]

/** A Drizzle SQLite Database: libSQL, D1, or the Database of a ViteHub app. */
export type WebhooksDatabase = SQLiteAsyncDatabase<"async", unknown, AnyRelations>

/** One delivery, as code, the CLI, and the Console read it. */
export interface WebhookDelivery {
  id: string
  webhook: string
  key: string | null
  event: string
  body: unknown
  revision: number
  count: number
  state: WebhookDeliveryState
  attempts: number
  /** The HTTP status of the last attempt, when the receiver answered. */
  lastStatus: number | null
  /** Why the last attempt failed. It never holds the URL or the secret. */
  lastError: string | null
  /** When a pending delivery is due. */
  dueAt: number
  createdAt: number
  updatedAt: number
  sentAt: number | null
}

/** Which deliveries `list()` returns, newest first. */
export interface ListWebhookDeliveriesOptions {
  webhook?: string
  state?: WebhookDeliveryState
  /** At most this many, from 1 to 500. Default: 100. */
  limit?: number
  /** Only deliveries older than this one, for the next page. */
  before?: { createdAt: number, id: string }
}

type Row = typeof webhookDeliveries.$inferSelect

function toDelivery(row: Row): WebhookDelivery {
  return { ...row, body: JSON.parse(row.body) }
}

/** A new send: the row to insert, or the pending row of the same `(webhook, key)` to update. */
export interface WebhookSendRecord {
  id: string
  webhook: string
  key: string | null
  event: string
  body: string
  dueAt: number
  now: number
  /** The sends that this row stands for. Default: 1. A redelivery keeps the count of the delivery it copies. */
  count?: number
}

/** The result of an attempt that the claim holder writes back. */
export interface WebhookAttemptResult {
  status: number | null
  error: string | null
}

/** What `recordOnce()` returns: the new delivery, or the live one that already has the key. */
export interface WebhookRecordOnceResult {
  id: string
  revision: number
  state: WebhookDeliveryState
  /** `false` when a pending, sending, or sent delivery of the same webhook already had the key. */
  created: boolean
}

/** The storage of deliveries. Each write that changes a state checks the state it expects, so two servers cannot both win. */
export interface WebhookDeliveryStore {
  /** Inserts the delivery, or updates the pending one of the same non-null key. Returns the id and revision that won. */
  record: (send: WebhookSendRecord) => Promise<{ id: string, revision: number, count: number }>
  /**
   * Inserts the delivery unless a pending, sending, or sent delivery of the same webhook has the same key. One
   * statement checks and inserts, so two sends with one key store one delivery. A dead or cancelled delivery does not
   * count, so a send after a failure posts again.
   */
  recordOnce: (send: WebhookSendRecord & { key: string }) => Promise<WebhookRecordOnceResult>
  get: (id: string) => Promise<WebhookDelivery | undefined>
  list: (options?: ListWebhookDeliveriesOptions) => Promise<WebhookDelivery[]>
  /** Pending deliveries, the soonest due first. */
  pending: (options?: { webhook?: string, limit?: number }) => Promise<WebhookDelivery[]>
  /**
   * Moves the delivery to `sending` and counts the attempt, when it is pending at `revision`, or when it is `sending`
   * at `revision` with a claim older than `staleBefore`, which a stopped server left.
   */
  claim: (id: string, revision: number, now: number, staleBefore: number) => Promise<WebhookDelivery | undefined>
  /** Marks the claimed delivery `sent`. */
  sent: (claim: WebhookDelivery, result: WebhookAttemptResult, now: number) => Promise<void>
  /**
   * Writes a failed attempt. With `dead`, the delivery stops. Else it is pending again, or `cancelled` when a newer send
   * of the same key is pending, since that one carries the newer body. Returns the new state.
   */
  failed: (claim: WebhookDelivery, result: WebhookAttemptResult, now: number, dead: boolean) => Promise<WebhookDeliveryState | undefined>
  /** Makes a pending delivery due now. */
  due: (id: string, now: number) => Promise<WebhookDelivery | undefined>
  /** Cancels a pending delivery. */
  cancel: (id: string, now: number) => Promise<WebhookDelivery | undefined>
}

async function guarded<T>(action: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  }
  catch (cause) {
    // A missing Database is its own error, with its own fix.
    if (webhooksErrors.is(cause)) throw cause
    throw webhooksErrors.WEBHOOKS_STORE_FAILED({ action, cause })
  }
}

/**
 * Deliveries in a Drizzle SQLite Database. Pass a function when the Database connects per request, as D1 does on
 * Cloudflare.
 */
export function createDrizzleWebhookStore(database: WebhooksDatabase | (() => WebhooksDatabase)): WebhookDeliveryStore {
  const db = typeof database === "function" ? database : () => database
  const t = webhookDeliveries
  return {
    record: send => guarded("store a delivery", async () => {
      const insert = db().insert(t).values({
        id: send.id,
        webhook: send.webhook,
        key: send.key,
        event: send.event,
        body: send.body,
        revision: 1,
        count: send.count ?? 1,
        state: "pending",
        attempts: 0,
        dueAt: send.dueAt,
        createdAt: send.now,
        updatedAt: send.now,
      })
      const [row] = send.key === null
        ? await insert.returning({ id: t.id, revision: t.revision, count: t.count })
        : await insert.onConflictDoUpdate({
            target: [t.webhook, t.key],
            targetWhere: sql`state = 'pending'`,
            set: {
              body: sql`excluded.body`,
              event: sql`excluded.event`,
              dueAt: sql`excluded.due_at`,
              updatedAt: sql`excluded.updated_at`,
              revision: sql`${t.revision} + 1`,
              count: sql`${t.count} + 1`,
              // A new body starts a new set of attempts.
              attempts: 0,
            },
          }).returning({ id: t.id, revision: t.revision, count: t.count })
      if (!row) throw webhooksErrors.WEBHOOKS_STORE_FAILED({ action: "store a delivery" })
      return row
    }),
    recordOnce: send => guarded("store a delivery", async () => {
      // A delivery that goes dead between the insert and the read leaves no row. Try once more.
      for (let attempt = 0; attempt < 2; attempt++) {
        const inserted = await db().all(sql`
          INSERT INTO vitehub_webhook_deliveries (id, webhook, key, event, body, revision, count, state, attempts, due_at, created_at, updated_at)
          SELECT ${send.id}, ${send.webhook}, ${send.key}, ${send.event}, ${send.body}, 1, ${send.count ?? 1}, 'pending', 0, ${send.dueAt}, ${send.now}, ${send.now}
          WHERE NOT EXISTS (SELECT 1 FROM vitehub_webhook_deliveries WHERE webhook = ${send.webhook} AND key = ${send.key} AND state IN ('pending', 'sending', 'sent'))
          RETURNING id`)
        if (inserted.length) return { id: send.id, revision: 1, state: "pending", created: true }
        const [existing] = await db().select({ id: t.id, revision: t.revision, state: t.state }).from(t)
          .where(and(eq(t.webhook, send.webhook), eq(t.key, send.key), inArray(t.state, ["pending", "sending", "sent"])))
          .orderBy(desc(t.createdAt))
          .limit(1)
        if (existing) return { ...existing, created: false }
      }
      throw webhooksErrors.WEBHOOKS_STORE_FAILED({ action: "store a delivery" })
    }),
    get: id => guarded("read a delivery", async () => {
      const [row] = await db().select().from(t).where(eq(t.id, id)).limit(1)
      return row ? toDelivery(row) : undefined
    }),
    list: (options = {}) => guarded("list deliveries", async () => {
      const limit = Math.min(Math.max(options.limit ?? 100, 1), 500)
      const { before } = options
      const where = and(
        options.webhook ? eq(t.webhook, options.webhook) : undefined,
        options.state ? eq(t.state, options.state) : undefined,
        before ? or(lt(t.createdAt, before.createdAt), and(eq(t.createdAt, before.createdAt), lt(t.id, before.id))) : undefined,
      )
      const rows = await db().select().from(t).where(where).orderBy(desc(t.createdAt), desc(t.id)).limit(limit)
      return rows.map(toDelivery)
    }),
    pending: (options = {}) => guarded("list pending deliveries", async () => {
      const limit = Math.min(Math.max(options.limit ?? 100, 1), 500)
      const rows = await db().select().from(t)
        .where(and(eq(t.state, "pending"), options.webhook ? eq(t.webhook, options.webhook) : undefined))
        .orderBy(asc(t.dueAt), asc(t.id))
        .limit(limit)
      return rows.map(toDelivery)
    }),
    claim: (id, revision, now, staleBefore) => guarded("claim a delivery", async () => {
      const [row] = await db().update(t)
        .set({ state: "sending", attempts: sql`${t.attempts} + 1`, updatedAt: now })
        .where(and(eq(t.id, id), eq(t.revision, revision), or(eq(t.state, "pending"), and(eq(t.state, "sending"), lt(t.updatedAt, staleBefore)))))
        .returning()
      return row ? toDelivery(row) : undefined
    }),
    sent: (claim, result, now) => guarded("mark a delivery sent", async () => {
      await db().update(t)
        .set({ state: "sent", lastStatus: result.status, lastError: null, sentAt: now, updatedAt: now })
        .where(and(eq(t.id, claim.id), eq(t.state, "sending"), eq(t.attempts, claim.attempts)))
    }),
    failed: (claim, result, now, dead) => guarded("mark a failed attempt", async () => {
      // One statement, so a send that inserts a newer pending row cannot race the check.
      const next = dead
        ? sql<WebhookDeliveryState>`'dead'`
        : sql<WebhookDeliveryState>`CASE WHEN ${t.key} IS NOT NULL AND EXISTS (SELECT 1 FROM vitehub_webhook_deliveries AS newer WHERE newer.webhook = ${t.webhook} AND newer.key = ${t.key} AND newer.state = 'pending') THEN 'cancelled' ELSE 'pending' END`
      const [row] = await db().update(t)
        .set({ state: next, lastStatus: result.status, lastError: result.error, updatedAt: now })
        .where(and(eq(t.id, claim.id), eq(t.state, "sending"), eq(t.attempts, claim.attempts)))
        .returning({ state: t.state })
      if (row?.state === "cancelled") {
        // The newer pending send stands for this one too.
        await db().update(t).set({ count: sql`${t.count} + ${claim.count}` }).where(and(eq(t.webhook, claim.webhook), eq(t.key, claim.key ?? ""), eq(t.state, "pending")))
      }
      return row?.state
    }),
    due: (id, now) => guarded("flush a delivery", async () => {
      const [row] = await db().update(t).set({ dueAt: now, updatedAt: now }).where(and(eq(t.id, id), eq(t.state, "pending"))).returning()
      return row ? toDelivery(row) : undefined
    }),
    cancel: (id, now) => guarded("cancel a delivery", async () => {
      const [row] = await db().update(t).set({ state: "cancelled", updatedAt: now }).where(and(eq(t.id, id), eq(t.state, "pending"))).returning()
      return row ? toDelivery(row) : undefined
    }),
  }
}

/** One member endpoint, as code, the CLI, and the Console read it. It never holds the URL or the secret. */
export interface MemberEndpoint {
  id: string
  owner: string
  name: string
  kind: MemberEndpointKind
  /** The agent that receives, such as `"t3"`, `"claude-code"`, or `"codex"`. */
  agent: string | null
  /** The host of the URL, such as `relay.t3.codes`. `null` for an inbox. */
  host: string | null
  /** When an admin disabled it. A disabled endpoint gets no sends. */
  disabledAt: number | null
  createdAt: number
  updatedAt: number
}

/** A member endpoint with its sealed URL and secret. Only the Webhooks runtime reads it. */
export interface StoredMemberEndpoint extends MemberEndpoint {
  sealed: string | null
}

/** The storage of member endpoints. */
export interface WebhookEndpointStore {
  /** Stores the endpoint of its owner. It replaces the owner's endpoint when one exists. */
  put: (endpoint: StoredMemberEndpoint) => Promise<void>
  /** The endpoint of an owner. */
  get: (owner: string) => Promise<StoredMemberEndpoint | undefined>
  /** The endpoint with this id. */
  find: (id: string) => Promise<StoredMemberEndpoint | undefined>
  /** Removes the endpoint when the owner has it. Returns the removed endpoint. */
  remove: (owner: string, id: string) => Promise<StoredMemberEndpoint | undefined>
  /** Disables the endpoint. Returns the endpoint after the change. */
  disable: (id: string, now: number) => Promise<StoredMemberEndpoint | undefined>
}

/** Member endpoints in a Drizzle SQLite Database. Pass a function when the Database connects per request. */
export function createDrizzleWebhookEndpointStore(database: WebhooksDatabase | (() => WebhooksDatabase)): WebhookEndpointStore {
  const db = typeof database === "function" ? database : () => database
  const t = webhookEndpoints
  return {
    put: endpoint => guarded("store a member endpoint", async () => {
      await db().insert(t).values(endpoint).onConflictDoUpdate({
        target: t.owner,
        set: {
          id: endpoint.id,
          name: endpoint.name,
          kind: endpoint.kind,
          agent: endpoint.agent,
          host: endpoint.host,
          sealed: endpoint.sealed,
          disabledAt: null,
          createdAt: endpoint.createdAt,
          updatedAt: endpoint.updatedAt,
        },
      })
    }),
    get: owner => guarded("read a member endpoint", async () => {
      const [row] = await db().select().from(t).where(eq(t.owner, owner)).limit(1)
      return row
    }),
    find: id => guarded("read a member endpoint", async () => {
      const [row] = await db().select().from(t).where(eq(t.id, id)).limit(1)
      return row
    }),
    remove: (owner, id) => guarded("remove a member endpoint", async () => {
      const [row] = await db().delete(t).where(and(eq(t.owner, owner), eq(t.id, id))).returning()
      return row
    }),
    disable: (id, now) => guarded("disable a member endpoint", async () => {
      // Disabling twice keeps the first time.
      const [row] = await db().update(t).set({ disabledAt: sql`coalesce(${t.disabledAt}, ${now})`, updatedAt: now }).where(eq(t.id, id)).returning()
      return row
    }),
  }
}
