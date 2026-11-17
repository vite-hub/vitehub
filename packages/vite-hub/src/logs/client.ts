/** A value in `fields`. The server refuses objects and arrays. */
export type BrowserReportField = string | number | boolean | null

export interface BrowserReportOptions {
  /** What the page was doing, such as `"save-order"`. The server keeps 100 characters. */
  action?: string
  /** `"warn"` logs a warning in place of an error. Defaults to `"error"`. */
  level?: "error" | "warn"
  /**
   * At most 20 flat values, such as the HTTP status, the request id, or the id of the record that failed. Names start
   * with a letter and have at most 40 letters, digits, `_`, `.`, or `-`. The server keeps 300 characters of a string.
   */
  fields?: Record<string, BrowserReportField>
}

/**
 * Send an error that the page caught, or a warning, to the server logs, with `observability.browserErrors`. It uses the
 * route, the limit of 10 reports a page, and the one report a message rule of the uncaught errors. It never throws. On
 * the server, or when `browserErrors` is off, it does nothing.
 */
export function reportBrowserError(error: unknown, options: BrowserReportOptions = {}): void {
  // The page reporter of `browserErrors` sets this. Without it, there is nowhere to send the report.
  const report: unknown = Reflect.get(globalThis, Symbol.for("vite-hub.browserErrors"))
  if (typeof report === "function") report("handled", error, options)
}
