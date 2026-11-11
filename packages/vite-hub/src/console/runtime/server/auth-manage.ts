import * as v from "valibot";
import type { AuthConsole, AuthConsoleErrorCode, AuthConsoleMutation } from "@vite-hub/auth/console-runtime";
import type { OperationContext } from "@vite-hub/internal/operations";
import type { Result, ResultError } from "@vite-hub/runtime";
import { getAuthConsoleForRequest } from "@vite-hub/auth/server";
import {
  consoleAccessWrites,
  consoleImpersonation,
  consoleRequest,
  readConsoleAccessUser,
  withConsoleAccess,
  consoleScopeRejection,
  consoleScopesAllow,
  type ConsoleAccess,
  type ConsoleAccessRoute,
} from "./access.ts";
import { isConsoleCrossOriginCall, withConsoleCors } from "./cors.ts";
import {
  assertConsoleRequest,
  consoleRequestError,
  consoleRequestJSON,
  consoleRoute,
  type ConsoleRequestEvent,
  type ConsoleRoute,
} from "./request.ts";
import { getConsoleSections } from "./sections.ts";

const statuses: Record<AuthConsoleErrorCode, number> = {
  AUTH_CONSOLE_INVALID_REQUEST: 400,
  AUTH_CONSOLE_FORBIDDEN: 403,
  AUTH_CONSOLE_NOT_FOUND: 404,
  AUTH_CONSOLE_UNAVAILABLE: 409,
  AUTH_CONSOLE_PROVIDER_FAILED: 502,
};

function logged(error: ResultError<AuthConsoleErrorCode>): ResultError<AuthConsoleErrorCode> {
  if (error.code === "AUTH_CONSOLE_PROVIDER_FAILED")
    globalThis.console.error("[vitehub] Auth Console operation failed.", error.cause);
  return error;
}

/** An Auth Console failure as the error of an operation: its code, why, fix, and the HTTP status of the code. */
function operationFailure(error: ResultError<AuthConsoleErrorCode>): Error {
  return Object.assign(logged(error), { statusCode: statuses[error.code], statusMessage: error.why });
}

function routeFailure(error: ResultError<AuthConsoleErrorCode>): Response {
  logged(error);
  return Response.json(
    { message: error.why, code: error.code, fix: error.fix },
    { status: statuses[error.code], headers: { "cache-control": "no-store" } },
  );
}

function isRequestEvent(event: unknown): event is ConsoleRequestEvent {
  return event instanceof Object && "~standard" in event;
}

export type AuthOperationContext = Omit<OperationContext, "access"> & { access: ConsoleAccess };

/** The Auth Console of one operation call, with the request that carries the app session or the OAuth access token. */
async function operationAuthConsole(context: AuthOperationContext): Promise<{ api: AuthConsole; request: Request }> {
  if (!getConsoleSections().includes("auth")) throw consoleRequestError(404, "Auth section not found.");
  const { access, request } = context;
  if (!request) throw consoleRequestError(400, "Auth management needs the request of the call.");
  // An OAuth access token has no app session, so the Auth Console acts as the user of the token.
  const user = access.via === "oauth" ? access.user ?? (await readConsoleAccessUser(access)) : undefined;
  const api = getAuthConsoleForRequest(request, isRequestEvent(context.event) ? context.event : undefined, {
    impersonation: consoleImpersonation(),
    ...(user ? { bearer: { user, sessionId: access.sessionId } } : {}),
  });
  return { api, request };
}

/** Runs one read of the Auth section, such as `auth.users`, and returns its data. */
export async function runAuthConsoleRead<T>(
  context: AuthOperationContext,
  read: (api: AuthConsole, request: Request) => Promise<Result<T, AuthConsoleErrorCode>>,
): Promise<T> {
  const { api, request } = await operationAuthConsole(context);
  const [error, data] = await read(api, request);
  if (error) throw operationFailure(error);
  return data;
}

/** Runs one action of the Auth section, such as `auth.ban`, and returns its record: the action, the actor, and the target. */
export async function runAuthConsoleAction(context: AuthOperationContext, mutation: AuthConsoleMutation): Promise<unknown> {
  const { api, request } = await operationAuthConsole(context);
  const [error, response] = await api.execute(mutation, request);
  if (error) throw operationFailure(error);
  return await response.json();
}

const id = v.pipe(v.string(), v.minLength(1), v.maxLength(512));
const command = v.union([
  v.object({ action: v.literal("impersonate"), userId: id }),
  v.object({ action: v.literal("stopImpersonating") }),
]);

/**
 * Starts and stops impersonation. Both set the app session cookie on the app origin, which an operation on the Console
 * RPC cannot do. One-time tickets that the endpoint redeems will replace this route. Every other Auth management call
 * is an `auth.*` operation.
 */
async function handler(event: ConsoleRequestEvent, access: ConsoleAccess): Promise<Response> {
  assertConsoleRequest(event, ["POST"]);
  if (!getConsoleSections().includes("auth"))
    throw consoleRequestError(404, "Auth section not found.");
  const request = consoleRequest(event);
  if (request.headers.get("x-vitehub-console") !== "1")
    throw consoleRequestError(403, "The Console request header is required.");
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  // Browser-controlled Fetch Metadata survives trusted TLS termination, as in Console RPC.
  if (
    (origin === "null" ||
      site === "cross-site" ||
      site === "same-site" ||
      (site !== "same-origin" && origin !== null && origin !== new URL(request.url).origin)) &&
    !isConsoleCrossOriginCall(request, access)
  )
    throw consoleRequestError(403, "The Console request must use the same origin.");
  const input = await consoleRequestJSON(event);
  const parsed = v.safeParse(command, input);
  if (!parsed.success)
    return Response.json({ message: "Invalid Auth Console request. Run the other Auth management calls as auth.* operations." }, { status: 400 });
  const { output } = parsed;
  // A missing OAuth scope gets the insufficient_scope challenge, so the Console can ask for the scope again.
  if (!consoleScopesAllow(access, { kind: "write" }))
    return consoleScopeRejection({ kind: "write" }, "changing Auth data");
  // A read-only grant (`"auth:read"`) never changes Auth data.
  if (!consoleAccessWrites(access, "auth"))
    return Response.json(
      { message: "This Console access can read Auth data but not change it." },
      { status: 403, headers: { "cache-control": "no-store" } },
    );
  const impersonation = consoleImpersonation();
  if (!impersonation)
    return Response.json(
      { message: "Impersonation is off. Set console.impersonation to true to enable it." },
      { status: 404, headers: { "cache-control": "no-store" } },
    );
  // Impersonation swaps the session cookie on the app origin. A bearer call has no session to swap, and a Console
  // token names no administrator that the record could name.
  if (access.via !== undefined)
    return Response.json(
      { message: "Impersonation needs a signed-in administrator on the app origin. A bearer token cannot start or stop it." },
      { status: 403, headers: { "cache-control": "no-store" } },
    );
  const api = getAuthConsoleForRequest(request, event, { impersonation });
  try {
    const [error, response] =
      output.action === "stopImpersonating"
        ? await api.stopImpersonating(request)
        : await api.execute(output, request);
    return error ? routeFailure(error) : response;
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

/** `POST <base>/_vitehub/auth/manage`: impersonation only. */
const consoleAuthManageRoute: ConsoleRoute = consoleRoute(withConsoleCors(guarded));
export default consoleAuthManageRoute;
