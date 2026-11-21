// Trace helpers for Agent hosts. Apps read traces with `createTraceEventLog()` and `deriveTraceRuns()`.
export { emitTraceEvent, traceEventsToOpenTelemetryLogRecords, traceEventsToOpenTelemetrySpans } from "../core.ts"
export { isTraceContentAttributeKey } from "./trace-attributes.ts"
