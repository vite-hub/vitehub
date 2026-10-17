import * as v from "valibot";

import { isViteHubSecretEqual } from "@vite-hub/internal/secret";

import { ConnectionError, isConnectionError } from "../errors.ts";
import { CONNECTION_NAME_MAX_LENGTH } from "../types.ts";
import { connectionsRuntimeFor } from "./http-access.ts";
import { managementErrorBody } from "./http-diagnostics.ts";
import { page, readCookie, requestReturnPath, RETURN_COOKIE } from "./http-page.ts";

import type { ConnectionsRuntime } from "../runtime.ts";
import type { ConnectionsAccess } from "./http-access.ts";

const MAX_BODY_BYTES = 64 * 1024;
const STATE_COOKIE = "vitehub_connection_state";
const MAX_APPROVAL_COUNT_PAGES = 10_000;

// Discovery preserves filesystem-valid characters, including symbols such as `+`.
// Keep management validation in step with the generated registry.
const name = v.pipe(v.string(), v.minLength(1), v.maxLength(CONNECTION_NAME_MAX_LENGTH), v.check(value => value === value.trim(), "Connection names cannot start or end with whitespace."));
const id = v.pipe(v.string(), v.minLength(1), v.maxLength(256));
const actionSchema = v.variant("action", [
  v.object({ action: v.literal("list") }),
  v.object({ action: v.literal("inspect"), name }),
  v.object({ action: v.literal("authorize"), name, redirectUri: v.pipe(v.string(), v.url()) }),
  v.object({
    action: v.literal("complete"),
    code: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)),
    state: id,
  }),
  v.object({ action: v.literal("revoke"), name }),
  v.object({
    action: v.literal("set-key"),
    key: v.pipe(v.string(), v.minLength(1), v.maxLength(8192)),
    name,
  }),
  v.object({ action: v.literal("activity"), before: v.optional(id), name }),
  v.object({
    action: v.literal("approvals"),
    before: v.optional(id),
    name: v.optional(name),
    status: v.optional(v.picklist(["approved", "denied", "executed", "failed", "pending"])),
  }),
  v.object({
    action: v.literal("approval-summaries"),
    before: v.optional(id),
    name: v.optional(name),
    status: v.optional(v.picklist(["approved", "denied", "executed", "failed", "pending"])),
  }),
  v.object({ action: v.literal("approval-counts") }),
  v.object({ action: v.literal("approve"), id }),
  v.object({ action: v.literal("deny"), id }),
]);

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "cache-control": "no-store", "content-type": "application/json", ...headers },
    status,
  });
}

/** HTTP status of a Connections failure. */
export function errorStatus(error: unknown): number {
  if (!isConnectionError(error)) return 500;
  return {
    approval_required: 409,
    denied: 403,
    execution_unknown: 409,
    invalid: 400,
    provider: 502,
    reauth_required: 409,
  }[error.reason];
}

export function errorResponse(error: unknown): Response {
  if (isConnectionError(error))
    return json({ error: managementErrorBody(error.code, error.message, error.requestId) }, errorStatus(error));
  return json({ error: managementErrorBody("CONNECTION_FAILED", "The Connections request failed.") }, 500);
}

/**
 * The same-origin check of the action route. `url` is the request URL that the server sees. Behind a
 * TLS-terminating proxy that the server does not trust, it can be `http:` while the browser sends an `https:` Origin.
 */
function originRejection(request: Request, url: URL): Response | undefined {
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) {
    const received = origin.slice(0, 256);
    return json({
      error: managementErrorBody(
        "CONNECTION_ORIGIN_REJECTED",
        `The request Origin ${received} does not match the server origin ${url.origin}.`,
        undefined,
        { expectedOrigin: url.origin, receivedOrigin: received },
      ),
    }, 403);
  }
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return json({
      error: managementErrorBody("CONNECTION_ORIGIN_REJECTED", "The browser marked this request as cross-site.", undefined, { expectedOrigin: url.origin }),
    }, 403);
  }
  return undefined;
}

async function readBody(request: Request): Promise<unknown> {
  if (!request.body) return undefined;
  const reader = request.body.getReader();
  const bytes = new Uint8Array(MAX_BODY_BYTES);
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > MAX_BODY_BYTES - size) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      bytes.set(value, size);
      size += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes.subarray(0, size)));
  } catch {
    return undefined;
  }
}

/** One Connections management route. Its body gets the runtime only from a checked access. */
export interface ConnectionsRoute {
  readonly id: "action" | "callback" | "connect";
  readonly method: "GET" | "POST";
  readonly matches: (path: string, base: string) => boolean;
  readonly handle: (access: ConnectionsAccess, base: string) => Promise<Response>;
}

const connect: ConnectionsRoute = {
  id: "connect",
  method: "GET",
  matches: (path, base) => path.startsWith(`${base}/connect/`),
  async handle(access, base) {
    const runtime = connectionsRuntimeFor(access);
    const { request } = access;
    const url = new URL(request.url);
    const returnTo = requestReturnPath(request);
    const failure = (message: string, status: number, code?: string) =>
      page({ code, message, outcome: "error", returnTo, status, title: "Connection failed" });
    // A foreign page must not start a flow in the name of the signed-in manager.
    if (request.headers.get("sec-fetch-site") === "cross-site")
      return failure("Start the connection from this application.", 403);
    let connectionName: string;
    try {
      connectionName = decodeURIComponent(url.pathname.replace(/\/+$/, "").slice(`${base}/connect/`.length));
    } catch {
      return failure("The Connection name is invalid.", 400, "CONNECTION_INVALID");
    }
    const connection = v.safeParse(name, connectionName);
    if (!connection.success) return failure("The Connection name is invalid.", 400, "CONNECTION_INVALID");
    const authorization = await runtime().authorize({
      actor: access.actor,
      name: connection.output,
      redirectUri: `${url.origin}${base}/callback`,
    });
    const secure = url.protocol === "https:" ? "; Secure" : "";
    const headers = new Headers({ "cache-control": "no-store", location: authorization.url });
    headers.append("set-cookie", `${STATE_COOKIE}=${authorization.state}; Path=${base}; HttpOnly; SameSite=Lax; Max-Age=600${secure}`);
    // The callback page returns to the Console page that started the flow.
    headers.append(
      "set-cookie",
      returnTo
        ? `${RETURN_COOKIE}=${encodeURIComponent(returnTo)}; Path=${base}; HttpOnly; SameSite=Lax; Max-Age=600${secure}`
        : `${RETURN_COOKIE}=; Path=${base}; HttpOnly; SameSite=Lax; Max-Age=0`,
    );
    return new Response(null, { headers, status: 302 });
  },
};

const PROVIDER_ERROR = /^[\w.-]{1,64}$/;

const callback: ConnectionsRoute = {
  id: "callback",
  method: "GET",
  matches: (path, base) => path === `${base}/callback`,
  async handle(access, base) {
    const runtime = connectionsRuntimeFor(access);
    const url = new URL(access.request.url);
    const returnTo = requestReturnPath(access.request);
    const failure = (title: string, message: string, status: number, code: string) =>
      page({ code, message, outcome: "error", returnTo, status, title });
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    const providerError = url.searchParams.get("error");
    if (providerError) {
      if (providerError === "access_denied")
        return failure("Connection cancelled", "The provider did not grant access.", 400, "CONNECTION_AUTHORIZATION_CANCELLED");
      // Only a short error code from the provider reaches the page, never its free text.
      const reported = PROVIDER_ERROR.test(providerError) ? ` with ${providerError}` : "";
      return failure("Connection failed", `The provider stopped the authorization${reported}.`, 502, "CONNECTION_PROVIDER");
    }
    // The state must come from a start request in this browser, by the same manager.
    // `complete()` consumes the state and checks the manager that started the flow.
    if (!state || !code || !isViteHubSecretEqual(state, readCookie(access.request, STATE_COOKIE)))
      return failure(
        "Connection failed",
        "The authorization response does not match this browser.",
        400,
        "CONNECTION_STATE_MISMATCH",
      );
    let result: Awaited<ReturnType<ConnectionsRuntime["complete"]>>;
    try {
      result = await runtime().complete({ actor: access.actor, code, state });
    } catch (error) {
      if (!isConnectionError(error)) throw error;
      return failure("Connection failed", error.message, errorStatus(error), error.code);
    }
    const response = page({
      message: `${result.name} is connected${result.account?.email ? ` as ${result.account.email}` : ""}.`,
      outcome: "success",
      returnTo,
      status: 200,
      title: "Connected",
    });
    response.headers.append("set-cookie", `${STATE_COOKIE}=; Path=${base}; HttpOnly; SameSite=Lax; Max-Age=0`);
    response.headers.append("set-cookie", `${RETURN_COOKIE}=; Path=${base}; HttpOnly; SameSite=Lax; Max-Age=0`);
    return response;
  },
};

type ApprovalPage = Awaited<ReturnType<ConnectionsRuntime["approvals"]>>;

function approvalSummary(approval: ApprovalPage["approvals"][number]) {
  const { input: _input, ...summary } = approval;
  return summary;
}

const action: ConnectionsRoute = {
  id: "action",
  method: "POST",
  matches: (path, base) => path === base,
  async handle(access) {
    const runtime = connectionsRuntimeFor(access);
    const { actor, request } = access;
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      return json(
        { error: managementErrorBody("CONNECTION_CONTENT_TYPE_REJECTED", "Connections management accepts only application/json requests.") },
        403,
      );
    }
    const rejected = originRejection(request, new URL(request.url));
    if (rejected) return rejected;
    const parsed = v.safeParse(actionSchema, await readBody(request));
    if (!parsed.success)
      return json(
        { error: managementErrorBody("CONNECTION_INVALID", "Invalid Connections request.") },
        400,
      );
    const input = parsed.output;
    const connections = runtime();
    switch (input.action) {
      case "list":
        return json({ connections: await connections.list() });
      case "inspect":
        return json({ connection: await connections.inspect(input.name) });
      case "authorize":
        return json(
          await connections.authorize({ actor, name: input.name, redirectUri: input.redirectUri }),
        );
      case "complete":
        return json({
          connection: await connections.complete({ actor, code: input.code, state: input.state }),
        });
      case "revoke":
        return json({ connection: await connections.revoke({ actor, name: input.name }) });
      case "set-key":
        return json({
          connection: await connections.setKey({ actor, key: input.key, name: input.name }),
        });
      case "activity":
        return json({ activity: await connections.activity(input) });
      case "approvals":
        return json(await connections.approvals(input));
      case "approval-summaries": {
        const result = await connections.approvals(input);
        return json({ ...result, approvals: result.approvals.map(approvalSummary) });
      }
      case "approval-counts": {
        const counts: Record<string, number> = Object.create(null);
        for (const connection of await connections.list()) {
          let before: string | undefined;
          const seenCursors = new Set<string>();
          const seenApprovalIds = new Set<string>();
          let count = 0;
          let pageCount = 0;
          do {
            const result = await connections.approvals({ name: connection.name, status: "pending", before });
            pageCount++;
            count += result.approvals.length;
            if (result.nextCursor && seenCursors.has(result.nextCursor)) {
              throw new ConnectionError("invalid", "Connections approval pagination did not advance.");
            }
            if (result.nextCursor && pageCount >= MAX_APPROVAL_COUNT_PAGES) {
              throw new ConnectionError("invalid", "Connections approval pagination did not terminate.");
            }
            if (
              result.nextCursor &&
              (result.approvals.length === 0 || result.approvals.every((approval) => seenApprovalIds.has(approval.id)))
            ) {
              throw new ConnectionError("invalid", "Connections approval pagination did not advance.");
            }
            for (const approval of result.approvals) seenApprovalIds.add(approval.id);
            before = result.nextCursor;
            if (before) seenCursors.add(before);
          } while (before);
          counts[connection.name] = count;
        }
        return json({ counts });
      }
      case "approve":
        return json(await connections.approve({ actor, id: input.id }));
      case "deny":
        return json({ approval: await connections.deny({ actor, id: input.id }) });
    }
  },
};

/** Every Connections management route. Each one reads or changes Connection state. */
export const connectionsRoutes: readonly ConnectionsRoute[] = Object.freeze([action, connect, callback]);
