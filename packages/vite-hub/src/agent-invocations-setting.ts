import type { AgentInvocationsDefault, AgentInvocationsDefaultJournal } from "@vite-hub/agent"

/** True for an omitted `agent.invocations` or the default journal options. Build code reads it without loading the Agent package. */
export function isDefaultAgentJournal(setting: AgentInvocationsDefault | undefined): setting is AgentInvocationsDefaultJournal | undefined {
  return setting === undefined || (typeof setting === "object" && setting.store === undefined)
}
