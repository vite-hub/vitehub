import { logFailure } from "@vite-hub/internal/runtime/request-log";
import { getViteHubErrorShape } from "@vite-hub/runtime";

import { isConnectionError } from "./errors.ts";
import { connectionsErrorDiagnostics } from "./error-diagnostics.ts";
import { checkConnectionsAccess } from "./internal/http-access.ts";
import { completeConsoleCallback, connectionsRoutes, errorResponse, errorStatus, json } from "./internal/http-routes.ts";
import { managementErrorBody } from "./internal/http-diagnostics.ts";
import { page, requestReturnPath } from "./internal/http-page.ts";
import { CONNECTIONS_ROUTE } from "./route.ts";
import { getConnectionsRuntime } from "./runtime/state.ts";

import type { ConnectionsAccessPolicy } from "./internal/http-access.ts";
import type { ConnectionsRuntime } from "./runtime.ts";

export { CONNECTIONS_ROUTE };
export type { ConnectionsActor, ConnectionsAccessPolicy } from "./internal/http-access.ts";

/** The Connections management route. Mount it as a Nitro route or call `fetch()` with a Web Request. */
export interface ConnectionsHandler {
  fetch(request: Request): Promise<Response>;
}

export interface ConnectionsHandlerOptions {
  /**
   * Access policy for every route. A function authenticates the request and returns the manager
   * as `user:<id>`, `undefined` to deny it, or a `Response` to deny it with that response. `"development"` allows every request as
   * `user:local`, but only on a development server. The callback of a flow that the Console started needs no policy.
   */
  actor: ConnectionsAccessPolicy;
  basePath?: string;
  runtime?: () => ConnectionsRuntime;
  /** Agent name used to select a function-form `vitehub({ publicUrl })` origin. */
  agentName?: string;
}

function normalizeConnectionsBasePath(value: string | undefined): string {
  if (value !== undefined && typeof value !== "string") {
    throw connectionsErrorDiagnostics.CONNECTIONS_INVALID_CONFIG({ problem: "type" });
  }
  const path = value === undefined ? CONNECTIONS_ROUTE : value.trim();
  if (!path.startsWith("/")) {
    throw connectionsErrorDiagnostics.CONNECTIONS_INVALID_CONFIG({ problem: "slash" });
  }
  if (path.includes("?") || path.includes("#")) {
    throw connectionsErrorDiagnostics.CONNECTIONS_INVALID_CONFIG({ problem: "path" });
  }
  const normalized = path.length > 1 ? path.replace(/\/+$/g, "") : path;
  if (!normalized || normalized === "/") {
    throw connectionsErrorDiagnostics.CONNECTIONS_INVALID_CONFIG({ problem: "segment" });
  }
  return normalized;
}

function logRequestFailure(error: unknown, path: string, request: Request): void {
  logFailure(
    { error, field: "connections", fields: { path }, level: "error", message: "The Connections request failed.", request },
    () => console.error("[vitehub] The Connections request failed.", error),
  );
}

/**
 * Management API for Connections, as a Fetchable: `{ fetch(request) }`. Every route runs the `actor` policy
 * first. A route body reads the Connections runtime only through the access that the policy grants for this request.
 *
 * - `POST /_vitehub/connections` runs one JSON action.
 * - `GET /_vitehub/connections/connect/:name` starts the web authorization flow. An optional
 *   `?return=/path` names a same-origin page, such as the Console, to return to.
 * - `GET /_vitehub/connections/callback` completes it. The OAuth `state` is single-use and bound to
 *   the browser and the manager that started the flow. The result page returns to the `return` page.
 */
export function createConnectionsHandler(options: ConnectionsHandlerOptions): ConnectionsHandler {
  const runtime = () => (options.runtime ?? getConnectionsRuntime)();
  const base = normalizeConnectionsBasePath(options.basePath);
  return {
    async fetch(request) {
      const path = new URL(request.url).pathname.replace(/\/+$/, "");
      try {
        if (path === `${base}/callback`) {
          const completed = await completeConsoleCallback(request, runtime);
          if (completed) return completed;
        }
        const check = await checkConnectionsAccess(options.actor, request, runtime, options.agentName);
        if (check.rejection) return check.rejection;
        const route = connectionsRoutes.find((candidate) => candidate.matches(path, base));
        if (!route)
          return json({ error: managementErrorBody("CONNECTIONS_ROUTE_NOT_FOUND", "Not found.") }, 404);
        if (request.method !== route.method)
          return json({ error: managementErrorBody("CONNECTIONS_METHOD_NOT_ALLOWED", `Use ${route.method}.`) }, 405, {
            allow: route.method,
          });
        return await route.handle(check.access, base);
      } catch (error) {
        const shape = getViteHubErrorShape(error);
        if (!shape && !isConnectionError(error)) logRequestFailure(error, path, request);
        if (request.method === "GET") {
          return page({
            code: isConnectionError(error) ? error.code : shape?.code ?? "CONNECTIONS_REQUEST_FAILED",
            fix: isConnectionError(error) ? error.fix : undefined,
            message: isConnectionError(error) ? error.message : shape?.message ?? "The connection could not be completed.",
            outcome: "error",
            returnTo: requestReturnPath(request),
            status: errorStatus(error),
            title: "Connection failed",
          });
        }
        return errorResponse(error);
      }
    },
  };
}
