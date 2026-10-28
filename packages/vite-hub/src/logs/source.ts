import * as v from "valibot"

export type LogLevel = "debug" | "info" | "warn" | "error"
export interface LogEntry {
  id: string
  timestamp: string
  level: LogLevel
  service: string
  message: string
  data: Record<string, unknown>
}
export interface LogQuery {
  text?: string
  level?: LogLevel
  service?: string
  cursor?: string
  limit?: number
}
export interface LogPage {
  entries: LogEntry[]
  cursor?: string
  dropped?: number
}
export interface LogSourceInfo {
  id: string
  label: string
  retention: { kind: "memory", maxEntries: number, maxEntryBytes: number } | { kind: "external", description: string }
  filters: ("text" | "level" | "service")[]
}

export const logLevelSchema: v.GenericSchema<unknown, LogLevel> = v.picklist(["debug", "info", "warn", "error"])
export const logEntrySchema: v.GenericSchema<unknown, LogEntry> = v.object({
  id: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
  timestamp: v.pipe(v.string(), v.isoTimestamp()),
  level: logLevelSchema,
  service: v.string(),
  message: v.string(),
  data: v.record(v.string(), v.unknown()),
})
export const logQuerySchema: v.GenericSchema<unknown, LogQuery & { limit: number }> = v.object({
  text: v.optional(v.pipe(v.string(), v.maxLength(512))),
  level: v.optional(logLevelSchema),
  service: v.optional(v.pipe(v.string(), v.maxLength(512))),
  cursor: v.optional(v.pipe(v.string(), v.maxLength(1024))),
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(500)), 200),
})
export const logSourceInfoSchema: v.GenericSchema<unknown, LogSourceInfo> = v.object({
  id: v.string(),
  label: v.string(),
  retention: v.variant("kind", [
    v.object({ kind: v.literal("memory"), maxEntries: v.number(), maxEntryBytes: v.number() }),
    v.object({ kind: v.literal("external"), description: v.string() }),
  ]),
  filters: v.array(v.picklist(["text", "level", "service"])),
})
export const logPageSchema: v.GenericSchema<unknown, LogPage> = v.object({
  entries: v.array(logEntrySchema),
  cursor: v.optional(v.string()),
  dropped: v.optional(v.number()),
})
/** Reads an existing pipeline. This contract never initializes a logger or exporter. */
export interface LogSource {
  readonly info: LogSourceInfo
  query(query: LogQuery, options?: { signal?: AbortSignal }): Promise<LogPage>
}

export class LogCursorExpiredError extends Error {
  override name: string = "LogCursorExpiredError"
  constructor() { super("The log cursor has expired. Refresh to read the retained events.") }
}

/** Validate once at the transport boundary. Adapters must reject filters they cannot apply. */
export function parseLogQuery(input: unknown): v.InferOutput<typeof logQuerySchema> {
  return v.parse(logQuerySchema, input)
}
