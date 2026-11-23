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
  error: string
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
    error: text(row.error),
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
  const [row] = await query(`SELECT state, status, status_text, headers, has_body, error, alive_at, {now} AS now FROM ${streams} WHERE sequence = ?`, [sequence])
  return row ? streamRow(row) : undefined
}

function streamBody(query: Query, sequence: number): ReadableStream<Uint8Array> {
  let cursor = 0
  let cancelled = false
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (!cancelled) {
        const stateBeforeChunks = await readStream(query, sequence)
        const rows = await query(`SELECT position, data FROM ${chunks} WHERE stream = ? AND position > ? ORDER BY position LIMIT ?`, [sequence, cursor, readChunkRows])
        if (rows.length) {
          for (const chunk of rows) {
            controller.enqueue(fromBase64(text(chunk.data)))
            cursor = Number(chunk.position)
          }
          return
        }
        if (!stateBeforeChunks) return controller.error(streamLost())
        if (stateBeforeChunks.state === "done" || stateBeforeChunks.state === "stopped") return controller.close()
        if (stateBeforeChunks.state === "failed") return controller.error(new Error(stateBeforeChunks.error))
        if (stateBeforeChunks.now - stateBeforeChunks.aliveAt > staleMs) return controller.error(streamLost())
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

interface ChatStreamWriter {
  stop(): void
}

/**
 * Keeps resumable chat streams in the database of the Agent journal. The process that claims a stream writes its
 * bytes as chunk rows, and any process reads them back by polling, so a client can resume on another instance.
 */
export function createSharedChatStreams(options: SharedChatStreamsOptions): { session(latestKey: string): Promise<ResumableChatSession> } {
  const writers = new Map<string, ChatStreamWriter>()
  const liveTtlMs = options.ttlMs + staleMs

  function claimed(query: Query, id: string, sequence: number): ResumableChatClaim {
    let settled = false
    let stopped = false
    let persistFailed = false
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

    function stop(): void {
      if (stopped) return
      stopped = true
      closeLocal()
      void upstream?.cancel(cancellationReason).catch(() => undefined)
    }

    const writer: ChatStreamWriter = { stop }
    writers.set(id, writer)

    async function touch(): Promise<void> {
      if (stopped || persistFailed) return
      const rows = await query(touchSql, [liveTtlMs, sequence])
      if (!rows.length) stop()
    }

    const heartbeat = setInterval(() => {
      if (!flushing) void touch().catch(() => undefined)
    }, heartbeatMs)
    heartbeat.unref?.()

    function release(): void {
      clearInterval(heartbeat)
      if (writers.get(id) === writer) writers.delete(id)
    }

    async function flushOnce(): Promise<void> {
      const batch: Uint8Array[] = []
      let size = 0
      while (pending.length && (size === 0 || size + pending[0]!.length <= chunkRowBytes)) {
        const part = pending.shift()!
        batch.push(part)
        size += part.length
      }
      position++
      await query(`INSERT INTO ${chunks} (stream, position, data) VALUES (?, ?, ?)`, [sequence, position, toBase64(concat(batch))])
      await touch()
    }

    function schedule(): void {
      if (flushing || !pending.length || persistFailed) return
      flushing = flushOnce().then(() => {
        flushing = undefined
        schedule()
      }, () => {
        flushing = undefined
        persistFailed = true
        pending = []
      })
    }

    async function drain(): Promise<void> {
      while (flushing) await flushing
    }

    async function finish(state: "done" | "failed", error?: unknown): Promise<void> {
      await drain()
      const failed = state === "failed" || persistFailed
      const message = state === "failed" ? errorText(error) : "[vitehub] The web chat stream could not be stored."
      await query(
        `UPDATE ${streams} SET state = ?, error = ?, alive_at = {now}, expires_at = {now} + ? WHERE sequence = ? AND state = 'open'`,
        [failed ? "failed" : "done", failed ? message : null, options.ttlMs, sequence],
      ).catch(() => undefined)
    }

    async function consume(): Promise<void> {
      try {
        while (!stopped) {
          const chunk = await upstream!.read()
          if (chunk.done) break
          const value = chunk.value.slice()
          if (localOpen) local?.enqueue(value)
          if (!persistFailed) {
            pending.push(value)
            schedule()
          }
        }
        closeLocal()
        await finish("done")
      } catch (error) {
        closeLocal(error)
        await finish("failed", error)
      } finally {
        release()
      }
    }

    async function open(headers: Headers, response: Response): Promise<void> {
      try {
        const rows = await query(
          `UPDATE ${streams} SET state = 'open', status = ?, status_text = ?, headers = ?, has_body = 1, alive_at = {now}, expires_at = {now} + ? WHERE sequence = ? AND state = 'claimed' RETURNING sequence`,
          [response.status, response.statusText, JSON.stringify([...headers]), liveTtlMs, sequence],
        )
        if (!rows.length) stop()
      } catch {
        persistFailed = true
      }
      await consume()
    }

    return {
      kind: "claimed",
      complete(response, completion) {
        invariant(!settled, "the web chat route calls complete() once, before it settles the Resumable Chat claim in another way")
        settled = true
        const headers = new Headers(response.headers)
        headers.set("x-vitehub-message-id", completion.messageId || "")
        headers.set("x-vitehub-run-id", completion.runId || "")
        headers.delete("content-length")
        const init = { headers, status: response.status, statusText: response.statusText }
        if (!response.body) {
          const written = query(
            `UPDATE ${streams} SET state = 'done', status = ?, status_text = ?, headers = ?, has_body = 0, alive_at = {now}, expires_at = {now} + ? WHERE sequence = ? AND state = 'claimed'`,
            [response.status, response.statusText, JSON.stringify([...headers]), options.ttlMs, sequence],
          ).catch(() => undefined).finally(release)
          completion.waitUntil(written)
          return new Response(null, init)
        }
        upstream = response.body.getReader()
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            local = controller
            if (!localOpen) controller.close()
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
        const written = open(headers, response)
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
      const query = await openStreams(await source())
      const streamId = (invocationId: string) => JSON.stringify([latestKey, invocationId])

      return {
        async claim(invocationId): Promise<ResumableChatClaimResult> {
          const id = streamId(invocationId)
          for (let attempt = 0; attempt < claimAttempts; attempt++) {
            await query(`DELETE FROM ${chunks} WHERE stream IN (SELECT sequence FROM ${streams} WHERE ${reclaimable})`, [id, staleMs])
            await query(`DELETE FROM ${streams} WHERE ${reclaimable}`, [id, staleMs])
            const [inserted] = await query(
              `INSERT INTO ${streams} (id, latest, state, alive_at, expires_at) VALUES (?, ?, 'claimed', {now}, {now} + ?) ON CONFLICT (id) DO NOTHING RETURNING sequence`,
              [id, latestKey, liveTtlMs],
            )
            if (inserted) return claimed(query, id, Number(inserted.sequence))
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
          writers.get(id)?.stop()
        },
      }
    },
  }
}
