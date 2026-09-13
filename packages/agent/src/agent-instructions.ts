import type { WorkspaceName } from "@vite-hub/workspace"
import { fillInstructionSlot } from "./instruction-composition.ts"
import type { AgentAdapterInstructions, AgentAdapterMetadataContext, AgentInstructionsContent, AgentRuntimeConfig } from "./types.ts"

async function resolveContent<TRuntimeConfig extends AgentRuntimeConfig, Name extends WorkspaceName>(
  input: AgentInstructionsContent<TRuntimeConfig, Name> | undefined,
  context: AgentAdapterMetadataContext<TRuntimeConfig, Name>,
): Promise<string> {
  const parts = Array.isArray(input) ? input : [input]
  const resolved = await Promise.all(parts.map(part => typeof part === "function" ? part(context) : part))
  return resolved.flatMap(part => Array.isArray(part) ? part : [part]).map(part => part?.trim()).filter(Boolean).join("\n\n")
}

/** Resolve one document before provider-specific instruction composition. */
export async function resolveAgentInstructions<TRuntimeConfig extends AgentRuntimeConfig, Name extends WorkspaceName>(
  input: AgentAdapterInstructions<TRuntimeConfig, Name> | undefined,
  context: AgentAdapterMetadataContext<TRuntimeConfig, Name>,
): Promise<string> {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    if ("mode" in input) return await resolveContent(input.value, context)
    const template = await resolveContent(input.template, context)
    const content = await resolveContent(input.content, context)
    return await fillInstructionSlot(template, content)
  }
  return await resolveContent(input, context)
}

/** Unresolved sources for synchronous inspection and dynamic resolver detection. */
export function agentInstructionSources<TRuntimeConfig extends AgentRuntimeConfig, Name extends WorkspaceName>(
  input: AgentAdapterInstructions<TRuntimeConfig, Name> | undefined,
) {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return ("mode" in input ? [input.value] : [input.template, input.content]).flat(2)
  }
  return [input].flat(2)
}
