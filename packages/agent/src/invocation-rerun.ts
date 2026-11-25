import { AGENT_INVOCATION_OBSERVATION_TRUNCATED_ATTRIBUTE } from "./internal/invocation-observation-stream.ts"
import { AGENT_INVOCATION_INPUT_REDACTED_ATTRIBUTE, INVOKER_PROFILE_TRUNCATED_ATTRIBUTE, PROMPT_TRUNCATED_ATTRIBUTE, terminalStatus } from "./invocations.ts"

import type { AgentInvocationRecord, AgentInvocationRerunInput } from "./invocations.ts"

/**
 * Reads the complete prompt and invoker that the journal captured when the Invocation started.
 * A caller can start a new Invocation with this input. The original record does not change.
 */
export function agentInvocationRerunInput(record: Pick<AgentInvocationRecord, "observations"> & Partial<Pick<AgentInvocationRecord, "status">>): AgentInvocationRerunInput {
  if (record.status !== undefined && !terminalStatus(record.status)) {
    return { available: false, reason: "invocation-not-terminal" }
  }
  const start = record.observations.find(observation => observation.name === "agent.invocation.start")
  const attributes = start?.attributes
  if (!attributes) return { available: false, reason: "input-not-captured" }
  if (attributes[AGENT_INVOCATION_INPUT_REDACTED_ATTRIBUTE] === true) return { available: false, reason: "input-redacted" }
  if (attributes[INVOKER_PROFILE_TRUNCATED_ATTRIBUTE] === true || attributes[PROMPT_TRUNCATED_ATTRIBUTE] === true
    || (attributes[PROMPT_TRUNCATED_ATTRIBUTE] === undefined && attributes[AGENT_INVOCATION_OBSERVATION_TRUNCATED_ATTRIBUTE] === true)) return { available: false, reason: "input-truncated" }
  if (attributes["input.hasData"] === true) return { available: false, reason: "input-has-data" }
  if (attributes["input.hasOptions"] === true) return { available: false, reason: "input-has-options" }
  if (attributes["input.hasMessages"] === true || attributes["input.messages"] !== undefined) return { available: false, reason: "input-has-messages" }
  const prompt = attributes["input.prompt"]
  if (typeof prompt !== "string" || !prompt.trim()) return { available: false, reason: "input-not-captured" }
  if (attributes["input.replay.version"] !== 5 || ["input.promptChanged", "input.hasInvoker", "input.hasResolvedInvoker", "input.hasData", "input.hasOptions", "input.hasMessages", "input.hasContext", "input.hasRunMetadata", "input.hasTimeout", "input.hasAbortSignal", "input.hasDryRun"]
    .some(key => typeof attributes[key] !== "boolean")) return { available: false, reason: "replay-metadata-unavailable" }
  if (attributes["input.promptChanged"] === true) return { available: false, reason: "input-prompt-changed" }
  if (attributes["input.hasInvoker"] === true) return { available: false, reason: "input-has-invoker" }
  if (attributes["input.hasResolvedInvoker"] === true) return { available: false, reason: "input-has-invoker" }
  if (attributes["input.hasContext"] === true) return { available: false, reason: "input-has-context" }
  if (attributes["input.hasAbortSignal"] === true) return { available: false, reason: "input-has-abort-signal" }
  if (attributes["input.hasRunMetadata"] === true) return { available: false, reason: "input-has-run-metadata" }
  if (attributes["input.hasTimeout"] === true) return { available: false, reason: "input-has-timeout" }
  if (attributes["input.hasDryRun"] === true) return { available: false, reason: "input-has-dry-run" }
  const invokerProfileId = attributes["agent.invoker.profile.id"]
  return { available: true, ...typeof invokerProfileId === "string" && invokerProfileId ? { invokerProfileId } : {}, prompt }
}
