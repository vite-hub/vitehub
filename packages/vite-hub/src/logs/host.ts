import type { LogSource } from "./source.ts";

const sourceKey: unique symbol = Symbol.for("vitehub.logs.source");

// One server bundle serves one project, and its Vite module runners share the global object.
type LogSourceScope = typeof globalThis & { [sourceKey]?: LogSource };

/** The host connects a source. It remains the owner of capture and provider setup. */
export function installLogSource(projectRoot: string, source: LogSource): void {
  // SAFETY: Only this module writes the Logs source slot of the global object.
  (globalThis as LogSourceScope)[sourceKey] = source;
}

export function getLogSource(): LogSource | undefined {
  // SAFETY: Only this module writes the Logs source slot of the global object.
  return (globalThis as LogSourceScope)[sourceKey];
}
