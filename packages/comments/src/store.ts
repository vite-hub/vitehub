import { and, desc, eq, exists, inArray, sql } from "drizzle-orm"

import { commentsSchema } from "./database.ts"

import type { RuntimeDrizzleDatabase } from "@vite-hub/database"
import type { Comment, CommentAnchor, CommentAuthor, CommentContext, CommentMention, CommentThread, CommentThreadStatus } from "./types.ts"

const { vitehubCommentThreads: threads, vitehubComments: comments } = commentsSchema

export type CommentsDatabase = RuntimeDrizzleDatabase<Record<string, unknown>>

type ThreadRow = typeof threads.$inferSelect
type CommentRow = typeof comments.$inferSelect

export interface CommentsStore {
  list(query: { page?: string, status?: CommentThreadStatus, limit: number }): Promise<CommentThread[]>
  get(id: string): Promise<CommentThread | undefined>
  /** The thread that holds a comment. */
  threadOf(commentId: string): Promise<string | undefined>
  create(input: { page: string, anchor: CommentAnchor, context?: CommentContext, body: string, author: CommentAuthor, mentions: CommentMention[] }): Promise<CommentThread>
  reply(threadId: string, input: { body: string, author: CommentAuthor, mentions: CommentMention[] }): Promise<{ comment: Comment } | { error: "not-found" | "resolved" }>
  setStatus(threadId: string, status: CommentThreadStatus, by: CommentAuthor | null): Promise<CommentThread | undefined>
  removeThread(threadId: string): Promise<void>
  removeComment(commentId: string): Promise<void>
  /** Distinct authors, newest first, for `@` suggestions. */
  authors(limit: number): Promise<CommentAuthor[]>
}

function json<T>(value: string | null): T | null {
  // SAFETY: this store wrote each JSON column from a value that the schemas in schema.ts checked.
  return value === null ? null : JSON.parse(value) as T
}

function iso(value: number): string {
  return new Date(value).toISOString()
}

function toComment(row: CommentRow): Comment {
  return {
    id: row.id,
    threadId: row.threadId,
    body: row.body,
    mentions: json<CommentMention[]>(row.mentions) ?? [],
    author: json<CommentAuthor>(row.author)!,
    createdAt: iso(row.createdAt),
    editedAt: row.editedAt === null ? null : iso(row.editedAt),
  }
}

function toThread(row: ThreadRow, rows: readonly CommentRow[]): CommentThread {
  return {
    id: row.id,
    page: row.page,
    anchor: json<CommentAnchor>(row.anchor)!,
    context: json<CommentContext>(row.context),
    status: row.status,
    createdBy: json<CommentAuthor>(row.createdBy)!,
    resolvedBy: json<CommentAuthor>(row.resolvedBy),
    resolvedAt: row.resolvedAt === null ? null : iso(row.resolvedAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    comments: rows.map(toComment),
  }
}

/** Comment threads in one Database. Each write is one atomic batch or statement. */
export function createCommentsStore(database: CommentsDatabase): CommentsStore {
  async function withComments(rows: ThreadRow[]): Promise<CommentThread[]> {
    if (!rows.length) return []
    const commentRows = await database.select().from(comments)
      .where(inArray(comments.threadId, rows.map(row => row.id)))
      .orderBy(comments.createdAt)
    const byThread = new Map<string, CommentRow[]>()
    for (const row of commentRows) {
      const list = byThread.get(row.threadId) ?? []
      list.push(row)
      byThread.set(row.threadId, list)
    }
    return rows.map(row => toThread(row, byThread.get(row.id) ?? []))
  }

  return {
    async list({ page, status, limit }) {
      const where = and(page === undefined ? undefined : eq(threads.page, page), status === undefined ? undefined : eq(threads.status, status))
      return await withComments(await database.select().from(threads).where(where).orderBy(desc(threads.updatedAt)).limit(limit))
    },
    async get(id) {
      const [thread] = await withComments(await database.select().from(threads).where(eq(threads.id, id)).limit(1))
      return thread
    },
    async threadOf(commentId) {
      const [row] = await database.select({ threadId: comments.threadId }).from(comments).where(eq(comments.id, commentId)).limit(1)
      return row?.threadId
    },
    async create({ page, anchor, context, body, author, mentions }) {
      const now = Date.now()
      const thread: ThreadRow = {
        id: crypto.randomUUID(),
        page,
        anchor: JSON.stringify(anchor),
        context: context ? JSON.stringify(context) : null,
        status: "open",
        createdBy: JSON.stringify(author),
        resolvedBy: null,
        resolvedAt: null,
        createdAt: now,
        updatedAt: now,
      }
      const comment: CommentRow = { id: crypto.randomUUID(), threadId: thread.id, body, mentions: JSON.stringify(mentions), author: JSON.stringify(author), createdAt: now, editedAt: null }
      await database.batch([database.insert(threads).values(thread), database.insert(comments).values(comment)])
      return toThread(thread, [comment])
    },
    async reply(threadId, { body, author, mentions }) {
      const now = Date.now()
      const comment: CommentRow = { id: crypto.randomUUID(), threadId, body, mentions: JSON.stringify(mentions), author: JSON.stringify(author), createdAt: now, editedAt: null }
      const [inserted, , parents] = await database.batch([
        // Read the parent in the insert statement, inside the same atomic batch as its activity update.
        database.insert(comments).select(database.select({
          id: sql<string>`${comment.id}`.as("id"),
          threadId: threads.id,
          body: sql<string>`${comment.body}`.as("body"),
          mentions: sql<string>`${comment.mentions}`.as("mentions"),
          author: sql<string>`${comment.author}`.as("author"),
          createdAt: sql<number>`${now}`.as("created_at"),
          editedAt: sql<null>`null`.as("edited_at"),
        }).from(threads).where(and(eq(threads.id, threadId), eq(threads.status, "open")))).returning(),
        database.update(threads).set({ updatedAt: now }).where(and(eq(threads.id, threadId), exists(
          database.select({ id: comments.id }).from(comments).where(eq(comments.id, comment.id)),
        ))),
        database.select({ status: threads.status }).from(threads).where(eq(threads.id, threadId)),
      ])
      if (inserted[0]) return { comment: toComment(inserted[0]) }
      return { error: parents[0]?.status === "resolved" ? "resolved" : "not-found" }
    },
    async setStatus(threadId, status, by) {
      const now = Date.now()
      const [updated, rows] = await database.batch([
        database.update(threads).set(status === "resolved"
          ? { status, resolvedBy: JSON.stringify(by), resolvedAt: now, updatedAt: now }
          : { status, resolvedBy: null, resolvedAt: null, updatedAt: now }).where(eq(threads.id, threadId)).returning(),
        database.select().from(comments).where(eq(comments.threadId, threadId)).orderBy(comments.createdAt),
      ])
      return updated[0] ? toThread(updated[0], rows) : undefined
    },
    async removeThread(threadId) {
      // SQLite enforces the foreign key only with `PRAGMA foreign_keys`, so remove the comments in the same batch.
      await database.batch([
        database.delete(comments).where(eq(comments.threadId, threadId)),
        database.delete(threads).where(eq(threads.id, threadId)),
      ])
    },
    async removeComment(commentId) {
      await database.delete(comments).where(eq(comments.id, commentId))
    },
    async authors(limit) {
      const rows = await database.select({ author: comments.author }).from(comments).orderBy(desc(comments.createdAt)).limit(limit * 10)
      const seen = new Map<string, CommentAuthor>()
      for (const row of rows) {
        const author = json<CommentAuthor>(row.author)
        if (author && !author.guest && !seen.has(author.id)) seen.set(author.id, author)
        if (seen.size >= limit) break
      }
      return [...seen.values()]
    },
  }
}
