import type { ConnectionActor } from "./types.ts"

function isRecord(value: unknown): value is Record<string, unknown> {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- H3 1 and H3 2 events reach this boundary as unknown values.
  return typeof value === "object" && value !== null
}

/** Server actor for code without a request, such as schedules and scripts. */
export const serverConnectionActor: ConnectionActor = { id: "server", kind: "service" }

/**
 * Route actor from an H3 1 or H3 2 event. The id is `"METHOD /pattern"`, for example `"POST /api/labels/:id"`.
 * Without a matched route pattern, the request path is used.
 */
export function routeConnectionActor(event: unknown): ConnectionActor | undefined {
  if (!isRecord(event)) return
  const context = isRecord(event.context) ? event.context : {}
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- H3 1 and H3 2 events reach this boundary as unknown values.
  const matched = isRecord(context.matchedRoute) && typeof context.matchedRoute.route === "string" ? context.matchedRoute.route : undefined
  // H3 2 uses `event.req`. H3 1 uses `event.node.req`.
  const node = isRecord(event.node) && isRecord(event.node.req) ? event.node.req : undefined
  const request = isRecord(event.req) ? event.req : node
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- H3 1 and H3 2 events reach this boundary as unknown values.
  const method = typeof request?.method === "string" ? request.method : typeof event.method === "string" ? event.method : undefined
  let path = matched
  if (!path) {
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- H3 1 and H3 2 events reach this boundary as unknown values.
    const url = event.url instanceof URL ? event.url : typeof request?.url === "string" ? new URL(request.url, "http://localhost") : undefined
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- H3 1 and H3 2 events reach this boundary as unknown values.
    path = url?.pathname ?? (typeof event.path === "string" ? event.path.split("?")[0] : undefined)
  }
  if (!method || !path) return
  return { id: `${method.toUpperCase()} ${path}`, kind: "route" }
}

export function resolveConnectionActor(options: { actor?: ConnectionActor, event?: unknown }): ConnectionActor {
  return options.actor ?? routeConnectionActor(options.event) ?? serverConnectionActor
}
