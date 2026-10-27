import { and, asc, desc, eq, inArray, lt, or, sql } from "drizzle-orm"
import type { SQL } from "drizzle-orm"
import type { LibSQLDatabase } from "drizzle-orm/libsql"

import { commentsErrorDiagnostics } from "./errors.ts"
import { commentCounters, commentMessages, commentThreads } from "./database.ts"
import type {
  CommentActor,
  CommentAnchor,
  CommentListQuery,
  CommentMessage,
  CommentStatus,
  CommentSubject,
  CommentThread,
  CommentUser,
} from "./types.ts"

/**
 * The Drizzle database that the store uses. The store calls `select`, `insert`, `update`, and `delete` (with
 * `onConflictDoNothing()` and `returning()`), which SQLite, libSQL, D1, and Postgres Drizzle databases all offer, and
 * groups writes with `batch()` or `transaction()` when the driver has one. The Postgres tables have the same property
 * names, so one set of queries serves every driver.
 */
export type CommentsDatabase = LibSQLDatabase<Record<string, never>>

type ThreadRow = typeof commentThreads.$inferSelect
type MessageRow = typeof commentMessages.$inferSelect

/** The tables to query: the ones of the Database schema, so Postgres uses its own. */
export interface CommentsTables {
  commentThreads: typeof commentThreads
  commentMessages: typeof commentMessages
  commentCounters: typeof commentCounters
}

const chunkSize = 80
const allocationAttempts = 12
export const defaultListLimit = 200
export const maximumListLimit = 500
const candidateLimit = 200

function chunks<T>(items: readonly T[]): T[][] {
  const result: T[][] = []
  for (let index = 0; index < items.length; index += chunkSize) result.push(items.slice(index, index + chunkSize))
  return result
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback
  try {
    // SAFETY: The store wrote this JSON itself, from the typed values of the same field.
    return JSON.parse(value) as T
  }
  catch {
    return fallback
  }
}

function user(id: string, name: string | null, image: string | null): CommentUser {
  return { id, ...(name ? { name } : {}), ...(image ? { image } : {}) }
}

function messageOf(row: MessageRow): CommentMessage {
  const actor = parseJson<CommentActor | undefined>(row.actor, undefined)
  return {
    attachments: parseJson<string[]>(row.attachments, []),
    author: user(row.authorId, row.authorName, row.authorImage),
    body: row.body,
    createdAt: row.createdAt,
    id: row.id,
    mentions: parseJson<string[]>(row.mentions, []),
    threadId: row.threadId,
    ...(actor ? { actor } : {}),
    ...(row.editedAt === null ? {} : { editedAt: row.editedAt }),
  }
}

function threadOf(row: ThreadRow, messages: CommentMessage[]): CommentThread {
  const actor = parseJson<CommentActor | undefined>(row.actor, undefined)
  const resolvedBy = parseJson<CommentUser | undefined>(row.resolvedBy, undefined)
  return {
    anchor: parseJson<CommentAnchor>(row.anchor, { kind: "page" }),
    author: user(row.authorId, row.authorName, row.authorImage),
    createdAt: row.createdAt,
    id: row.id,
    messages,
    n: row.n,
    scope: row.scope,
    status: row.status,
    subject: { id: row.subjectId, kind: row.subjectKind },
    updatedAt: row.updatedAt,
    ...(actor ? { actor } : {}),
    ...(resolvedBy ? { resolvedBy } : {}),
    ...(row.resolvedAt === null ? {} : { resolvedAt: row.resolvedAt }),
  }
}

const uniqueCodes = new Set(["23505", "SQLITE_CONSTRAINT_PRIMARYKEY", "SQLITE_CONSTRAINT_UNIQUE"])
const uniqueMessage = /UNIQUE constraint failed|duplicate key value violates unique constraint/i

/**
 * A unique index refused the insert. Drizzle wraps the driver error in one whose message carries the statement and its
 * parameters, which come from the user. So only codes decide, and a message counts only when it is the driver's own:
 * the error with no cause below it.
 */
function isUniqueViolation(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth++) {
    const code = Reflect.get(Object(current), "code")
    if (typeof code === "string" && uniqueCodes.has(code)) return true
    const cause = Reflect.get(Object(current), "cause")
    if (!cause) return uniqueMessage.test(String(Reflect.get(Object(current), "message") ?? ""))
    current = cause
  }
  return false
}

function escapeLike(value: string): string {
  return value.replaceAll(/[%_\\]/g, "\\$&")
}

export interface NewMessage {
  actor?: CommentActor
  attachments: string[]
  author: CommentUser
  body: string
  id: string
  mentions: string[]
  now: number
}

export interface NewThread extends NewMessage {
  anchor: CommentAnchor
  scope: string
  subject: CommentSubject
  threadId: string
}

export interface CommentsStore {
  /** Newest first: by `updatedAt`, then `id`. `before` continues after the last thread of an earlier page. */
  list: (query: CommentListQuery & { userId?: string }) => Promise<CommentThread[]>
  getById: (id: string) => Promise<CommentThread | null>
  getByNumber: (scope: string, n: number) => Promise<CommentThread | null>
  /**
   * Inserts the thread and its first message together, with the next number of its scope. Several creators at once each
   * get their own number, and a number is never handed out twice.
   */
  createThread: (input: NewThread) => Promise<CommentThread>
  addMessage: (threadId: string, input: NewMessage) => Promise<CommentThread>
  editMessage: (threadId: string, messageId: string, input: { body: string, mentions: string[], now: number }) => Promise<CommentThread>
  deleteMessage: (threadId: string, messageId: string, now: number) => Promise<CommentThread>
  /** With `ownerId`, delete only if every message still belongs to that owner at mutation time. */
  deleteThread: (threadId: string, ownerId?: string) => Promise<boolean>
  setStatus: (threadId: string, status: CommentStatus, by: CommentUser, now: number) => Promise<CommentThread>
  /**
   * The people that wrote in a thread, for a store without an Auth adapter. Only authors of threads that `canRead`
   * accepts count, and a message without a thread never shows.
   */
  knownUsers: (query: string, limit: number, canRead: (thread: CommentThread) => Promise<boolean>) => Promise<CommentUser[]>
  knownUsersByIds: (ids: readonly string[]) => Promise<CommentUser[]>
}

export function createCommentsStore(database: CommentsDatabase, tables: CommentsTables = { commentCounters, commentMessages, commentThreads }): CommentsStore {
  const { commentCounters: counters, commentMessages: messages, commentThreads: threads } = tables
  const db = database

  async function attach(rows: ThreadRow[]): Promise<CommentThread[]> {
    const ids = rows.map(row => row.id)
    const byThread = new Map<string, CommentMessage[]>()
    for (const part of chunks(ids)) {
      const found = await db.select().from(messages).where(inArray(messages.threadId, part)).orderBy(asc(messages.createdAt), asc(messages.id))
      for (const row of found) byThread.set(row.threadId, [...(byThread.get(row.threadId) ?? []), messageOf(row)])
    }
    return rows.map(row => threadOf(row, byThread.get(row.id) ?? []))
  }

  async function find(id: string): Promise<CommentThread | null> {
    const [row] = await db.select().from(threads).where(eq(threads.id, id)).limit(1)
    return row ? (await attach([row]))[0]! : null
  }

  async function one(id: string): Promise<CommentThread> {
    const found = await find(id)
    if (!found) throw commentsErrorDiagnostics.COMMENTS_R0002({ id })
    return found
  }

  // SAFETY: Drizzle's libSQL, D1, and Postgres databases have these methods. The store passes the builders it made.
  const driver = db as unknown as {
    batch?: (statements: unknown[]) => Promise<unknown>
    transaction?: (run: (target: CommentsDatabase) => Promise<void>) => Promise<unknown>
  }
  /** Whether the driver can run several writes as one unit: `batch()` on libSQL and D1, a transaction on Postgres. */
  const groups = typeof driver.batch === "function" || typeof driver.transaction === "function"

  /**
   * Runs the writes together where the driver can. Otherwise they run in order, and the caller orders them so that a
   * failure leaves nothing visible.
   */
  async function together(build: (target: CommentsDatabase) => PromiseLike<unknown>[]): Promise<void> {
    if (typeof driver.batch === "function") {
      await driver.batch(build(db))
      return
    }
    if (typeof driver.transaction === "function") {
      await driver.transaction(async (target) => {
        for (const statement of build(target)) await statement
      })
      return
    }
    for (const statement of build(db)) await statement
  }

  function touching(target: CommentsDatabase, id: string, now: number, values: Partial<typeof threads.$inferInsert> = {}) {
    return target.update(threads).set({ ...values, updatedAt: now }).where(eq(threads.id, id))
  }

  function messageRow(threadId: string, input: NewMessage): typeof messages.$inferInsert {
    return {
      actor: input.actor ? JSON.stringify(input.actor) : null,
      attachments: JSON.stringify(input.attachments),
      authorId: input.author.id,
      authorImage: input.author.image ?? null,
      authorName: input.author.name ?? null,
      body: input.body,
      createdAt: input.now,
      editedAt: null,
      id: input.id,
      mentions: JSON.stringify(input.mentions),
      threadId,
    }
  }

  /** The next number of a scope. The counter only goes up, so a deleted thread never gives its number away. */
  async function claimNumber(scope: string): Promise<number> {
    const [existing] = await db.select({ next: counters.next }).from(counters).where(eq(counters.scope, scope)).limit(1)
    if (!existing) {
      // Threads that exist from before the counter keep their numbers: start after the highest one.
      const [top] = await db.select({ highest: sql<number>`coalesce(max(${threads.n}), 0)` }).from(threads).where(eq(threads.scope, scope))
      await db.insert(counters).values({ next: Number(top?.highest ?? 0) + 1, scope }).onConflictDoNothing()
    }
    // One statement reads and advances the counter, so two creators never get the same number.
    const [claimed] = await db.update(counters).set({ next: sql`${counters.next} + 1` }).where(eq(counters.scope, scope)).returning({ next: counters.next })
    if (!claimed) throw commentsErrorDiagnostics.COMMENTS_R0011()
    return Number(claimed.next) - 1
  }

  function candidateAuthors(where: SQL) {
    return db.select({ createdAt: messages.createdAt, messageId: messages.id, id: messages.authorId, image: messages.authorImage, name: messages.authorName, threadId: messages.threadId })
      .from(messages)
      .innerJoin(threads, eq(threads.id, messages.threadId))
      .where(where)
      .orderBy(desc(messages.createdAt), desc(messages.id))
  }

  return {
    async list(query) {
      const subject = query.subject ?? (query.page === undefined ? undefined : { id: query.page, kind: "page" })
      const before = query.before
      const where = [
        ...(subject ? [eq(threads.subjectKind, subject.kind), eq(threads.subjectId, subject.id)] : []),
        ...(query.status ? [eq(threads.status, query.status)] : []),
        ...(query.mine ? [query.userId ? eq(threads.authorId, query.userId) : sql`1 = 0`] : []),
        ...(query.mentions
          ? [query.userId
              ? sql`exists (select 1 from ${messages} where ${messages.threadId} = ${threads.id} and ${messages.mentions} like ${`%${escapeLike(JSON.stringify(query.userId))}%`} escape '\\')`
              : sql`1 = 0`]
          : []),
        ...(before ? [or(lt(threads.updatedAt, before.updatedAt), and(eq(threads.updatedAt, before.updatedAt), lt(threads.id, before.id)))!] : []),
      ]
      const limit = Math.min(Math.max(Math.trunc(query.limit ?? defaultListLimit), 1), maximumListLimit)
      const rows = await db.select().from(threads).where(where.length ? and(...where) : undefined).orderBy(desc(threads.updatedAt), desc(threads.id)).limit(limit)
      return attach(rows)
    },
    getById: find,
    async getByNumber(scope, n) {
      const [row] = await db.select().from(threads).where(and(eq(threads.scope, scope), eq(threads.n, n))).limit(1)
      return row ? (await attach([row]))[0]! : null
    },
    async createThread(input) {
      for (let attempt = 0; attempt < allocationAttempts; attempt++) {
        const n = await claimNumber(input.scope)
        const thread = {
          actor: input.actor ? JSON.stringify(input.actor) : null,
          anchor: JSON.stringify(input.anchor),
          authorId: input.author.id,
          authorImage: input.author.image ?? null,
          authorName: input.author.name ?? null,
          createdAt: input.now,
          id: input.threadId,
          n,
          resolvedAt: null,
          resolvedBy: null,
          scope: input.scope,
          status: "open" as const,
          subjectId: input.subject.id,
          subjectKind: input.subject.kind,
          updatedAt: input.now,
        }
        try {
          // The message goes first: without a batch or a transaction, a failure after it leaves a message that no thread
          // lists, and one after the thread would leave an empty thread.
          await together(target => [target.insert(messages).values(messageRow(input.threadId, input)), target.insert(threads).values(thread)])
        }
        catch (error) {
          // A driver without a batch or a transaction may have kept the message. A failed cleanup must not hide the original error.
          if (!groups) await db.delete(messages).where(eq(messages.id, input.id)).catch(() => undefined)
          // The unique index is a backstop for a counter that lags the threads. Claim the next number.
          if (isUniqueViolation(error)) continue
          throw error
        }
        return one(input.threadId)
      }
      throw commentsErrorDiagnostics.COMMENTS_R0011()
    },
    async addMessage(threadId, input) {
      await one(threadId)
      await together(target => [
        // Lock the thread before reading its messages. Deletion takes the same lock, and an insert after deletion
        // selects no thread. This also serializes replies so their timestamps preserve insertion order.
        touching(target, threadId, input.now),
        target.insert(messages).select(sql`select
          ${input.id}, ${threadId}, ${input.body}, ${input.author.id}, ${input.author.name ?? null}, ${input.author.image ?? null},
          ${input.actor ? JSON.stringify(input.actor) : null}, ${JSON.stringify(input.mentions)}, ${JSON.stringify(input.attachments)},
          (select case when max(${messages.createdAt}) >= ${input.now} then max(${messages.createdAt}) + 1 else ${input.now} end
            from ${messages} where ${messages.threadId} = ${threadId}), null
          from ${threads} where ${threads.id} = ${threadId}`),
      ])
      return one(threadId)
    },
    async editMessage(threadId, messageId, input) {
      const found = await one(threadId)
      if (!found.messages.some(message => message.id === messageId)) throw commentsErrorDiagnostics.COMMENTS_R0003({ messageId })
      await together(target => [
        target.update(messages).set({ body: input.body, editedAt: input.now, mentions: JSON.stringify(input.mentions) }).where(and(eq(messages.id, messageId), eq(messages.threadId, threadId))),
        touching(target, threadId, input.now),
      ])
      return one(threadId)
    },
    async deleteMessage(threadId, messageId, now) {
      await together(target => [target.delete(messages).where(and(eq(messages.id, messageId), eq(messages.threadId, threadId))), touching(target, threadId, now)])
      return one(threadId)
    },
    async deleteThread(threadId, ownerId) {
      await together(target => [
        // Acquire the same thread lock as addMessage before checking ownership, including on Postgres where each
        // statement sees a new snapshot after waiting for a concurrent reply's transaction to commit.
        target.update(threads).set({ id: threadId }).where(eq(threads.id, threadId)),
        target.delete(threads).where(and(eq(threads.id, threadId), ownerId === undefined ? undefined
          : sql`not exists (select 1 from ${messages} where ${messages.threadId} = ${threadId} and ${messages.authorId} <> ${ownerId})`)),
        target.delete(messages).where(and(eq(messages.threadId, threadId),
          sql`not exists (select 1 from ${threads} where ${threads.id} = ${threadId})`)),
      ])
      return await find(threadId) === null
    },
    async setStatus(threadId, status, by, now) {
      await one(threadId)
      await touching(db, threadId, now, status === "resolved"
        ? { resolvedAt: now, resolvedBy: JSON.stringify(by), status }
        : { resolvedAt: null, resolvedBy: null, status })
      return one(threadId)
    },
    async knownUsersByIds(ids) {
      const seen = new Map<string, CommentUser>()
      for (const part of chunks([...new Set(ids)])) {
        const rows = await candidateAuthors(inArray(messages.authorId, part))
        for (const row of rows) if (!seen.has(row.id)) seen.set(row.id, user(row.id, row.name, row.image))
      }
      return [...seen.values()]
    },
    async knownUsers(query, limit, canRead) {
      const pattern = `%${escapeLike(query.toLowerCase())}%`
      const matching = sql`lower(coalesce(${messages.authorName}, ${messages.authorId})) like ${pattern} escape '\\'`
      const seen = new Map<string, CommentUser>()
      const readable = new Map<string, Promise<boolean>>()
      let before: { createdAt: number, messageId: string } | undefined
      while (seen.size < limit) {
        const rows = await candidateAuthors(and(matching, before
          ? or(lt(messages.createdAt, before.createdAt), and(eq(messages.createdAt, before.createdAt), lt(messages.id, before.messageId)))
          : undefined)!).limit(candidateLimit)
        for (const row of rows) {
          if (seen.has(row.id)) continue
          let allowed = readable.get(row.threadId)
          if (!allowed) {
            allowed = (async () => {
              const found = await find(row.threadId)
              return found ? await canRead(found) : false
            })()
            readable.set(row.threadId, allowed)
          }
          if (await allowed) seen.set(row.id, user(row.id, row.name, row.image))
          if (seen.size >= limit) break
        }
        if (rows.length < candidateLimit) break
        before = rows.at(-1)!
      }
      return [...seen.values()]
    },
  }
}
