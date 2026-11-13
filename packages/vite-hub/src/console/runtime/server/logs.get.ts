import { getStandardContext } from "@vite-hub/runtime/internal/h3"
import * as v from "valibot";
import { getLogSource } from "../../../logs/host.ts";
import {
  LogCursorExpiredError,
  logPageSchema,
  logSourceInfoSchema,
  parseLogQuery,
} from "../../../logs/source.ts";
import { withConsoleAccess, type ConsoleAccessRoute } from "./access.ts";
import { assertConsoleRequest, consoleRequestURL, consoleRoute } from "./request.ts";
import { consoleHttpError } from "./http-error.ts";
import type { ConsoleRequestEvent, ConsoleRoute } from "./request.ts";
import type { LogPage, LogSourceInfo } from "../../../logs/source.ts";

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
        throw new Error(`The source does not support ${filter} filters.`);
    }
  } catch {
    throw consoleHttpError(400, new Error("Invalid or unsupported log filter."));
  }
  try {
    const page = v.parse(logPageSchema, await source.query(query, { signal: getStandardContext(event).req.signal }));
    if (page.entries.length > query.limit)
      throw new Error("The source exceeded the requested page size.");
    const json = JSON.stringify(page);
    if (new TextEncoder().encode(json).byteLength > 4 * 1024 * 1024)
      throw new Error("The source exceeded the response size limit.");
    return { source: v.parse(logSourceInfoSchema, source.info), page };
  } catch (error) {
    if (error instanceof LogCursorExpiredError) throw consoleHttpError(409, error);
    throw consoleHttpError(502, new Error("Could not read the log source."));
  }
}
/** The log page, for the `logs.list` operation. */
export const readConsoleLogs: ConsoleAccessRoute<typeof consoleLogsHandler> = withConsoleAccess(
  consoleLogsHandler,
  { section: "logs" },
);

/** `GET <base>/api/_vitehub/console/logs` */
const consoleLogsRoute: ConsoleRoute = consoleRoute(readConsoleLogs);
export default consoleLogsRoute;
