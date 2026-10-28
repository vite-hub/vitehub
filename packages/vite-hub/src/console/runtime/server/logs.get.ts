import * as v from "valibot";
import { getLogSource } from "../../../logs/host.ts";
import {
  LogCursorExpiredError,
  logPageSchema,
  logSourceInfoSchema,
  parseLogQuery,
} from "../../../logs/source.ts";
import { withConsoleAccess, type ConsoleAccessRoute } from "./access.ts";
import { assertConsoleRequest, consoleRequestURL } from "./request.ts";
import type { ConsoleRequestEvent } from "./request.ts";
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
    throw Object.assign(new Error("Invalid or unsupported log filter."), { statusCode: 400 });
  }
  try {
    const page = v.parse(logPageSchema, await source.query(query));
    if (page.entries.length > query.limit)
      throw new Error("The source exceeded the requested page size.");
    const json = JSON.stringify(page);
    if (new TextEncoder().encode(json).byteLength > 4 * 1024 * 1024)
      throw new Error("The source exceeded the response size limit.");
    return { source: v.parse(logSourceInfoSchema, source.info), page };
  } catch (error) {
    if (error instanceof LogCursorExpiredError) throw Object.assign(error, { statusCode: 409 });
    throw Object.assign(new Error("Could not read the log source."), { statusCode: 502 });
  }
}
const handler: ConsoleAccessRoute<typeof consoleLogsHandler> = withConsoleAccess(
  consoleLogsHandler,
  { section: "logs" },
);
export default handler;
