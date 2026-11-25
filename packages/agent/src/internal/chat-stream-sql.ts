import type { AgentInvocationD1Database } from "../invocations/d1.ts"
import type { AgentInvocationPostgresQuery } from "../invocations/postgres-store.ts"

export type ChatStreamSqlValue = string | number | null

/**
 * One SQL connection to the database of an Agent journal. Queries use `?` placeholders in both dialects.
 * Shared resumable chat streams keep their claims and bytes here.
 */
export interface ChatStreamSql {
  dialect: "postgres" | "sqlite"
  query(text: string, params?: readonly ChatStreamSqlValue[]): Promise<Record<string, unknown>[]>
}

/** Opens the chat stream SQL of one journal. Called once per request, because a Database proxy can change its driver. */
export type ChatStreamSqlSource = () => Promise<ChatStreamSql>

interface LibsqlExecutor {
  execute(statement: { sql: string, args: ChatStreamSqlValue[] }): Promise<{ rows: ArrayLike<unknown> }>
}

const registryKey: unique symbol = Symbol.for("vitehub.agent.chat-stream-sql")

type ChatStreamSqlRuntime = { [registryKey]?: WeakMap<object, ChatStreamSqlSource> }

function registry(): WeakMap<object, ChatStreamSqlSource> {
  // SAFETY: ChatStreamSqlRuntime adds only optional symbol-keyed state to the global object.
  const state = globalThis as ChatStreamSqlRuntime
  return state[registryKey] ??= new WeakMap()
}

/** Records where a journal keeps its rows, so a route with `resumable.scope: "shared"` can store streams beside them. */
export function registerChatStreamSql(journal: object, source: ChatStreamSqlSource): void {
  registry().set(journal, source)
}

export function chatStreamSqlSource(journal: unknown): ChatStreamSqlSource | undefined {
  return typeof journal === "object" && journal !== null ? registry().get(journal) : undefined
}

function namedRows(rows: ArrayLike<unknown>): Record<string, unknown>[] {
  // SAFETY: libSQL, D1, and the Postgres clients return one object with named columns per row.
  return Array.from(rows) as Record<string, unknown>[]
}

const executors = new WeakMap<object, ChatStreamSql>()

/** One executor per client, so the schema check of a client runs once. */
export function cachedChatStreamSql(client: object, create: () => ChatStreamSql): ChatStreamSql {
  let sql = executors.get(client)
  if (!sql) executors.set(client, sql = create())
  return sql
}

export function libsqlChatStreamSql(client: LibsqlExecutor): ChatStreamSql {
  return cachedChatStreamSql(client, () => ({
    dialect: "sqlite",
    query: async (text, params = []) => namedRows((await client.execute({ sql: text, args: [...params] })).rows),
  }))
}

export function d1ChatStreamSql(database: AgentInvocationD1Database): ChatStreamSql {
  return cachedChatStreamSql(database, () => ({
    dialect: "sqlite",
    query: async (text, params = []) => namedRows((await database.prepare(text).bind(...params).all()).results),
  }))
}

function postgresPlaceholders(text: string): string {
  let index = 0
  return text.replaceAll("?", () => `$${++index}`)
}

export function postgresChatStreamSql(client: AgentInvocationPostgresQuery): ChatStreamSql {
  return {
    dialect: "postgres",
    query: async (text, params = []) => namedRows(await client.unsafe(postgresPlaceholders(text), [...params])),
  }
}
