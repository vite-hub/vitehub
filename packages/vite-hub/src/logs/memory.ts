import type { DrainContext } from "evlog"
import * as v from "valibot"
import { LogCursorExpiredError, logEntrySchema, parseLogQuery } from "./source.ts"
import type { LogEntry, LogSource } from "./source.ts"

export interface LogBuffer {
  readonly source: LogSource
  /** Accept already redacted events. Invalid or oversized events are dropped, never thrown into the producer. */
  append(entry: LogEntry): void
  /** Attach to the existing Evlog drain hook after redaction. Does not initialize Evlog. */
  drain(context: DrainContext): void
  clear(): void
}

export function createLogBuffer(options: { id?: string, label?: string, maxEntries?: number, maxEntryBytes?: number } = {}): LogBuffer {
  const maxEntries = options.maxEntries ?? 256
  const maxEntryBytes = options.maxEntryBytes ?? 16_384
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 10_000) throw new TypeError("logs.maxEntries must be an integer from 1 to 10000.")
  if (!Number.isSafeInteger(maxEntryBytes) || maxEntryBytes < 256 || maxEntryBytes > 262_144) throw new TypeError("logs.maxEntryBytes must be an integer from 256 to 262144.")
  const entries: LogEntry[] = []
  let dropped = 0
  const encoder = new TextEncoder()
  function append(entry: LogEntry): void {
    try {
      const serialized = JSON.stringify(entry)
      if (encoder.encode(serialized).byteLength > maxEntryBytes) { dropped++; return }
      const snapshot = v.parse(logEntrySchema, JSON.parse(serialized))
      if (entries.some(item => item.id === snapshot.id)) return
      entries.push(snapshot)
      if (entries.length > maxEntries) { entries.shift(); dropped++ }
    }
    catch { dropped++ }
  }
  const source: LogSource = {
    info: {
      id: options.id ?? "local",
      label: options.label ?? "Local Evlog buffer",
      retention: { kind: "memory", maxEntries, maxEntryBytes },
      filters: ["text", "level", "service"],
    },
    async query(input, queryOptions) {
      queryOptions?.signal?.throwIfAborted()
      const query = parseLogQuery(input)
      const cursorIndex = query.cursor ? entries.findIndex(entry => entry.id === query.cursor) : entries.length
      if (cursorIndex === -1) throw new LogCursorExpiredError()
      const text = query.text?.toLowerCase()
      const filtered = entries.slice(0, cursorIndex).reverse().filter(entry =>
        (!query.level || entry.level === query.level)
        && (!query.service || entry.service === query.service)
        && (!text || JSON.stringify(entry).toLowerCase().includes(text)),
      )
      const page = filtered.slice(0, query.limit)
      const last = page.at(-1)
      return structuredClone({ entries: page, ...(filtered.length > query.limit && last ? { cursor: last.id } : {}), dropped })
    },
  }
  return {
    source,
    append,
    drain({ event }) {
      const message = [event.message, event.event, event.path].find(value => typeof value === "string")
      append({ id: crypto.randomUUID(), timestamp: event.timestamp, level: event.level, service: event.service, message: typeof message === "string" ? message : "Event", data: event })
    },
    clear() { entries.length = 0; dropped = 0 },
  }
}
