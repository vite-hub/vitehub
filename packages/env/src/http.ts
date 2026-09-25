import { envBridgeError, sanitizeEnvBridgeError } from "./bridge-error.ts";
import type { EnvAccessContext, EnvActor, EnvBridge, EnvPermission } from "./bridge.ts";

export interface EnvManagement {
  bridge: EnvBridge;
  authenticate(request: Request): EnvAccessContext | null | Promise<EnvAccessContext | null>;
}
export type EnvManagementResolver = (
  path: string,
) => { key: string; management: EnvManagement } | undefined;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function actor(value: unknown): EnvActor {
  if (
    !record(value) ||
    typeof value.id !== "string" ||
    !["user", "agent", "service"].includes(String(value.kind))
  )
    throw envBridgeError("invalid");
  return { id: value.id, kind: value.kind as EnvActor["kind"] };
}
const permissions: readonly EnvPermission[] = ["inspect", "preview", "replace", "use"];
async function body(request: Request): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader) throw envBridgeError("invalid");
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 65_536) {
        await reader.cancel();
        throw envBridgeError("invalid");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    const value: unknown = JSON.parse(text + decoder.decode());
    if (!record(value)) throw envBridgeError("invalid");
    return value;
  } catch {
    throw envBridgeError("invalid");
  } finally {
    reader.releaseLock();
  }
}
function response(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

/** Mount only on a server route. resolve selects declared credentials, never arbitrary store keys. */
export function createEnvBridgeHandler(
  resolve: EnvManagementResolver,
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== "POST") return response({ message: "Method not allowed." }, 405);
    const origin = request.headers.get("origin");
    if (
      origin
        ? origin !== new URL(request.url).origin
        : !/^Bearer\s+\S+$/i.test(request.headers.get("authorization") ?? "")
    )
      return response({ message: "Request origin is not allowed." }, 403);
    try {
      const input = await body(request);
      if (typeof input.path !== "string" || input.path.length > 256)
        throw envBridgeError("invalid");
      const target = resolve(input.path);
      if (!target) return response({ message: "This variable is not managed." }, 404);
      const context = await target.management.authenticate(request);
      if (!context) return response({ message: "Authentication required." }, 401);
      const { bridge } = target.management;
      const key = target.key;
      switch (input.action) {
        case "inspect":
          return response({
            metadata: (await bridge.inspect(context, key)) ?? null,
            permissions: await bridge.permissions(context, key),
            admin: Boolean(context.admin && !context.scope),
          });
        case "preview":
          return response({ metadata: (await bridge.preview(context, key)) ?? null });
        case "replace": {
          if (
            typeof input.value !== "string" ||
            !(input.expectedRevision === null || typeof input.expectedRevision === "string")
          )
            throw envBridgeError("invalid");
          const result = await bridge.replace(context, {
            key,
            value: input.value,
            expectedRevision: input.expectedRevision,
          });
          return response({
            revision: result.revision,
            updatedAt: result.updatedAt,
            activation: result.activation,
          });
        }
        case "activity": {
          if (input.before !== undefined && typeof input.before !== "string")
            throw envBridgeError("invalid");
          return response({ events: await bridge.activity(context, key, input.before) });
        }
        case "grants":
          return response({ grants: await bridge.grants(context, key) });
        case "grant": {
          if (
            !Array.isArray(input.permissions) ||
            input.permissions.some((value) => !permissions.includes(value))
          )
            throw envBridgeError("invalid");
          await bridge.grant(context, {
            actor: actor(input.actor),
            key,
            permissions: input.permissions,
          });
          return response({ ok: true });
        }
        case "revoke":
          await bridge.revoke(context, actor(input.actor), key);
          return response({ ok: true });
        default:
          throw envBridgeError("invalid");
      }
    } catch (error) {
      const safe = sanitizeEnvBridgeError(error);
      const status =
        safe.code === "ENV_BRIDGE_DENIED"
          ? 403
          : safe.code === "ENV_BRIDGE_CONFLICT"
            ? 409
            : safe.code === "ENV_BRIDGE_INVALID"
              ? 400
              : 503;
      return response({ code: safe.code, message: safe.message }, status);
    }
  };
}
