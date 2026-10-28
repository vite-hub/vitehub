/** ViteHub Logs uses Evlog's logger API, options, hooks and event structures unchanged. */
export * from "evlog"
export { createLogBuffer } from "./logs/memory.ts"
export type { LogBuffer } from "./logs/memory.ts"
export { LogCursorExpiredError, parseLogQuery } from "./logs/source.ts"
export type { LogEntry, LogLevel, LogPage, LogQuery, LogSource, LogSourceInfo } from "./logs/source.ts"
