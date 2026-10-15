import { and, eq, gt, inArray, lt, ne, sql } from "drizzle-orm"

import { contentSessionsSchema } from "./database.ts"

import type { BlobDatabaseWorkspaceStoreOptions } from "@vite-hub/workspace/blob-database"
import type { SQL } from "drizzle-orm"

const { contentSessions: table } = contentSessionsSchema

/** Milliseconds since the epoch from the Database clock, so expiry does not depend on the host clock. */
const now: SQL = sql`cast((julianday('now') - 2440587.5) * 86400000 as integer)`

export interface SessionTimeouts {
  presence: number
  lease: number
  idle: number
}

export interface SessionKey {
  collection: string
  document: string
  session: string
}

export interface SessionUserRow {
  id: string
  name: string | null
  image: string | null
}

export interface SessionRow {
  collection: string
  document: string
  session: string
  userId: string
  userName: string | null
  userImage: string | null
  kind: "view" | "edit" | "live"
  acquiredAt: number | null
  renewedAt: number
  expiresAt: number
  lastInputAt: number | null
  /** The Database clock when the row was read. */
  now: number
}

export interface ReportInput extends SessionKey {
  user: SessionUserRow
  /**
   * `view` drops a lease the session holds. `edit` renews it, or, with `claim`, takes it when it is free. `live` does
   * the same for a Realtime room that holds the lease for everyone in it.
   */
  kind: "view" | "edit" | "live"
  input: boolean
  /** Whether the collection uses leases. Without, `edit` is a presence label only. */
  lease: boolean
  claim: boolean
  takeover: boolean
}

type Database = BlobDatabaseWorkspaceStoreOptions["database"]

const selection = {
  collection: table.collection,
  document: table.document,
  session: table.session,
  userId: table.userId,
  userName: table.userName,
  userImage: table.userImage,
  kind: table.kind,
  acquiredAt: table.acquiredAt,
  renewedAt: table.renewedAt,
  expiresAt: table.expiresAt,
  lastInputAt: table.lastInputAt,
  now: sql<number>`${now}`.as("now"),
}

/** Content sessions in one Database. Each method is one atomic batch or statement. */
export function createSessionStore(database: Database, workspace: string, timeouts: SessionTimeouts): {
  report(input: ReportInput): Promise<SessionRow[]>
  release(key: SessionKey): Promise<void>
  list(collection?: string): Promise<SessionRow[]>
  holder(key: SessionKey): Promise<SessionRow | undefined>
  renew(key: SessionKey): Promise<void>
} {
  const document = (key: Pick<SessionKey, "collection" | "document">) =>
    and(eq(table.workspace, workspace), eq(table.collection, key.collection), eq(table.document, key.document))
  const mine = (key: SessionKey) => and(document(key), eq(table.session, key.session))
  /** A lease that blocks others: an edit or live row that has not expired and had input in the idle window. */
  const liveLease = sql`${table.kind} in ('edit', 'live') and ${table.expiresAt} > ${now} and ${table.lastInputAt} > ${now} - ${timeouts.idle}`
  /** Another session of the document holds a live lease. The alias keeps the subquery apart from the updated row. */
  const otherHolds = (key: SessionKey) => sql`exists (
    select 1 from ${table} as other
    where other.workspace = ${workspace} and other.collection = ${key.collection} and other.document = ${key.document}
      and other.session <> ${key.session} and other.kind in ('edit', 'live')
      and other.expires_at > ${now} and other.last_input_at > ${now} - ${timeouts.idle}
  )`

  return {
    async report(input) {
      const key: SessionKey = { collection: input.collection, document: input.document, session: input.session }
      const presenceUntil = sql`${now} + ${timeouts.presence}`
      const statements: unknown[] = []
      if (input.lease) {
        // A lease that expired or went idle is gone: the session views until it claims again.
        statements.push(database.update(table).set({ kind: "view", acquiredAt: null }).where(and(mine(key), inArray(table.kind, ["edit", "live"]), sql`not (${liveLease})`)))
      }
      statements.push(database.insert(table).values({
          workspace,
          collection: key.collection,
          document: key.document,
          session: key.session,
          userId: input.user.id,
          userName: input.user.name,
          userImage: input.user.image,
          kind: input.lease ? "view" : input.kind,
          acquiredAt: !input.lease && input.kind !== "view" ? now : null,
          renewedAt: now,
          expiresAt: presenceUntil,
          lastInputAt: input.input ? now : null,
        }).onConflictDoUpdate({
          target: [table.workspace, table.collection, table.document, table.session],
          set: {
            userId: sql`excluded.user_id`,
            userName: sql`excluded.user_name`,
            userImage: sql`excluded.user_image`,
            renewedAt: sql`excluded.renewed_at`,
            ...(input.input ? { lastInputAt: sql`excluded.last_input_at` } : {}),
            ...(input.kind === "view" || !input.lease
              ? {
                  kind: input.kind,
                  acquiredAt: input.kind !== "view" ? sql`coalesce(${table.acquiredAt}, excluded.renewed_at)` : null,
                  expiresAt: sql`excluded.expires_at`,
                }
              : { expiresAt: sql`max(${table.expiresAt}, excluded.expires_at)` }),
          },
        }))
      if (input.lease && input.kind !== "view") {
        if (input.takeover) {
          // The former holders keep viewing; their next report shows who holds the lease now.
          statements.push(database.update(table).set({ kind: "view", acquiredAt: null, expiresAt: sql`min(${table.expiresAt}, ${presenceUntil})` })
            .where(and(document(key), ne(table.session, key.session), inArray(table.kind, ["edit", "live"]))))
        }
        if (input.claim) {
          // One conditional statement: of two sessions that claim at once, exactly one finds no other holder.
          statements.push(database.update(table).set({
            kind: input.kind,
            acquiredAt: sql`case when ${liveLease} then ${table.acquiredAt} else ${now} end`,
            expiresAt: sql`${now} + ${timeouts.lease}`,
            lastInputAt: now,
          }).where(and(mine(key), input.takeover ? undefined : sql`not ${otherHolds(key)}`)))
        }
        else {
          statements.push(database.update(table).set({ expiresAt: sql`${now} + ${timeouts.lease}` }).where(and(mine(key), inArray(table.kind, ["edit", "live"]))))
        }
      }
      // Rows long past expiry carry nothing; drop them while the batch already writes.
      statements.push(database.delete(table).where(and(eq(table.workspace, workspace), lt(table.expiresAt, sql`${now} - 3600000`))))
      const results = await database.batch([
        ...statements,
        database.select(selection).from(table).where(and(document(key), gt(table.expiresAt, now))),
      ] as unknown as Parameters<Database["batch"]>[0])
      // SAFETY: The last statement of the batch is the select above.
      return results.at(-1) as unknown as SessionRow[]
    },

    async release(key) {
      await database.delete(table).where(mine(key))
    },

    async list(collection) {
      return await database.select(selection).from(table).where(and(
        eq(table.workspace, workspace),
        collection === undefined ? undefined : eq(table.collection, collection),
        gt(table.expiresAt, now),
      ))
    },

    async holder(key) {
      const [row] = await database.select(selection).from(table).where(and(document(key), ne(table.session, key.session), liveLease)).limit(1)
      return row
    },

    async renew(key) {
      await database.update(table).set({ expiresAt: sql`${now} + ${timeouts.lease}`, lastInputAt: now }).where(and(mine(key), liveLease))
    },
  }
}
