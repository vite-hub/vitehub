import type { AuthConsole, AuthConsoleErrorCode, AuthConsoleHostOptions, AuthConsoleMutation } from "@vite-hub/auth/console-runtime";
import type { OperationContext } from "@vite-hub/internal/operations";
import type { Result, ResultError } from "@vite-hub/runtime";
import { getAuthConsoleForRequest } from "@vite-hub/auth/server";
import { consoleImpersonation, consolePerson, type ConsoleAccess } from "./access.ts";
import { consoleRequestError, type ConsoleRequestEvent } from "./request.ts";
import { getConsoleSections } from "./sections.ts";
import type { ConsoleTicket } from "./tickets.ts";

const statuses: Record<AuthConsoleErrorCode, number> = {
  AUTH_CONSOLE_INVALID_REQUEST: 400,
  AUTH_CONSOLE_FORBIDDEN: 403,
  AUTH_CONSOLE_NOT_FOUND: 404,
  AUTH_CONSOLE_UNAVAILABLE: 409,
  AUTH_CONSOLE_PROVIDER_FAILED: 502,
};

/** The reason of a refused Auth Console call, such as no live app session of the actor, after the code's `why`. */
function reason(error: ResultError<AuthConsoleErrorCode>): string {
  const cause: unknown = error.cause;
  const status = statuses[error.code];
  return status < 500 && cause instanceof Error && cause.name === "AuthConsoleError" && cause.message ? cause.message : error.why;
}

/** An Auth Console failure as the error of an operation: its code, why, fix, and the HTTP status of the code. */
export function authConsoleFailure(error: ResultError<AuthConsoleErrorCode>): Error {
  if (error.code === "AUTH_CONSOLE_PROVIDER_FAILED")
    globalThis.console.error("[vitehub] Auth Console operation failed.", error.cause);
  return Object.assign(error, { statusCode: statuses[error.code], statusMessage: reason(error) });
}

function isRequestEvent(event: unknown): event is ConsoleRequestEvent {
  return event instanceof Object && "~standard" in event;
}

export type AuthOperationContext = Omit<OperationContext, "access"> & { access: ConsoleAccess };

/**
 * The Auth Console of one operation call. A signed call from the ViteHub Console has no app session, so Auth changes run
 * as the app user with the email of the signed person. See `AuthConsoleHostOptions.actor`.
 */
async function operationAuthConsole(context: AuthOperationContext): Promise<{ api: AuthConsole; request: Request }> {
  if (!getConsoleSections().includes("auth")) throw consoleRequestError(404, "Auth section not found.");
  const { access, request } = context;
  if (!request) throw consoleRequestError(400, "Auth management needs the request of the call.");
  const host: AuthConsoleHostOptions = { impersonation: consoleImpersonation() };
  const email = consolePerson(access)?.email;
  if (access.via === "console" && email) host.actor = { email };
  const api = getAuthConsoleForRequest(request, isRequestEvent(context.event) ? context.event : undefined, host);
  return { api, request };
}

/** Runs one read of the Auth section, such as `auth.users`, and returns its data. */
export async function runAuthConsoleRead<T>(
  context: AuthOperationContext,
  read: (api: AuthConsole, request: Request) => Promise<Result<T, AuthConsoleErrorCode>>,
): Promise<T> {
  const { api, request } = await operationAuthConsole(context);
  const [error, data] = await read(api, request);
  if (error) throw authConsoleFailure(error);
  return data;
}

/**
 * Runs one action of the Auth section, such as `auth.ban`, and returns its record: the action, the actor, and the
 * target. Better Auth runs it as an app user: the signed Console person's app account, or the browser's app session of
 * an open development Console. A CLI call names no person, so it cannot run one.
 */
export async function runAuthConsoleAction(context: AuthOperationContext, mutation: AuthConsoleMutation): Promise<unknown> {
  const { access } = context;
  if (access.via === "cli")
    throw consoleRequestError(403, "Auth changes run as an app user, and a CLI call names no person. Run them from the ViteHub Console, where you act as your app account.", "CONSOLE_ACCESS_DENIED");
  if (access.via === "console" && !consolePerson(access)?.email)
    throw consoleRequestError(403, "Auth changes run as the app user with the email of your Console account, and your Console account has no email. Add an email to it, or sign in with GitHub.", "CONSOLE_ACCESS_DENIED");
  const { api, request } = await operationAuthConsole(context);
  const [error, response] = await api.execute(mutation, request);
  if (error) throw authConsoleFailure(error);
  return await response.json();
}

/**
 * `auth.impersonate` and `auth.stop-impersonating`: check the call, then return a one-time link that the browser opens
 * on the app origin. Its redemption starts or stops the impersonation with the browser's app session, which must belong
 * to the person who asked. See `tickets.ts`.
 */
export async function issueImpersonationTicket(context: AuthOperationContext, userId?: string): Promise<ConsoleTicket> {
  if (!consoleImpersonation()) throw consoleRequestError(404, "Impersonation is off. Set console.impersonation to true to enable it.");
  const { issueConsoleTicket } = await import("./tickets.ts");
  if (userId === undefined) return await issueConsoleTicket(context, "auth.stop-impersonating", {});
  const { api, request } = await operationAuthConsole(context);
  const [describeError, description] = await api.describe(request);
  if (describeError) throw authConsoleFailure(describeError);
  const action = description.actions.impersonate;
  if (!action.enabled) throw consoleRequestError(403, action.reason ?? "Impersonation is not available.", "CONSOLE_ACCESS_DENIED");
  const [userError, detail] = await api.user(userId, request);
  if (userError) throw authConsoleFailure(userError);
  if (detail.impersonation && !detail.impersonation.enabled)
    throw consoleRequestError(403, detail.impersonation.reason ?? "Better Auth does not impersonate this user.", "CONSOLE_ACCESS_DENIED");
  return await issueConsoleTicket(context, "auth.impersonate", { userId });
}
