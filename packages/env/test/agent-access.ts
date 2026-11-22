import { createAgentEnvIdentity } from "../../agent/src/internal/env-identity.ts";
import { agentEnvAccess as mint } from "../src/internal/agent.ts";

export function agentEnvAccess(agent: { name: string }, attribution = {}, parents: readonly string[] = []) {
  return mint(createAgentEnvIdentity(agent, agent.name, parents), attribution);
}
