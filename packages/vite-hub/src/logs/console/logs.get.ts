import { getStandardContext } from "@vite-hub/runtime/internal/h3"
import * as v from "valibot";
import { getLogSource } from "../host.ts";
import {
  isLogCursorExpiredError,
  logPageSchema,
  logSourceInfoSchema,
  parseLogQuery,
} from "../source.ts";
import { withConsoleAccess, type ConsoleAccessRoute } from "../../console/runtime/server/access.ts";
import { assertConsoleRequest, consoleRequestURL, consoleRoute } from "../../console/runtime/server/request.ts";
import { consoleHttpError } from "../../console/runtime/server/http-error.ts";
import { viteHubErrorDiagnostics } from "../../error-diagnostics.ts";
import type { ConsoleRequestEvent, ConsoleRoute } from "../../console/runtime/server/request.ts";
import type { LogPage, LogSourceInfo } from "../source.ts";

/** A Logs failure that names its own code, which the route answers with. */
function isLogsDiagnostic(error: unknown): error is Error & { code: string } {
  const code = error instanceof Error ? Reflect.get(error, "code") : undefined;
  return typeof code === "string" && code.startsWith("VITE_HUB_LOGS_");
}

export async function consoleLogsHandler(
  event: ConsoleRequestEvent,
): Promise<{ source: LogSourceInfo; page: LogPage } | { source: null }> {
  assertConsoleRequest(event);
  const source = getLogSource();
  if (!source) return { source: null };
  const params = consoleRequestURL(event).searchParams;
  let query: ReturnType<typeof parseLogQuery>;
  try {
    query = parseLogQuery({
      text: params.get("text") ?? undefined,
      level: params.get("level") ?? undefined,
      service: params.get("service") ?? undefined,
      cursor: params.get("cursor") ?? undefined,
      limit: params.has("limit") ? Number(params.get("limit")) : undefined,
    });
    for (const filter of ["text", "level", "service"] as const) {
      if (query[filter] && !source.info.filters.includes(filter))
        throw viteHubErrorDiagnostics.VITE_HUB_LOGS_FILTER_UNSUPPORTED({ filter });
    }
  } catch (error) {
    throw consoleHttpError(400, isLogsDiagnostic(error) ? error : new Error("Invalid or unsupported log filter."));
  }
  try {
    const page = v.parse(logPageSchema, await source.query(query, { signal: getStandardContext(event).req.signal }));
    if (page.entries.length > query.limit)
      throw viteHubErrorDiagnostics.VITE_HUB_LOGS_SOURCE_PAGE_TOO_LARGE({ limit: "entries" });
    const json = JSON.stringify(page);
    if (new TextEncoder().encode(json).byteLength > 4 * 1024 * 1024)
      throw viteHubErrorDiagnostics.VITE_HUB_LOGS_SOURCE_PAGE_TOO_LARGE({ limit: "bytes" });
    return { source: v.parse(logSourceInfoSchema, source.info), page };
  } catch (error) {
    if (isLogCursorExpiredError(error)) throw consoleHttpError(409, error as Error);
    throw consoleHttpError(502, isLogsDiagnostic(error) ? error : new Error("Could not read the log source."));
  }
}
/** The log page, for the `logs.list` operation. */
export const readConsoleLogs: ConsoleAccessRoute<typeof consoleLogsHandler> = withConsoleAccess(
  consoleLogsHandler,
  { section: "logs" },
);

/** `GET <base>/_vitehub/console/logs` */
const consoleLogsRoute: ConsoleRoute = consoleRoute(readConsoleLogs);
export default consoleLogsRoute;
