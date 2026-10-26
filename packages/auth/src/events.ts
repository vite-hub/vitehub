import { sql } from "drizzle-orm"
import * as v from "valibot"
import type { EnvDatabase } from "@vite-hub/env/database"
import type { AuthAccessAuthorize } from "./types.ts"

export const authEventTypes = [
  "user.signed_up", "user.signed_in", "user.signed_out", "sign_in.failed",
  "session.revoked", "user.banned", "user.unbanned", "user.role_changed",
  "user.updated", "user.removed", "impersonation.started", "impersonation.stopped",
  "oauth.consent_granted", "oauth.consent_revoked", "organization.member_added",
  "organization.member_removed", "organization.member_role_changed",
] as const
export type AuthEventType = typeof authEventTypes[number]
export type AuthEventActor = "system" | `user:${string}`
export type AuthDevice = "desktop" | "mobile" | "tablet" | "bot" | "unknown"

/** Only these fields cross the persistence boundary. No request bodies or headers are stored. */
export interface AuthEventMetadata {
  method?: string
  device?: AuthDevice
  sessionId?: string
  fields?: string[]
  role?: string
  clientId?: string
  organizationId?: string
  memberId?: string
}
export interface AuthEvent {
  id: string
  type: AuthEventType
  time: string
  actor: AuthEventActor
  /** Unknown for failed sign-ins. The log does not look up untrusted email addresses. */
  userId: string | null
  metadata: AuthEventMetadata
}
export interface AuthEventListInput {
  type?: AuthEventType | readonly AuthEventType[]
  userId?: string
  actor?: AuthEventActor
  /** Inclusive ISO timestamp. */
  from?: string
  /** Exclusive ISO timestamp. */
  to?: string
  cursor?: string
  limit?: number
}
export interface AuthEventPage { events: AuthEvent[], nextCursor?: string }
export interface AuthEventWindow { from: string, to: string }
export interface AuthEventCounts {
  signUps: number
  signIns: number
  /** Distinct users with a recorded sign-in. Includes the session created at sign-up. */
  activeUsers: number
  methods: Record<string, number>
}
export interface AuthEventAggregates {
  days: Array<AuthEventCounts & { day: string }>
  totals: AuthEventCounts
}
export interface AuthEventRetention { maxAgeMs?: number, maxRecords?: number }
export interface AuthEventStore {
  append: (event: AuthEvent) => Promise<void>
  list: (input?: AuthEventListInput) => Promise<AuthEventPage>
  aggregate: (window: AuthEventWindow) => Promise<AuthEventAggregates>
}
export interface AuthEventsConfiguration {
  store: AuthEventStore
  /** Enable the CLI read endpoint. A session and an explicit true result are required. A Response is sent as the rejection. */
  authorize?: AuthAccessAuthorize
}

const text = v.pipe(v.string(), v.minLength(1), v.maxLength(256))
const timestamp = v.pipe(v.string(), v.isoTimestamp())
const actor = v.custom<AuthEventActor>(value => typeof value === "string" && value.length <= 512 && /^(system|user:.+)$/.test(value))
const metadata = v.object({
  method: v.optional(v.pipe(text, v.regex(/^[a-zA-Z0-9_.:-]+$/))),
  device: v.optional(v.picklist(["desktop", "mobile", "tablet", "bot", "unknown"])),
  sessionId: v.optional(text),
  fields: v.optional(v.pipe(v.array(v.pipe(text, v.regex(/^[a-zA-Z][a-zA-Z0-9_]*$/))), v.maxLength(100))),
  role: v.optional(text), clientId: v.optional(text), organizationId: v.optional(text), memberId: v.optional(text),
})
const eventSchema = v.object({ id: text, type: v.picklist(authEventTypes), time: timestamp, actor, userId: v.nullable(text), metadata })
const rowSchema = v.object({ payload: v.string() })
const cursorSchema = v.tuple([timestamp, text])
const listSchema = v.object({
  type: v.optional(v.union([v.picklist(authEventTypes), v.pipe(v.array(v.picklist(authEventTypes)), v.minLength(1), v.maxLength(authEventTypes.length))])), userId: v.optional(text), actor: v.optional(actor),
  from: v.optional(timestamp), to: v.optional(timestamp), cursor: v.optional(v.pipe(v.string(), v.maxLength(2048))),
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(200))),
})

export function parseAuthEventList(input: unknown): { query: AuthEventListInput, before: [string, string] | undefined } {
  const query = v.parse(listSchema, input)
  const before = query.cursor ? v.parse(cursorSchema, JSON.parse(decodeURIComponent(query.cursor))) : undefined
  if (query.from && query.to && Date.parse(query.from) >= Date.parse(query.to)) throw new TypeError("Auth event from must be before to.")
  return { query, before }
}

export function parseAuthEventWindow(window: { from: string, to: string }): { from: string, to: string } {
  const from = new Date(v.parse(timestamp, window.from)).toISOString()
  const to = new Date(v.parse(timestamp, window.to)).toISOString()
  if (from >= to || Date.parse(to) - Date.parse(from) > 366 * 86400_000) throw new TypeError("Auth event windows must be positive and at most 366 days.")
  return { from, to }
}

export const defaultAuthEventRetention: Required<AuthEventRetention> = {
  maxAgeMs: 90 * 24 * 60 * 60 * 1000,
  maxRecords: 100_000,
}

/** One SQLite store contract for Node SQLite, libSQL, and Cloudflare D1 Drizzle databases. */
export function createDatabaseAuthEventStore(options: { db: EnvDatabase, retention?: AuthEventRetention | false }): AuthEventStore {
  const { db } = options
  const retention = options.retention === false ? false : { ...defaultAuthEventRetention, ...options.retention }
  if (retention && Object.values(retention).some(value => !Number.isSafeInteger(value) || value < 1)) {
    throw new TypeError("Auth event retention limits must be positive integers.")
  }
  let ready: Promise<void> | undefined
  const initialize = () => ready ??= (async () => {
    await db.run(sql`CREATE TABLE IF NOT EXISTS vitehub_auth_events (id TEXT PRIMARY KEY, type TEXT NOT NULL, time TEXT NOT NULL, actor TEXT NOT NULL, user_id TEXT, method TEXT, payload TEXT NOT NULL)`)
    await db.run(sql`CREATE INDEX IF NOT EXISTS vitehub_auth_events_time ON vitehub_auth_events (time, id)`)
    await db.run(sql`CREATE INDEX IF NOT EXISTS vitehub_auth_events_type ON vitehub_auth_events (type, time, id)`)
    await db.run(sql`CREATE INDEX IF NOT EXISTS vitehub_auth_events_user ON vitehub_auth_events (user_id, time, id)`)
    await db.run(sql`CREATE INDEX IF NOT EXISTS vitehub_auth_events_actor ON vitehub_auth_events (actor, time, id)`)
  })().catch((error: unknown) => { ready = undefined; throw error })
  const cutoff = () => new Date(Math.max(0, Date.now() - (retention ? retention.maxAgeMs : Date.now()))).toISOString()
  const visible = () => retention ? sql`time >= ${cutoff()}` : sql`1 = 1`

  return {
    async append(input) {
      // Valibot removes unknown fields, including accidental tokens in metadata.
      const event = v.parse(eventSchema, input)
      event.time = new Date(event.time).toISOString()
      await initialize()
      await db.run(sql`INSERT INTO vitehub_auth_events (id, type, time, actor, user_id, method, payload) VALUES (${event.id}, ${event.type}, ${event.time}, ${event.actor}, ${event.userId}, ${event.metadata.method ?? null}, ${JSON.stringify(event)}) ON CONFLICT (id) DO NOTHING`)
      if (retention) {
        // Like Connections activity, cleanup follows each append and can retry on the next write.
        await db.run(sql`DELETE FROM vitehub_auth_events WHERE time < ${cutoff()} OR (time, id) <= (SELECT time, id FROM vitehub_auth_events ORDER BY time DESC, id DESC LIMIT 1 OFFSET ${retention.maxRecords})`)
      }
    },
    async list(input = {}) {
      const { query, before } = parseAuthEventList(input)
      const limit = query.limit ?? 50
      await initialize()
      const rows = await db.all(sql`SELECT payload FROM vitehub_auth_events WHERE ${visible()}
        ${query.type ? sql`AND type IN (${sql.join((typeof query.type === "string" ? [query.type] : query.type).map(type => sql`${type}`), sql`, `)})` : sql``}
        ${query.userId ? sql`AND user_id = ${query.userId}` : sql``}
        ${query.actor ? sql`AND actor = ${query.actor}` : sql``}
        ${query.from ? sql`AND time >= ${new Date(query.from).toISOString()}` : sql``}
        ${query.to ? sql`AND time < ${new Date(query.to).toISOString()}` : sql``}
        ${before ? sql`AND (time, id) < (${before[0]}, ${before[1]})` : sql``}
        ORDER BY time DESC, id DESC LIMIT ${limit + 1}`)
      const events = rows.slice(0, limit).map(row => v.parse(eventSchema, JSON.parse(v.parse(rowSchema, row).payload)))
      const last = events.at(-1)
      return { events, ...(rows.length > limit && last ? { nextCursor: encodeURIComponent(JSON.stringify([last.time, last.id])) } : {}) }
    },
    async aggregate(window) {
      const { from, to } = parseAuthEventWindow(window)
      await initialize()
      // One statement gives daily counts, full-window distinct users and methods one snapshot.
      const where = sql`${visible()} AND time >= ${from} AND time < ${to} AND type IN ('user.signed_up', 'user.signed_in')`
      const counts = sql`SUM(CASE WHEN type = 'user.signed_up' THEN 1 ELSE 0 END) AS signUps, SUM(CASE WHEN type = 'user.signed_in' THEN 1 ELSE 0 END) AS signIns, COUNT(DISTINCT CASE WHEN type = 'user.signed_in' THEN user_id END) AS activeUsers`
      const rows = await db.all(sql`SELECT substr(time, 1, 10) AS day, ${counts}, NULL AS method, NULL AS count FROM vitehub_auth_events WHERE ${where} GROUP BY day
        UNION ALL SELECT NULL AS day, ${counts}, NULL AS method, NULL AS count FROM vitehub_auth_events WHERE ${where}
        UNION ALL SELECT substr(time, 1, 10) AS day, NULL AS signUps, NULL AS signIns, NULL AS activeUsers, method, COUNT(*) AS count FROM vitehub_auth_events WHERE ${where} AND type = 'user.signed_in' GROUP BY day, method`)
      const methods = rows.filter(row => (row as { count: unknown }).count !== null)
      const empty = (): AuthEventCounts => ({ signUps: 0, signIns: 0, activeUsers: 0, methods: {} })
      const days = new Map<string, AuthEventCounts>()
      for (let time = Date.parse(`${from.slice(0, 10)}T00:00:00.000Z`); time < Date.parse(to); time += 86400_000) days.set(new Date(time).toISOString().slice(0, 10), empty())
      let totals = empty()
      const countSchema = v.object({ day: v.nullable(v.string()), signUps: v.nullable(v.number()), signIns: v.nullable(v.number()), activeUsers: v.number() })
      for (const row of rows.filter(row => (row as { count: unknown }).count === null)) {
        const item = v.parse(countSchema, row)
        const value = { signUps: item.signUps ?? 0, signIns: item.signIns ?? 0, activeUsers: item.activeUsers, methods: {} }
        if (item.day) days.set(item.day, value)
        else totals = value
      }
      for (const row of methods) {
        const item = v.parse(v.object({ day: v.string(), method: v.nullable(v.string()), count: v.number() }), row)
        const method = item.method ?? "unknown"
        const day = days.get(item.day)
        if (day) Object.defineProperty(day.methods, method, { value: item.count, enumerable: true, configurable: true })
        Object.defineProperty(totals.methods, method, { value: (Object.hasOwn(totals.methods, method) ? totals.methods[method]! : 0) + item.count, enumerable: true, configurable: true })
      }
      return { days: [...days].map(([day, value]) => ({ day, ...value })), totals }
    },
  }
}
