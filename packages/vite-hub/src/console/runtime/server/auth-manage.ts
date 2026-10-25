import * as v from "valibot";
import type { AuthConsoleErrorCode } from "@vite-hub/auth/console-runtime";
import type { ResultError } from "@vite-hub/runtime";
import { getAuthConsoleForRequest } from "@vite-hub/auth/server";
import { consoleRequest, withConsoleAccess, type ConsoleAccessRoute } from "./access.ts";
import {
  assertConsoleRequest,
  consoleRequestError,
  consoleRequestJSON,
  type ConsoleRequestEvent,
} from "./request.ts";
import { getConsoleSections } from "./sections.ts";

const id = v.pipe(v.string(), v.minLength(1), v.maxLength(512));
const value = v.union([
  v.string(),
  v.number(),
  v.boolean(),
  v.null(),
  v.array(v.string()),
  v.array(v.number()),
]);
const mutation = v.variant("action", [
  v.object({
    action: v.literal("ban"),
    userId: id,
    reason: v.optional(v.pipe(v.string(), v.maxLength(1000))),
    expiresIn: v.optional(v.number()),
  }),
  ...(["unban", "remove", "revokeSessions", "impersonate"] as const).map((action) =>
    v.object({ action: v.literal(action), userId: id }),
  ),
  v.object({ action: v.literal("setRole"), userId: id, role: id }),
  v.object({ action: v.literal("editField"), userId: id, field: id, value }),
  v.object({ action: v.literal("revokeSession"), id }),
  v.object({ action: v.literal("revokeConsent"), id }),
]);
const query = v.optional(
  v.object({
    offset: v.optional(v.number()),
    limit: v.optional(v.number()),
    search: v.optional(v.pipe(v.string(), v.maxLength(200))),
    filter: v.optional(v.picklist(["all", "admins", "banned", "agents"])),
    userId: v.optional(id),
  }),
);
const read = v.object({
  operation: v.picklist([
    "describe",
    "overview",
    "activity",
    "users",
    "user",
    "sessions",
    "organizations",
    "organization",
    "agents",
  ]),
  id: v.optional(id),
  query,
  activity: v.optional(
    v.object({
      group: v.optional(v.picklist(["sign-in", "admin", "agents", "organizations"])),
      userId: v.optional(id),
      cursor: v.optional(v.pipe(v.string(), v.maxLength(2048))),
      limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(200))),
    }),
  ),
});

function failure(error: ResultError<AuthConsoleErrorCode>): Response {
  const statuses = {
    AUTH_CONSOLE_INVALID_REQUEST: 400,
    AUTH_CONSOLE_FORBIDDEN: 403,
    AUTH_CONSOLE_NOT_FOUND: 404,
    AUTH_CONSOLE_UNAVAILABLE: 409,
    AUTH_CONSOLE_PROVIDER_FAILED: 502,
  };
  if (error.code === "AUTH_CONSOLE_PROVIDER_FAILED")
    globalThis.console.error("[vitehub] Auth Console operation failed.", error.cause);
  return Response.json(
    { message: error.why, code: error.code, fix: error.fix },
    { status: statuses[error.code], headers: { "cache-control": "no-store" } },
  );
}

async function handler(event: ConsoleRequestEvent): Promise<Response> {
  assertConsoleRequest(event, ["POST"]);
  if (!getConsoleSections().includes("auth"))
    throw consoleRequestError(404, "Auth section not found.");
  const request = consoleRequest(event);
  // This direct POST route also carries impersonation cookies. The RPC transport cannot carry these cookies.
  if (request.headers.get("x-vitehub-console") !== "1")
    throw consoleRequestError(403, "The Console request header is required.");
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  // Browser-controlled Fetch Metadata survives trusted TLS termination, as in Console RPC.
  if (
    origin === "null" ||
    site === "cross-site" ||
    site === "same-site" ||
    (site !== "same-origin" && origin !== null && origin !== new URL(request.url).origin)
  )
    throw consoleRequestError(403, "The Console request must use the same origin.");
  const input = await consoleRequestJSON(event);
  const api = getAuthConsoleForRequest(request, event);
  try {
    const command = v.safeParse(read, input);
    if (command.success) {
      const { operation, query, id, activity } = command.output;
      if ((operation === "user" || operation === "organization") && !id)
        return Response.json({ message: "An id is required." }, { status: 400 });
      const [error, data] =
        operation === "describe"
          ? await api.describe(request)
          : operation === "overview"
            ? await api.overview()
            : operation === "activity"
              ? await api.activity(activity)
              : operation === "user"
                ? await api.user(id!)
                : operation === "organization"
                  ? await api.organization(id!, query)
                  : await api[operation](query);
      if (error) return failure(error);
      return Response.json(data, { headers: { "cache-control": "no-store" } });
    }
    const action = v.safeParse(mutation, input);
    if (!action.success)
      return Response.json({ message: "Invalid Auth Console request." }, { status: 400 });
    const [error, response] = await api.execute(action.output, request);
    return error ? failure(error) : response;
  } catch (error) {
    globalThis.console.error("[vitehub] Auth Console operation failed.", error);
    return Response.json(
      { message: "Auth operation failed. Check the server log." },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}
const guarded: ConsoleAccessRoute<typeof handler> = withConsoleAccess(handler, {
  section: "auth",
  user: true,
});
export default guarded;
