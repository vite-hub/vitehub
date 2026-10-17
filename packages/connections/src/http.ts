import { ConnectionError, isConnectionError } from "./errors.ts";
import { checkConnectionsAccess } from "./internal/http-access.ts";
import { connectionsRoutes, errorResponse, errorStatus, json, page } from "./internal/http-routes.ts";
import { managementErrorBody } from "./internal/http-diagnostics.ts";
import { CONNECTIONS_ROUTE } from "./route.ts";
import { getConnectionsRuntime } from "./runtime/state.ts";

import type { ConnectionsAccessPolicy } from "./internal/http-access.ts";
import type { ConnectionsRuntime } from "./runtime.ts";

export { CONNECTIONS_ROUTE };
export type { ConnectionsActor, ConnectionsAccessPolicy } from "./internal/http-access.ts";

export interface ConnectionsHandlerOptions {
  /**
   * Access policy for every route. A function authenticates the request and returns the manager
   * as `user:<id>`, `undefined` to deny it, or a `Response` to deny it with that response. `"development"` allows every request as
   * `user:local`, but only on a development server.
   */
  actor: ConnectionsAccessPolicy;
  basePath?: string;
  runtime?: () => ConnectionsRuntime;
}

function normalizeConnectionsBasePath(value: string | undefined): string {
  if (value !== undefined && typeof value !== "string") {
    throw new ConnectionError("invalid", "Connections basePath must be a string.");
  }
  const path = value === undefined ? CONNECTIONS_ROUTE : value.trim();
  if (!path.startsWith("/")) {
    throw new ConnectionError("invalid", "Connections basePath must start with `/`.");
  }
  if (path.includes("?") || path.includes("#")) {
    throw new ConnectionError("invalid", "Connections basePath must be a pathname without a query or fragment.");
  }
  const normalized = path.length > 1 ? path.replace(/\/+$/g, "") : path;
  if (!normalized || normalized === "/") {
    throw new ConnectionError("invalid", "Connections basePath must include a route segment.");
  }
  return normalized;
}

/**
 * Management API for Connections. Every route runs the `actor` policy first. A route body reads
 * the Connections runtime only through the access that the policy grants for this request.
 *
 * - `POST /_vitehub/connections` runs one JSON action.
 * - `GET /_vitehub/connections/connect/:name` starts the web authorization flow.
 * - `GET /_vitehub/connections/callback` completes it. The OAuth `state` is single-use and bound to
 *   the browser and the manager that started the flow.
 */
export function createConnectionsHandler(
  options: ConnectionsHandlerOptions,
): (request: Request, event?: unknown) => Promise<Response> {
  const runtime = () => (options.runtime ?? getConnectionsRuntime)();
  const base = normalizeConnectionsBasePath(options.basePath);
  return async (request, event) => {
    const path = new URL(request.url).pathname.replace(/\/+$/, "");
    try {
      const check = await checkConnectionsAccess(options.actor, request, event, runtime);
      if (check.rejection) return check.rejection;
      const route = connectionsRoutes.find((candidate) => candidate.matches(path, base));
      if (!route)
        return json({ error: managementErrorBody("CONNECTION_NOT_FOUND", "Not found.") }, 404);
      if (request.method !== route.method)
        return json({ error: managementErrorBody("CONNECTION_METHOD", `Use ${route.method}.`) }, 405, {
          allow: route.method,
        });
      return await route.handle(check.access, base);
    } catch (error) {
      if (request.method === "GET") {
        return page(
          "Connection failed",
          isConnectionError(error) ? error.message : "The connection could not be completed.",
          errorStatus(error),
        );
      }
      return errorResponse(error);
    }
  };
}
