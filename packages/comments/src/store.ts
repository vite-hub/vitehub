import { and, asc, desc, eq, inArray, sql } from "drizzle-orm"
import type { LibSQLDatabase } from "drizzle-orm/libsql"

import { commentsErrorDiagnostics } from "./errors.ts"
import { commentMessages, commentThreads } from "./database.ts"
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
 * The Drizzle database that the store uses. The store calls only `select`, `insert`, `update`, and `delete` with
 * awaited results, which SQLite, libSQL, D1, and Postgres Drizzle databases all offer. The Postgres tables have the
 * same property names, so one set of queries serves every driver.
 */
export type CommentsDatabase = LibSQLDatabase<Record<string, never>>

type ThreadRow = typeof commentThreads.$inferSelect
type MessageRow = typeof commentMessages.$inferSelect

/** The tables to query: the ones of the Database schema, so Postgres uses its own. */
export interface CommentsTables {
  commentThreads: typeof commentThreads
  commentMessages: typeof commentMessages
}

const chunkSize = 80
const allocationAttempts = 12

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

/** A unique index refused the insert. The message differs by driver, and Drizzle may wrap the driver error. */
function isUniqueViolation(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 4; depth++) {
    const message = String(Reflect.get(Object(current), "message") ?? "")
    const code = String(Reflect.get(Object(current), "code") ?? "")
    if (/unique|duplicate key/i.test(message) || code === "23505" || code.startsWith("SQLITE_CONSTRAINT")) return true
    current = Reflect.get(Object(current), "cause")
  }
  return false
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
  list: (query: CommentListQuery & { userId?: string }) => Promise<CommentThread[]>
  getById: (id: string) => Promise<CommentThread | null>
  getByNumber: (scope: string, n: number) => Promise<CommentThread | null>
  /** Inserts the thread with the next number of its scope. Several creators at once each get their own number. */
  createThread: (input: NewThread) => Promise<CommentThread>
  addMessage: (threadId: string, input: NewMessage) => Promise<CommentThread>
  editMessage: (threadId: string, messageId: string, input: { body: string, mentions: string[], now: number }) => Promise<CommentThread>
  deleteMessage: (threadId: string, messageId: string, now: number) => Promise<CommentThread>
  deleteThread: (threadId: string) => Promise<void>
  setStatus: (threadId: string, status: CommentStatus, by: CommentUser, now: number) => Promise<CommentThread>
  /** The people that wrote in a thread, for a store without an Auth adapter. */
  knownUsers: (query: string, limit: number) => Promise<CommentUser[]>
  knownUsersByIds: (ids: readonly string[]) => Promise<CommentUser[]>
}

export function createCommentsStore(database: CommentsDatabase, tables: CommentsTables = { commentMessages, commentThreads }): CommentsStore {
  const { commentMessages: messages, commentThreads: threads } = tables
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

  async function one(id: string): Promise<CommentThread> {
    const [row] = await db.select().from(threads).where(eq(threads.id, id)).limit(1)
    if (!row) throw commentsErrorDiagnostics.COMMENTS_R0002({ id })
    return (await attach([row]))[0]!
  }

  async function touch(id: string, now: number, values: Partial<typeof threads.$inferInsert> = {}): Promise<void> {
    await db.update(threads).set({ ...values, updatedAt: now }).where(eq(threads.id, id))
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

  return {
    async list(query) {
      const subject = query.subject ?? (query.page === undefined ? undefined : { id: query.page, kind: "page" })
      const where = [
        ...(subject ? [eq(threads.subjectKind, subject.kind), eq(threads.subjectId, subject.id)] : []),
        ...(query.status ? [eq(threads.status, query.status)] : []),
        ...(query.mine && query.userId ? [eq(threads.authorId, query.userId)] : []),
      ]
      const rows = await db.select().from(threads).where(where.length ? and(...where) : undefined).orderBy(asc(threads.scope), asc(threads.n)).limit(1_000)
      const found = await attach(rows)
      return query.mentions && query.userId ? found.filter(thread => thread.messages.some(message => message.mentions.includes(query.userId!))) : found
    },
    async getById(id) {
      const [row] = await db.select().from(threads).where(eq(threads.id, id)).limit(1)
      return row ? (await attach([row]))[0]! : null
    },
    async getByNumber(scope, n) {
      const [row] = await db.select().from(threads).where(and(eq(threads.scope, scope), eq(threads.n, n))).limit(1)
      return row ? (await attach([row]))[0]! : null
    },
    async createThread(input) {
      // The unique index on (scope, n) is the lock: a creator that reads the same highest number loses the insert and reads again.
      for (let attempt = 0; attempt < allocationAttempts; attempt++) {
        const [top] = await db.select({ highest: sql<number>`coalesce(max(${threads.n}), 0)` }).from(threads).where(eq(threads.scope, input.scope))
        const n = Number(top?.highest ?? 0) + 1
        try {
          await db.insert(threads).values({
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
            status: "open",
            subjectId: input.subject.id,
            subjectKind: input.subject.kind,
            updatedAt: input.now,
          })
        }
        catch (error) {
          if (isUniqueViolation(error)) continue
          throw error
        }
        try {
          await db.insert(messages).values(messageRow(input.threadId, input))
        }
        catch (error) {
          // Without a transaction, a thread with no message would stay behind.
          await db.delete(threads).where(eq(threads.id, input.threadId))
          throw error
        }
        return one(input.threadId)
      }
      throw commentsErrorDiagnostics.COMMENTS_R0011()
    },
    async addMessage(threadId, input) {
      await one(threadId)
      await db.insert(messages).values(messageRow(threadId, input))
      await touch(threadId, input.now)
      return one(threadId)
    },
    async editMessage(threadId, messageId, input) {
      const found = await one(threadId)
      if (!found.messages.some(message => message.id === messageId)) throw commentsErrorDiagnostics.COMMENTS_R0003({ messageId })
      await db.update(messages).set({ body: input.body, editedAt: input.now, mentions: JSON.stringify(input.mentions) }).where(and(eq(messages.id, messageId), eq(messages.threadId, threadId)))
      await touch(threadId, input.now)
      return one(threadId)
    },
    async deleteMessage(threadId, messageId, now) {
      await db.delete(messages).where(and(eq(messages.id, messageId), eq(messages.threadId, threadId)))
      await touch(threadId, now)
      return one(threadId)
    },
    async deleteThread(threadId) {
      await db.delete(messages).where(eq(messages.threadId, threadId))
      await db.delete(threads).where(eq(threads.id, threadId))
    },
    async setStatus(threadId, status, by, now) {
      await one(threadId)
      await touch(threadId, now, status === "resolved"
        ? { resolvedAt: now, resolvedBy: JSON.stringify(by), status }
        : { resolvedAt: null, resolvedBy: null, status })
      return one(threadId)
    },
    async knownUsersByIds(ids) {
      const seen = new Map<string, CommentUser>()
      for (const part of chunks([...new Set(ids)])) {
        const rows = await db.select({ id: messages.authorId, image: messages.authorImage, name: messages.authorName }).from(messages).where(inArray(messages.authorId, part)).orderBy(desc(messages.createdAt))
        for (const row of rows) if (!seen.has(row.id)) seen.set(row.id, user(row.id, row.name, row.image))
      }
      return [...seen.values()]
    },
    async knownUsers(query, limit) {
      const pattern = `%${query.replaceAll(/[%_\\]/g, "\\$&").toLowerCase()}%`
      const rows = await db.select({ id: messages.authorId, image: messages.authorImage, name: messages.authorName })
        .from(messages)
        .where(sql`lower(coalesce(${messages.authorName}, ${messages.authorId})) like ${pattern} escape '\\'`)
        .orderBy(desc(messages.createdAt))
        .limit(limit * 10)
      const seen = new Map<string, CommentUser>()
      for (const row of rows) if (!seen.has(row.id)) seen.set(row.id, user(row.id, row.name, row.image))
      return [...seen.values()].slice(0, limit)
    },
  }
}
