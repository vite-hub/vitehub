import { and, asc, desc, eq, gt, gte, inArray, lt, or, sql } from "drizzle-orm"
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
  owner: text("owner"),
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
  index("vitehub_webhook_deliveries_owner").on(table.owner, table.createdAt, table.id).where(sql`owner IS NOT NULL`),
])

/** How a member endpoint receives: a signed `POST` to a URL, or an inbox that the member's agent reads. */
export type MemberEndpointKind = "url" | "inbox"

const endpointKinds = ["url", "inbox"] as const satisfies readonly MemberEndpointKind[]

/**
 * One row per owner and address. `sealed` holds the URL and secret, encrypted with
 * `VITEHUB_WEBHOOKS_KEY`, and `null` for an inbox. `host` is the only part of the URL in plain text.
 */
export const webhookEndpoints = sqliteTable("vitehub_webhook_endpoints", {
  id: text("id").primaryKey(),
  owner: text("owner").notNull(),
  /** The name of the owner that people read, such as `Ana Ruiz`. */
  ownerName: text("owner_name"),
  /** The verified email of the owner at connect time, not proof of their current identity. */
  ownerEmail: text("owner_email"),
  name: text("name").notNull(),
  /** Where the agent can be reached, such as a T3 thread link. `""` for none. A member has one endpoint per address. */
  address: text("address").notNull().default(""),
  kind: text("kind", { enum: endpointKinds }).notNull(),
  agent: text("agent"),
  host: text("host"),
  sealed: text("sealed"),
  disabledAt: integer("disabled_at"),
  /** Who disabled it, such as the name of an admin. */
  disabledBy: text("disabled_by"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, table => [
  uniqueIndex("vitehub_webhook_endpoints_owner").on(table.owner, table.address),
  index("vitehub_webhook_endpoints_created").on(table.createdAt, table.id),
])

/** The table of Webhooks, for `defineDatabase({ schema })` or a Database contribution. */
export const webhooksSchema = { webhookDeliveries }

/** Where a pairing code is: not used yet, used by an agent that waits for Allow, used up, or used with a refused URL. */
export type MemberPairingState = "waiting" | "paired" | "used" | "refused"

const pairingStates = ["waiting", "paired", "used", "refused"] as const satisfies readonly MemberPairingState[]

/**
 * One row for each pairing code, for 10 minutes. `id` is the SHA-256 hash of the code. `sealed` holds the signing secret
 * that the member's agent gets with the code, and after pairing the agent's URL too, encrypted with `VITEHUB_WEBHOOKS_KEY`.
 */
export const webhookPairings = sqliteTable("vitehub_webhook_pairings", {
  id: text("id").primaryKey(),
  owner: text("owner").notNull(),
  state: text("state", { enum: pairingStates }).notNull(),
  /** The agent that used the code, such as `t3`, `claude-code`, or `codex`. */
  agent: text("agent"),
  host: text("host"),
  /** Where the agent can be reached, such as the T3 thread link that the pair post gave. */
  address: text("address"),
  sealed: text("sealed").notNull(),
  expiresAt: integer("expires_at").notNull(),
  createdAt: integer("created_at").notNull(),
}, table => [
  index("vitehub_webhook_pairings_owner").on(table.owner),
])

/** The tables of member endpoints and their pairing codes. Webhooks adds them only when a feature of the app uses member endpoints. */
export const webhookEndpointsSchema = { webhookEndpoints, webhookPairings }

export { webhookEndpointsTableNames, webhooksTableNames } from "./table-names.ts"

/** The tables of `webhooksSchema` and `webhookEndpointsSchema` as SQLite statements that are safe to run on every start. */
export const webhooksTables: readonly string[] = [
  "CREATE TABLE IF NOT EXISTS `vitehub_webhook_deliveries` (`id` text PRIMARY KEY NOT NULL, `webhook` text NOT NULL, `owner` text, `key` text, `event` text NOT NULL, `body` text NOT NULL, `revision` integer NOT NULL, `count` integer NOT NULL, `state` text NOT NULL, `attempts` integer NOT NULL, `last_status` integer, `last_error` text, `due_at` integer NOT NULL, `created_at` integer NOT NULL, `updated_at` integer NOT NULL, `sent_at` integer)",
  "CREATE UNIQUE INDEX IF NOT EXISTS `vitehub_webhook_deliveries_pending` ON `vitehub_webhook_deliveries` (`webhook`,`key`) WHERE state = 'pending'",
  "CREATE INDEX IF NOT EXISTS `vitehub_webhook_deliveries_webhook` ON `vitehub_webhook_deliveries` (`webhook`,`created_at`)",
  "CREATE INDEX IF NOT EXISTS `vitehub_webhook_deliveries_state` ON `vitehub_webhook_deliveries` (`state`,`due_at`)",
  "CREATE INDEX IF NOT EXISTS `vitehub_webhook_deliveries_owner` ON `vitehub_webhook_deliveries` (`owner`,`created_at`,`id`) WHERE owner IS NOT NULL",
  "CREATE TABLE IF NOT EXISTS `vitehub_webhook_endpoints` (`id` text PRIMARY KEY NOT NULL, `owner` text NOT NULL, `owner_name` text, `owner_email` text, `name` text NOT NULL, `address` text DEFAULT '' NOT NULL, `kind` text NOT NULL, `agent` text, `host` text, `sealed` text, `disabled_at` integer, `disabled_by` text, `created_at` integer NOT NULL, `updated_at` integer NOT NULL)",
  "CREATE UNIQUE INDEX IF NOT EXISTS `vitehub_webhook_endpoints_owner` ON `vitehub_webhook_endpoints` (`owner`,`address`)",
  "CREATE INDEX IF NOT EXISTS `vitehub_webhook_endpoints_created` ON `vitehub_webhook_endpoints` (`created_at`,`id`)",
  "CREATE TABLE IF NOT EXISTS `vitehub_webhook_pairings` (`id` text PRIMARY KEY NOT NULL, `owner` text NOT NULL, `state` text NOT NULL, `agent` text, `host` text, `address` text, `sealed` text NOT NULL, `expires_at` integer NOT NULL, `created_at` integer NOT NULL)",
  "CREATE INDEX IF NOT EXISTS `vitehub_webhook_pairings_owner` ON `vitehub_webhook_pairings` (`owner`)",
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
  owner?: string
  state?: WebhookDeliveryState
  /** At most this many, from 1 to 500. Default: 100. */
  limit?: number
  /** Only deliveries older than this one, for the next page. */
  before?: { createdAt: number, id: string }
}

type Row = typeof webhookDeliveries.$inferSelect

function toDelivery(row: Row): WebhookDelivery {
  const { owner: _owner, ...delivery } = row
  return { ...delivery, body: JSON.parse(row.body) }
}

/** A new send: the row to insert, or the pending row of the same `(webhook, key)` to update. */
export interface WebhookSendRecord {
  id: string
  webhook: string
  owner?: string
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
  /** The newest delivery of each member endpoint, by its `webhook` value `@<endpoint id>`. */
  memberResults: (webhooks: readonly string[]) => Promise<Map<string, MemberLastDelivery>>
}

/** The newest delivery of a member endpoint, as the Console shows it next to the endpoint. */
export interface MemberLastDelivery {
  state: WebhookDeliveryState
  /** The HTTP status of its last attempt, when the receiver answered. */
  status: number | null
  /** Why its last attempt failed. It never holds the URL or the secret. */
  error: string | null
  /** When it last changed. */
  at: number
  /** How many deliveries in a row are dead, the newest first. `0` when the newest is not dead. */
  failures: number
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
        owner: send.owner,
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
          INSERT INTO vitehub_webhook_deliveries (id, webhook, owner, key, event, body, revision, count, state, attempts, due_at, created_at, updated_at)
          SELECT ${send.id}, ${send.webhook}, ${send.owner ?? null}, ${send.key}, ${send.event}, ${send.body}, 1, ${send.count ?? 1}, 'pending', 0, ${send.dueAt}, ${send.now}, ${send.now}
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
        options.owner !== undefined ? eq(t.owner, options.owner) : undefined,
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
    memberResults: webhooks => guarded("read the member deliveries", async () => {
      if (!webhooks.length) return new Map()
      const rows = await db().all<{ webhook: string, state: WebhookDeliveryState, status: number | null, error: string | null, at: number, failures: number }>(sql`
        SELECT d.webhook AS webhook, d.state AS state, d.last_status AS status, d.last_error AS error, d.updated_at AS at,
          (SELECT count(*) FROM vitehub_webhook_deliveries AS f WHERE f.webhook = d.webhook AND f.state = 'dead'
            AND f.created_at > coalesce((SELECT max(s.created_at) FROM vitehub_webhook_deliveries AS s WHERE s.webhook = d.webhook AND s.state <> 'dead'), -1)) AS failures
        FROM vitehub_webhook_deliveries AS d
        WHERE d.webhook IN (SELECT value FROM json_each(${JSON.stringify(webhooks)}))
          AND NOT EXISTS (SELECT 1 FROM vitehub_webhook_deliveries AS n WHERE n.webhook = d.webhook AND (n.created_at > d.created_at OR (n.created_at = d.created_at AND n.id > d.id)))`)
      return new Map(rows.map(({ webhook, ...result }) => [webhook, { ...result, failures: Number(result.failures) }]))
    }),
  }
}

/** One member endpoint, as code, the CLI, and the Console read it. It never holds the URL or the secret. */
export interface MemberEndpoint {
  id: string
  owner: string
  /** The name of the owner that people read, such as `Ana Ruiz`. */
  ownerName: string | null
  /** The verified email of the owner. A ViteHub Console account with this email acts as the owner. */
  ownerEmail: string | null
  name: string
  /** Where the agent can be reached, such as a T3 thread link, or `null` for none. */
  address: string | null
  kind: MemberEndpointKind
  /** The agent that receives, such as `"t3"`, `"claude-code"`, or `"codex"`. */
  agent: string | null
  /** The host of the URL, such as `relay.t3.codes`. `null` for an inbox. */
  host: string | null
  /** When an admin disabled it. A disabled endpoint gets no sends. */
  disabledAt: number | null
  /** Who disabled it, such as the name of an admin. */
  disabledBy: string | null
  createdAt: number
  updatedAt: number
}

/** A member endpoint with its sealed URL and secret, as the table holds it. Only the Webhooks runtime reads it. */
export interface StoredMemberEndpoint extends Omit<MemberEndpoint, "address"> {
  /** `""` for none. */
  address: string
  sealed: string | null
}

export interface ListMemberEndpointsOptions {
  limit?: number
  after?: { createdAt: number, id: string }
}

/** The storage of member endpoints. */
export interface WebhookEndpointStore {
  /** Stores the endpoint of its owner. It replaces the owner's endpoint with the same address when one exists. */
  put: (endpoint: StoredMemberEndpoint) => Promise<void>
  /** The endpoint of an owner with `address`, else the owner's newest one. */
  get: (owner: string, address?: string) => Promise<StoredMemberEndpoint | undefined>
  /** The endpoint with this id. */
  find: (id: string) => Promise<StoredMemberEndpoint | undefined>
  /** Removes the endpoint when the owner has it. Returns the removed endpoint. */
  remove: (owner: string, id: string) => Promise<StoredMemberEndpoint | undefined>
  /** Removes every endpoint of the owner. Returns the removed endpoints. */
  removeAll: (owner: string) => Promise<StoredMemberEndpoint[]>
  /** The endpoints, the oldest first. */
  list: (options?: ListMemberEndpointsOptions) => Promise<StoredMemberEndpoint[]>
  /** Disables the endpoint. Returns the endpoint after the change. */
  disable: (id: string, now: number, by: string | null) => Promise<StoredMemberEndpoint | undefined>
  /** Enables a disabled endpoint. Returns the endpoint after the change. */
  enable: (id: string, now: number) => Promise<StoredMemberEndpoint | undefined>
  /** Stores a new pairing code after deleting expired codes and this owner's finished codes. */
  insertPairing: (row: StoredMemberPairing) => Promise<void>
  pairing: (id: string) => Promise<StoredMemberPairing | undefined>
  /** Moves a code when it is still in `from` and not expired. */
  movePairing: (id: string, from: MemberPairingState, to: MemberPairingState, now: number, set?: Partial<Pick<StoredMemberPairing, "agent" | "host" | "address" | "sealed">>) => Promise<StoredMemberPairing | undefined>
  removePairing: (id: string, owner: string) => Promise<void>
}

export type StoredMemberPairing = typeof webhookPairings.$inferSelect

/** Member endpoints in a Drizzle SQLite Database. Pass a function when the Database connects per request. */
export function createDrizzleWebhookEndpointStore(database: WebhooksDatabase | (() => WebhooksDatabase)): WebhookEndpointStore {
  const db = typeof database === "function" ? database : () => database
  const t = webhookEndpoints
  const p = webhookPairings
  return {
    put: endpoint => guarded("store a member endpoint", async () => {
      await db().insert(t).values(endpoint).onConflictDoUpdate({
        target: [t.owner, t.address],
        set: {
          id: endpoint.id,
          ownerName: endpoint.ownerName,
          ownerEmail: endpoint.ownerEmail,
          name: endpoint.name,
          kind: endpoint.kind,
          agent: endpoint.agent,
          host: endpoint.host,
          sealed: endpoint.sealed,
          disabledAt: null,
          disabledBy: null,
          createdAt: endpoint.createdAt,
          updatedAt: endpoint.updatedAt,
        },
      })
    }),
    get: (owner, address) => guarded("read a member endpoint", async () => {
      const normalized = address?.trim()
      const [row] = await db().select().from(t).where(eq(t.owner, owner))
        .orderBy(...normalized === undefined ? [] : [desc(sql`${t.address} = ${normalized}`)], desc(t.createdAt), desc(t.id))
        .limit(1)
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
    removeAll: owner => guarded("remove the member endpoints of an owner", async () => await db().delete(t).where(eq(t.owner, owner)).returning()),
    list: (options = {}) => guarded("list the member endpoints", async () => {
      const { after } = options
      const where = after && or(gt(t.createdAt, after.createdAt), and(eq(t.createdAt, after.createdAt), gt(t.id, after.id)))
      return await db().select().from(t).where(where).orderBy(asc(t.createdAt), asc(t.id)).limit(Math.min(Math.max(options.limit ?? 500, 1), 500))
    }),
    disable: (id, now, by) => guarded("disable a member endpoint", async () => {
      // Disabling twice keeps the first time and the first person.
      const [row] = await db().update(t)
        .set({ disabledAt: sql`coalesce(${t.disabledAt}, ${now})`, disabledBy: sql`CASE WHEN ${t.disabledAt} IS NULL THEN ${by} ELSE ${t.disabledBy} END`, updatedAt: now })
        .where(eq(t.id, id))
        .returning()
      return row
    }),
    enable: (id, now) => guarded("enable a member endpoint", async () => {
      const [row] = await db().update(t).set({ disabledAt: null, disabledBy: null, updatedAt: now }).where(eq(t.id, id)).returning()
      return row
    }),
    insertPairing: row => guarded("store a pairing code", async () => {
      await db().delete(p).where(or(lt(p.expiresAt, row.createdAt), and(eq(p.owner, row.owner), inArray(p.state, ["used", "refused"]))))
      await db().insert(p).values(row)
    }),
    pairing: id => guarded("read a pairing code", async () => {
      const [row] = await db().select().from(p).where(eq(p.id, id)).limit(1)
      return row
    }),
    movePairing: (id, from, to, now, set = {}) => guarded("update a pairing code", async () => {
      const [row] = await db().update(p).set({ ...set, state: to }).where(and(eq(p.id, id), eq(p.state, from), gte(p.expiresAt, now))).returning()
      return row
    }),
    removePairing: (id, owner) => guarded("remove a pairing code", async () => {
      await db().delete(p).where(and(eq(p.id, id), eq(p.owner, owner)))
    }),
  }
}
