import * as agentAPI from "@vite-hub/agent";
import { envBridgeError } from "../bridge-error.ts";
import { grantEnvAccess, type EnvAttribution } from "./access.ts";
import type { EnvAccessContext } from "../bridge.ts";

/** Mint only for an identity registered by Agent Definition resolution. Names and copies are untrusted. */
export function agentEnvAccess(agent: unknown, attribution: EnvAttribution = {}): EnvAccessContext {
  const name = agentAPI.readAgentEnvIdentity?.(agent);
  if (name === undefined) throw envBridgeError("untrusted");
  return grantEnvAccess(
    { actor: { kind: "agent", id: name }, traceId: attribution.traceId, invocationId: attribution.invocationId },
    // The Agent runtime registered the parents with the identity. They never come from caller values.
    { kind: "agent", parents: agentAPI.readAgentEnvParents?.(agent) ?? [] },
  );
}
