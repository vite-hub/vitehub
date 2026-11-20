import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm"

import { commentsErrorDiagnostics } from "../operations-core/errors.ts"
import { commentSendCodes, commentSends } from "./database.ts"

import type { CommentsDatabase } from "../operations-core/store.ts"
import type { CommentSendCodeState, CommentSendState } from "./database.ts"

export type SendRow = typeof commentSends.$inferSelect
export type CodeRow = typeof commentSendCodes.$inferSelect

/** One thread of a send: its id, the last message when the member sent it, and whether it is the member's ask. */
export interface SentThread {
  id: string
  message: string
  role: "ask" | "quote"
}

/** The sends of one member, or of one subject, and the setup codes, in the Database of Comments. */
export interface CommentSendStore {
  insertCode: (row: CodeRow) => Promise<void>
  code: (id: string) => Promise<CodeRow | undefined>
  /** Moves a code from `from` to `to` and writes `set`, when it is still in `from` and not expired. */
  moveCode: (id: string, from: CommentSendCodeState, to: CommentSendCodeState, now: number, set?: Partial<Pick<CodeRow, "agent" | "host" | "thread" | "sealed">>) => Promise<CodeRow | undefined>
  removeCode: (id: string, member: string) => Promise<void>
  /** Deletes the codes that expired, and the other codes of `member`. */
  pruneCodes: (member: string, now: number) => Promise<void>
  insertSend: (row: SendRow) => Promise<boolean>
  send: (id: string) => Promise<SendRow | undefined>
  /** The latest send of a member with this key, among `states`. */
  sendByKey: (member: string, key: string, states: readonly CommentSendState[]) => Promise<SendRow | undefined>
  /** The latest sends of a subject that reached the agent, newest first. */
  subjectSends: (subject: { kind: string, id: string }, limit: number) => Promise<SendRow[]>
  /** The latest send of a member on a subject, newest first. */
  latestSend: (member: string, subject?: { kind: string, id: string }, states?: readonly CommentSendState[]) => Promise<SendRow | undefined>
  /** The thread link of the latest send of a member to `endpoint`, or `null`. */
  endpointThread: (member: string, endpoint: string) => Promise<string | null>
  /** The times of the sends of a member since `since`, oldest first. */
  sendTimes: (member: string, since: number) => Promise<number[]>
  setSendState: (id: string, from: readonly CommentSendState[], to: CommentSendState, now: number, set?: Partial<Pick<SendRow, "delivery" | "error">>) => Promise<boolean>
}

const tableNames = ["vitehub_comment_sends", "vitehub_comment_send_codes"]

/** The first column of each row: libSQL and D1 return objects, the SQLite proxy returns arrays. */
function names(rows: unknown): string[] {
  const list = Array.isArray(rows) ? rows : []
  return list.map(row => String(Array.isArray(row) ? row[0] : Object.values(Object(row))[0]))
}

/**
 * The sends store. Before its first query in each process, it checks that the Database has the tables of Send, and
 * fails with `COMMENTS_SEND_TABLES_MISSING` until a migration adds them. `create: true` creates them instead, for a
 * Database that Comments opened itself.
 */
export function createCommentSendStore(db: CommentsDatabase, options: { create?: readonly string[] } = {}): CommentSendStore {
  let ready: Promise<void> | undefined
  const prepare = async () => {
    if (options.create) {
      for (const statement of options.create) await db.run(sql.raw(statement))
      return
    }
    const found = names(await db.all(sql.raw(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${tableNames.map(name => `'${name}'`).join(", ")})`)))
    const missing = tableNames.filter(name => !found.includes(name))
    if (missing.length) throw Object.assign(commentsErrorDiagnostics.COMMENTS_SEND_TABLES_MISSING({ missing: missing.join(" and ") }), { status: 503 })
  }
  const gate = () => ready ??= prepare().catch((error: unknown) => {
    ready = undefined
    throw error
  })
  const run = <A extends unknown[], T>(query: (...args: A) => Promise<T>) => async (...args: A): Promise<T> => {
    await gate()
    return query(...args)
  }
  const codes = commentSendCodes
  const sends = commentSends
  return {
    insertCode: run(async (row) => {
      await db.insert(codes).values(row)
    }),
    code: run(async (id) => {
      const [row] = await db.select().from(codes).where(eq(codes.id, id)).limit(1)
      return row
    }),
    moveCode: run(async (id, from, to, now, set = {}) => {
      const [row] = await db.update(codes).set({ ...set, state: to }).where(and(eq(codes.id, id), eq(codes.state, from), gte(codes.expiresAt, now))).returning()
      return row
    }),
    removeCode: run(async (id, member) => {
      await db.delete(codes).where(and(eq(codes.id, id), eq(codes.member, member)))
    }),
    pruneCodes: run(async (member, now) => {
      await db.delete(codes).where(lt(codes.expiresAt, now))
      await db.delete(codes).where(and(eq(codes.member, member), inArray(codes.state, ["used", "refused"])))
    }),
    insertSend: run(async (row) => {
      const inserted = await db.insert(sends).values(row).onConflictDoNothing().returning({ id: sends.id })
      return inserted.length > 0
    }),
    send: run(async (id) => {
      const [row] = await db.select().from(sends).where(eq(sends.id, id)).limit(1)
      return row
    }),
    sendByKey: run(async (member, key, states) => {
      const [row] = await db.select().from(sends).where(and(eq(sends.member, member), eq(sends.key, key), inArray(sends.state, [...states]))).orderBy(desc(sends.createdAt)).limit(1)
      return row
    }),
    subjectSends: run(async (subject, limit) => db.select().from(sends)
      .where(and(eq(sends.subjectKind, subject.kind), eq(sends.subjectId, subject.id), inArray(sends.state, ["pending", "sent", "working", "done"])))
      .orderBy(desc(sends.createdAt))
      .limit(limit)),
    latestSend: run(async (member, subject, states) => {
      const [row] = await db.select().from(sends).where(and(
        eq(sends.member, member),
        ...subject ? [eq(sends.subjectKind, subject.kind), eq(sends.subjectId, subject.id)] : [],
        ...states ? [inArray(sends.state, [...states])] : [],
      )).orderBy(desc(sends.createdAt)).limit(1)
      return row
    }),
    endpointThread: run(async (member, endpoint) => {
      const [row] = await db.select({ thread: sends.thread }).from(sends).where(and(eq(sends.member, member), eq(sends.endpoint, endpoint))).orderBy(desc(sends.createdAt)).limit(1)
      return row?.thread ?? null
    }),
    sendTimes: run(async (member, since) => {
      const rows = await db.select({ createdAt: sends.createdAt }).from(sends).where(and(eq(sends.member, member), gte(sends.createdAt, since))).orderBy(sends.createdAt)
      return rows.map(row => row.createdAt)
    }),
    setSendState: run(async (id, from, to, now, set = {}) => {
      const rows = await db.update(sends).set({ ...set, state: to, updatedAt: now }).where(and(eq(sends.id, id), inArray(sends.state, [...from]))).returning({ id: sends.id })
      return rows.length > 0
    }),
  }
}
