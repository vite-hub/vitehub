import * as v from "valibot";

import { isViteHubSecretEqual } from "@vite-hub/internal/secret";

import { isConnectionError } from "../errors.ts";
import { CONNECTION_NAME_MAX_LENGTH } from "../types.ts";
import { connectionsRuntimeFor } from "./http-access.ts";

import type { ConnectionsRuntime } from "../runtime.ts";
import type { ConnectionsAccess } from "./http-access.ts";

const MAX_BODY_BYTES = 64 * 1024;
const STATE_COOKIE = "vitehub_connection_state";

// Discovery preserves filesystem-valid characters, including symbols such as `+`.
// Keep management validation in step with the generated registry.
const name = v.pipe(v.string(), v.minLength(1), v.maxLength(CONNECTION_NAME_MAX_LENGTH));
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
  if (isConnectionError(error)) {
    const body: { code: string; message: string; requestId?: string } = {
      code: error.code,
      message: error.message,
    };
    if (error.requestId) body.requestId = error.requestId;
    return json({ error: body }, errorStatus(error));
  }
  return json(
    { error: { code: "CONNECTION_FAILED", message: "The Connections request failed." } },
    500,
  );
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

export function page(title: string, message: string, status: number): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><body style="font-family:system-ui;margin:4rem auto;max-width:32rem"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body>`,
    {
      headers: {
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
        "content-type": "text/html; charset=utf-8",
      },
      status,
    },
  );
}

function cookie(request: Request, key: string): string | undefined {
  for (const part of request.headers.get("cookie")?.split(";") ?? []) {
    const [cookieName, ...value] = part.trim().split("=");
    if (cookieName === key) return value.join("=");
  }
  return undefined;
}

function sameOrigin(request: Request, url: URL): boolean {
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) return false;
  return request.headers.get("sec-fetch-site") !== "cross-site";
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
    // A foreign page must not start a flow in the name of the signed-in manager.
    if (request.headers.get("sec-fetch-site") === "cross-site")
      return page("Connection failed", "Start the connection from this application.", 403);
    let connectionName: string;
    try {
      connectionName = decodeURIComponent(url.pathname.replace(/\/+$/, "").slice(`${base}/connect/`.length));
    } catch {
      return page("Connection failed", "The Connection name is invalid.", 400);
    }
    const connection = v.safeParse(name, connectionName);
    if (!connection.success) return page("Connection failed", "The Connection name is invalid.", 400);
    const authorization = await runtime().authorize({
      actor: access.actor,
      name: connection.output,
      redirectUri: `${url.origin}${base}/callback`,
    });
    return new Response(null, {
      headers: {
        "cache-control": "no-store",
        location: authorization.url,
        "set-cookie": `${STATE_COOKIE}=${authorization.state}; Path=${base}; HttpOnly; SameSite=Lax; Max-Age=600${url.protocol === "https:" ? "; Secure" : ""}`,
      },
      status: 302,
    });
  },
};

const callback: ConnectionsRoute = {
  id: "callback",
  method: "GET",
  matches: (path, base) => path === `${base}/callback`,
  async handle(access, base) {
    const runtime = connectionsRuntimeFor(access);
    const url = new URL(access.request.url);
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    if (url.searchParams.get("error"))
      return page("Connection cancelled", "The provider did not grant access.", 400);
    // The state must come from a start request in this browser, by the same manager.
    // `complete()` consumes the state and checks the manager that started the flow.
    if (!state || !code || !isViteHubSecretEqual(state, cookie(access.request, STATE_COOKIE)))
      return page(
        "Connection failed",
        "The authorization response does not match this browser. Start the connection again.",
        400,
      );
    const result = await runtime().complete({ actor: access.actor, code, state });
    const response = page(
      "Connected",
      `Connection "${result.name}" is connected${result.account?.email ? ` as ${result.account.email}` : ""}. You can close this tab.`,
      200,
    );
    response.headers.append("set-cookie", `${STATE_COOKIE}=; Path=${base}; HttpOnly; SameSite=Lax; Max-Age=0`);
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
    if (
      !request.headers.get("content-type")?.toLowerCase().startsWith("application/json") ||
      !sameOrigin(request, new URL(request.url))
    ) {
      return json(
        {
          error: {
            code: "CONNECTION_FORBIDDEN",
            message: "Cross-origin or non-JSON requests are not allowed.",
          },
        },
        403,
      );
    }
    const parsed = v.safeParse(actionSchema, await readBody(request));
    if (!parsed.success)
      return json(
        { error: { code: "CONNECTION_INVALID", message: "Invalid Connections request." } },
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
        const counts: Record<string, number> = {};
        for (const connection of await connections.list()) {
          let before: string | undefined;
          let count = 0;
          do {
            const result = await connections.approvals({ name: connection.name, status: "pending", before });
            count += result.approvals.length;
            before = result.nextCursor;
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
