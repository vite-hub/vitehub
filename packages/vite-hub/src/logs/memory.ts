import type { DrainContext } from "evlog";
import * as v from "valibot";
import { logCursorExpiredError, logEntrySchema, parseLogQuery } from "./source.ts";
import { viteHubErrorDiagnostics } from "../error-diagnostics.ts";
import type { LogEntry, LogSource } from "./source.ts";

export interface LogBuffer {
  readonly source: LogSource;
  /** Accept already redacted events. Invalid or oversized events are dropped, never thrown into the producer. */
  append(entry: LogEntry): void;
  /** Attach to the existing Evlog drain hook after redaction. Does not initialize Evlog. */
  drain(context: DrainContext): void;
  clear(): void;
}

export function createLogBuffer(
  options: { id?: string; label?: string; maxEntries?: number; maxEntryBytes?: number } = {},
): LogBuffer {
  const maxEntries = options.maxEntries ?? 256;
  const maxEntryBytes = options.maxEntryBytes ?? 16_384;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 10_000)
    throw viteHubErrorDiagnostics.VITE_HUB_LOGS_MAX_ENTRIES_INVALID();
  if (!Number.isSafeInteger(maxEntryBytes) || maxEntryBytes < 256 || maxEntryBytes > 262_144)
    throw viteHubErrorDiagnostics.VITE_HUB_LOGS_MAX_ENTRY_BYTES_INVALID();
  const entries: LogEntry[] = [];
  const retainedIds = new Set<string>();
  let dropped = 0;
  const encoder = new TextEncoder();
  function append(entry: LogEntry): void {
    try {
      const serialized = JSON.stringify(entry);
      if (encoder.encode(serialized).byteLength > maxEntryBytes) {
        dropped++;
        return;
      }
      const snapshot = v.parse(logEntrySchema, JSON.parse(serialized));
      if (retainedIds.has(snapshot.id)) return;
      retainedIds.add(snapshot.id);
      entries.push(snapshot);
      if (entries.length > maxEntries) {
        retainedIds.delete(entries.shift()!.id);
        dropped++;
      }
    } catch {
      dropped++;
    }
  }
  const source: LogSource = {
    info: {
      id: options.id ?? "local",
      label: options.label ?? "Local Evlog buffer",
      retention: { kind: "memory", maxEntries, maxEntryBytes },
      filters: ["text", "level", "service"],
    },
    async query(input, queryOptions) {
      queryOptions?.signal?.throwIfAborted();
      const query = parseLogQuery(input);
      const cursorIndex = query.cursor
        ? entries.findIndex((entry) => entry.id === query.cursor)
        : entries.length;
      if (cursorIndex === -1) throw logCursorExpiredError();
      const text = query.text?.toLowerCase();
      const page: LogEntry[] = [];
      for (let index = cursorIndex - 1; index >= 0; index--) {
        const entry = entries[index]!;
        if (query.level && entry.level !== query.level) continue;
        if (query.service && entry.service !== query.service) continue;
        if (text && !JSON.stringify(entry).toLowerCase().includes(text)) continue;
        if (page.length === query.limit) {
          return structuredClone({ entries: page, cursor: page[page.length - 1]!.id, dropped });
        }
        page.push(entry);
      }
      return structuredClone({ entries: page, dropped });
    },
  };
  return {
    source,
    append,
    drain({ event }) {
      const message = [event.message, event.event, event.path].find(
        (value) => typeof value === "string",
      );
      append({
        id: crypto.randomUUID(),
        timestamp: event.timestamp,
        level: event.level === "trace" ? "debug" : event.level === "fatal" ? "error" : event.level,
        service: event.service,
        message: typeof message === "string" ? message : "Event",
        data: event,
      });
    },
    clear() {
      entries.length = 0;
      retainedIds.clear();
      dropped = 0;
    },
  };
}
