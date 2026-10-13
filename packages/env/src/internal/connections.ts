import { envAccessAuthority, grantEnvAccess } from "./access.ts";
import { envBridgeError } from "../bridge-error.ts";
import type { EnvAccessContext, EnvActor, EnvBridge } from "../bridge.ts";

/**
 * Internal to `@vite-hub/connections`. Call it only after the Connection access policy allows the call.
 * The context works on one bridge, for one Connection token key and one permission.
 */
export function connectionEnvAccess(
  bridge: EnvBridge,
  input: {
    actor: EnvActor;
    name: string;
    permission: "activity" | "replace" | "use";
    traceId?: string;
    invocationId?: string;
  },
): EnvAccessContext {
  return grantEnvAccess(input, {
    kind: "key",
    bridge,
    key: `connection/${input.name}`,
    permissions: [input.permission],
  });
}

/** Return the actor of a context that Env created. Other values fail with `ENV_BRIDGE_UNTRUSTED`. */
export function envAccessActor(context: EnvAccessContext): EnvActor {
  const authority = envAccessAuthority(context);
  if (authority.kind !== "agent") throw envBridgeError("untrusted");
  return { id: context.actor.id, kind: context.actor.kind };
}
