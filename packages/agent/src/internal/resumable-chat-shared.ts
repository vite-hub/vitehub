import { invariant } from "@vite-hub/internal/invariant"

import { agentDiagnostics } from "../agent-diagnostics.ts"
import { chatStreamSqlSource } from "./chat-stream-sql.ts"

import type { ChatStreamSql, ChatStreamSqlValue } from "./chat-stream-sql.ts"
import type { ResumableChatClaim, ResumableChatClaimResult, ResumableChatSession } from "./resumable-chat.ts"

export const chatStreamTables = {
  chunks: "vitehub_agent_chat_stream_chunks",
  streams: "vitehub_agent_chat_streams",
} as const

const streams = chatStreamTables.streams
const chunks = chatStreamTables.chunks
const pollMs = 100
const heartbeatMs = 2_000
const staleMs = 20_000
const chunkRowBytes = 256 * 1024
const readChunkRows = 64
const discoveryAttempts = 30
const claimAttempts = 3
const cancellationReason = "Cancelled by the web chat client."

const sqliteSchema = [
  `CREATE TABLE IF NOT EXISTS ${streams} (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, latest TEXT NOT NULL, state TEXT NOT NULL, status INTEGER NOT NULL DEFAULT 200, status_text TEXT NOT NULL DEFAULT '', headers TEXT NOT NULL DEFAULT '[]', has_body INTEGER NOT NULL DEFAULT 0, error TEXT, alive_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS ${streams}_latest ON ${streams} (latest, sequence)`,
  `CREATE INDEX IF NOT EXISTS ${streams}_expires_at ON ${streams} (expires_at)`,
  `CREATE TABLE IF NOT EXISTS ${chunks} (stream INTEGER NOT NULL, position INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (stream, position))`,
  `CREATE TRIGGER IF NOT EXISTS ${streams}_delete_chunks AFTER DELETE ON ${streams} BEGIN DELETE FROM ${chunks} WHERE stream = OLD.sequence; END`,
]

const now = {
  postgres: "CAST(EXTRACT(EPOCH FROM clock_timestamp()) * 1000 AS BIGINT)",
  sqlite: "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)",
} as const

const reclaimable = `expires_at < {now} OR (id = ? AND (state = 'stopped' OR (state IN ('claimed', 'open') AND alive_at < {now} - ?)))`
const touchSql = `UPDATE ${streams} SET alive_at = {now}, expires_at = {now} + ? WHERE sequence = ? AND state IN ('claimed', 'open') RETURNING state`

type Query = (text: string, params?: readonly ChatStreamSqlValue[]) => Promise<Record<string, unknown>[]>

interface StreamRow {
  aliveAt: number
  hasBody: boolean
  headers: [string, string][]
  now: number
  state: string
  status: number
  statusText: string
}

const schemas = new WeakMap<ChatStreamSql, Promise<void>>()

function createQuery(sql: ChatStreamSql): Query {
  return async (text, params) => await sql.query(text.replaceAll("{now}", now[sql.dialect]), params)
}

async function checkPostgresTables(query: Query): Promise<void> {
  const [row] = await query("SELECT to_regclass(?) IS NOT NULL AS streams, to_regclass(?) IS NOT NULL AS chunks", [streams, chunks])
  const missing = [row?.streams === true ? undefined : streams, row?.chunks === true ? undefined : chunks].filter(name => name !== undefined)
  if (missing.length) throw agentDiagnostics.AGENT_RESUMABLE_CHAT_POSTGRES_TABLES_MISSING({ tables: missing })
}

async function openStreams(sql: ChatStreamSql): Promise<Query> {
  const query = createQuery(sql)
  let ready = schemas.get(sql)
  if (!ready) {
    ready = sql.dialect === "postgres" ? checkPostgresTables(query) : (async () => {
      for (const statement of sqliteSchema) await query(statement)
    })()
    schemas.set(sql, ready)
    ready.catch(() => schemas.delete(sql))
  }
  await ready
  return query
}

function text(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value)
}

function streamRow(row: Record<string, unknown>): StreamRow {
  const headers: unknown = JSON.parse(text(row.headers) || "[]")
  return {
    aliveAt: Number(row.alive_at),
    hasBody: Number(row.has_body) === 1,
    // SAFETY: The writer stores `[...headers]`, which is a list of name and value pairs.
    headers: Array.isArray(headers) ? headers as [string, string][] : [],
    now: Number(row.now),
    state: text(row.state),
    status: Number(row.status),
    statusText: text(row.status_text),
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = ""
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000))
  }
  return btoa(binary)
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]!
  const bytes = new Uint8Array(parts.reduce((size, part) => size + part.length, 0))
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.length
  }
  return bytes
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, ms))
}

function streamLost(): Error {
  return new Error("[vitehub] The resumable web chat stream stopped: its writer stopped sending, or the stream expired.")
}

async function readStream(query: Query, sequence: number): Promise<StreamRow | undefined> {
  const [row] = await query(`SELECT state, status, status_text, headers, has_body, alive_at, {now} AS now FROM ${streams} WHERE sequence = ?`, [sequence])
  return row ? streamRow(row) : undefined
}

function streamBody(query: Query, sequence: number): ReadableStream<Uint8Array> {
  let cursor = 0
  let cancelled = false
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (!cancelled) {
        const rows = await query(`SELECT s.state, s.error, s.alive_at, {now} AS now, c.position, c.data FROM ${streams} s LEFT JOIN ${chunks} c ON c.stream = s.sequence AND c.position > ? WHERE s.sequence = ? ORDER BY c.position LIMIT ?`, [cursor, sequence, readChunkRows])
        if (cancelled) return
        const [row] = rows
        if (!row) return controller.error(streamLost())
        if (row.position != null) {
          for (const chunk of rows) {
            controller.enqueue(fromBase64(text(chunk.data)))
            cursor = Number(chunk.position)
          }
          return
        }
        if (row.state === "done" || row.state === "stopped") return controller.close()
        if (row.state === "failed") return controller.error(new Error(text(row.error)))
        if (Number(row.now) - Number(row.alive_at) > staleMs) return controller.error(streamLost())
        await sleep(pollMs)
      }
    },
    cancel() {
      cancelled = true
    },
  }, { highWaterMark: 0 })
}

async function responseOnceOpen(query: Query, sequence: number): Promise<Response | undefined> {
  for (;;) {
    const row = await readStream(query, sequence)
    if (!row) return
    if (row.state === "claimed") {
      if (row.now - row.aliveAt > staleMs) return
      await sleep(pollMs)
      continue
    }
    if (row.state === "failed" && !row.hasBody) throw agentDiagnostics.AGENT_RESUMABLE_CHAT_STREAM_FAILED()
    return new Response(row.hasBody ? streamBody(query, sequence) : null, {
      headers: new Headers(row.headers),
      status: row.status,
      statusText: row.statusText,
    })
  }
}

interface SharedChatStreamsOptions {
  journal: () => unknown
  ttlMs: number
}

/**
 * Keeps resumable chat streams in the database of the Agent journal. The process that claims a stream writes its
 * bytes as chunk rows, and any process reads them back by polling, so a client can resume on another instance.
 */
export function createSharedChatStreams(options: SharedChatStreamsOptions): { session(latestKey: string): Promise<ResumableChatSession> } {
  const liveTtlMs = options.ttlMs + staleMs

  function claimed(query: Query, dialect: ChatStreamSql["dialect"], sequence: number): ResumableChatClaim {
    let settled = false
    let stopped = false
    let released = false
    let touching = false
    let persistenceFailure: Error | undefined
    const abort = new AbortController()
    let position = 0
    let pending: Uint8Array[] = []
    let flushing: Promise<void> | undefined
    let upstream: ReadableStreamDefaultReader<Uint8Array> | undefined
    let local: ReadableStreamDefaultController<Uint8Array> | undefined
    let localOpen = true

    function closeLocal(error?: unknown): void {
      if (!localOpen) return
      localOpen = false
      if (!local) return
      if (error === undefined) local.close()
      else local.error(error)
    }

    function stop(error?: Error): void {
      if (stopped) return
      stopped = true
      release()
      abort.abort(error ?? cancellationReason)
      closeLocal(error)
      void upstream?.cancel(abort.signal.reason).catch(() => undefined)
    }

    async function checkOwnership(): Promise<void> {
      const [row] = await query(`SELECT state FROM ${streams} WHERE sequence = ?`, [sequence])
      if (!released && (!row || row.state === "stopped")) stop(row ? undefined : streamLost())
    }

    async function touch(): Promise<void> {
      if (released || touching) return
      touching = true
      try {
        const rows = await query(touchSql, [liveTtlMs, sequence])
        if (!rows.length && !released) await checkOwnership()
      } finally {
        touching = false
      }
    }

    const heartbeat = setInterval(() => {
      void touch().catch(() => undefined)
    }, heartbeatMs)
    heartbeat.unref?.()

    function release(): void {
      clearInterval(heartbeat)
      released = true
    }

    async function flushOnce(): Promise<void> {
      const batch: Uint8Array[] = []
      let size = 0
      while (pending.length && size + pending[0]!.length <= chunkRowBytes) {
        const part = pending.shift()!
        batch.push(part)
        size += part.length
      }
      position++
      const rows = await query(`INSERT INTO ${chunks} (stream, position, data) SELECT sequence, ?, ? FROM ${streams} WHERE sequence = ? AND state = 'open'${dialect === "postgres" ? " FOR UPDATE" : ""} RETURNING position`, [position, toBase64(concat(batch)), sequence])
      if (!rows.length) await checkOwnership()
    }

    function schedule(): void {
      if (flushing || !pending.length || stopped || persistenceFailure) return
      flushing = flushOnce().then(() => {
        flushing = undefined
        schedule()
      }, (error: unknown) => {
        flushing = undefined
        persistenceFailure = new Error("[vitehub] The web chat stream could not be stored.", { cause: error })
        pending = []
      })
    }

    async function drain(): Promise<void> {
      while (flushing) await flushing
    }

    async function finish(error?: Error): Promise<void> {
      await drain()
      if (stopped) return
      const failure = error ?? persistenceFailure
      const rows = await query(
        `UPDATE ${streams} SET state = ?, error = ?, alive_at = {now}, expires_at = {now} + ? WHERE sequence = ? AND state IN ('claimed', 'open') RETURNING sequence`,
        [failure ? "failed" : "done", failure?.message ?? null, options.ttlMs, sequence],
      )
      if (!rows.length) await checkOwnership()
      else closeLocal(failure)
    }

    async function consume(): Promise<void> {
      try {
        while (!stopped) {
          const chunk = await upstream!.read()
          if (chunk.done || stopped) break
          const value = chunk.value.slice()
          if (localOpen) local?.enqueue(value)
          if (!persistenceFailure) {
            for (let start = 0; start < value.length; start += chunkRowBytes) {
              pending.push(value.subarray(start, start + chunkRowBytes))
            }
            schedule()
          }
        }
      } catch (error) {
        await finish(new Error(errorText(error), { cause: error }))
        return
      }
      await finish()
    }

    async function open(headers: Headers, response: Response): Promise<void> {
      try {
        const rows = await query(
          `UPDATE ${streams} SET state = 'open', status = ?, status_text = ?, headers = ?, has_body = 1, alive_at = {now}, expires_at = {now} + ? WHERE sequence = ? AND state = 'claimed' RETURNING sequence`,
          [response.status, response.statusText, JSON.stringify([...headers]), liveTtlMs, sequence],
        )
        if (!rows.length) await checkOwnership()
      } catch (error) {
        persistenceFailure = new Error("[vitehub] The web chat stream could not be opened.", { cause: error })
      }
      await consume()
    }

    return {
      kind: "claimed",
      signal: abort.signal,
      async complete(response, completion) {
        invariant(!settled, "the web chat route calls complete() once, before it settles the Resumable Chat claim in another way")
        settled = true
        const headers = new Headers(response.headers)
        headers.set("x-vitehub-message-id", completion.messageId || "")
        headers.set("x-vitehub-run-id", completion.runId || "")
        headers.delete("content-length")
        const init = { headers, status: response.status, statusText: response.statusText }
        if (!response.body) {
          const written = query(
            `UPDATE ${streams} SET state = 'done', status = ?, status_text = ?, headers = ?, has_body = 0, alive_at = {now}, expires_at = {now} + ? WHERE sequence = ? AND state = 'claimed' RETURNING sequence`,
            [response.status, response.statusText, JSON.stringify([...headers]), options.ttlMs, sequence],
          ).finally(release)
          if (!(await written).length) throw agentDiagnostics.AGENT_RESUMABLE_CHAT_STREAM_FAILED()
          return new Response(null, init)
        }
        upstream = response.body.getReader()
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            local = controller
            if (!localOpen) {
              if (abort.signal.reason instanceof Error) controller.error(abort.signal.reason)
              else controller.close()
            }
          },
          cancel() {
            localOpen = false
          },
        })
        if (stopped) {
          closeLocal()
          void upstream.cancel(cancellationReason).catch(() => undefined)
          release()
          return new Response(body, init)
        }
        const written = open(headers, response).catch((error: unknown) => {
          closeLocal(new Error("[vitehub] The web chat stream could not be stored.", { cause: error }))
        }).finally(release)
        try {
          completion.waitUntil(written)
        } catch (error) {
          stop()
          release()
          void query(`DELETE FROM ${streams} WHERE sequence = ?`, [sequence]).catch(() => undefined)
          throw error
        }
        return new Response(body, init)
      },
      async fail() {
        if (settled) return
        settled = true
        release()
        await query(`DELETE FROM ${streams} WHERE sequence = ?`, [sequence]).catch(() => undefined)
      },
    }
  }

  return {
    async session(latestKey) {
      const source = chatStreamSqlSource(options.journal())
      if (!source) throw agentDiagnostics.AGENT_RESUMABLE_CHAT_JOURNAL_UNSUPPORTED()
      const sql = await source()
      const query = await openStreams(sql)
      const streamId = (invocationId: string) => JSON.stringify([latestKey, invocationId])

      return {
        async claim(invocationId): Promise<ResumableChatClaimResult> {
          const id = streamId(invocationId)
          for (let attempt = 0; attempt < claimAttempts; attempt++) {
            await query(`DELETE FROM ${streams} WHERE ${reclaimable}`, [id, staleMs])
            const [inserted] = await query(
              `INSERT INTO ${streams} (id, latest, state, alive_at, expires_at) VALUES (?, ?, 'claimed', {now}, {now} + ?) ON CONFLICT (id) DO NOTHING RETURNING sequence`,
              [id, latestKey, liveTtlMs],
            )
            if (inserted) return claimed(query, sql.dialect, Number(inserted.sequence))
            const [existing] = await query(`SELECT sequence FROM ${streams} WHERE id = ?`, [id])
            if (!existing) continue
            return {
              kind: "existing",
              response: responseOnceOpen(query, Number(existing.sequence)).then((response) => {
                if (!response) throw agentDiagnostics.AGENT_RESUMABLE_CHAT_STREAM_FAILED()
                return response
              }),
            }
          }
          throw agentDiagnostics.AGENT_RESUMABLE_CHAT_CLAIM_CONFLICT()
        },
        async latest() {
          for (let attempt = 0; attempt < discoveryAttempts; attempt++) {
            const [row] = await query(`SELECT sequence, state FROM ${streams} WHERE latest = ? AND expires_at >= {now} ORDER BY sequence DESC LIMIT 1`, [latestKey])
            if (row) return row.state === "stopped" ? undefined : await responseOnceOpen(query, Number(row.sequence))
            await sleep(pollMs)
          }
        },
        async stop(invocationId) {
          const id = streamId(invocationId)
          await query(`UPDATE ${streams} SET state = 'stopped', expires_at = {now} + ? WHERE id = ? AND state <> 'stopped'`, [options.ttlMs, id])
        },
      }
    },
  }
}
