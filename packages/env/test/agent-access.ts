import { createAgentEnvIdentity } from "../../agent/src/internal/env-identity.ts";
import { agentEnvAccess as mint } from "../src/internal/agent.ts";

/** Mint an Agent context in tests. `parents` stands in for the registered Agents that the Agent runtime resolves from `extends`. */
export function agentEnvAccess(agent: { name: string }, attribution = {}, parents: readonly string[] = []) {
  return mint(createAgentEnvIdentity(agent, agent.name, parents), attribution);
}
