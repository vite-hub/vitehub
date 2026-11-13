import type { WorkspaceName } from "@vite-hub/workspace"
import { fillInstructionSlot } from "./instruction-composition.ts"
import type { AgentAdapterInstructions, AgentAdapterMetadataContext, AgentInstructionsContent, AgentRuntimeConfig } from "./types.ts"

async function resolveContent<TRuntimeConfig extends AgentRuntimeConfig, Name extends WorkspaceName>(
  input: AgentInstructionsContent<TRuntimeConfig, Name> | undefined,
  context: AgentAdapterMetadataContext<TRuntimeConfig, Name>,
  preserveWhitespace = false,
): Promise<string> {
  const inputParts = Array.isArray(input) ? input : [input]
  const resolved = await Promise.all(inputParts.map(part => typeof part === "function" ? part(context) : part))
  const parts = resolved.flatMap(part => Array.isArray(part) ? part : [part]).filter((part): part is string => typeof part === "string")
  return preserveWhitespace ? parts.join("\n\n") : joinInstructionParts(parts)
}

/** Join instruction parts into one document, as the Driver receives them. */
export function joinInstructionParts(parts: readonly string[]): string {
  return parts.map(part => part.trim()).filter(Boolean).join("\n\n")
}

/** Resolve one document before provider-specific instruction composition. */
export async function resolveAgentInstructions<TRuntimeConfig extends AgentRuntimeConfig, Name extends WorkspaceName>(
  input: AgentAdapterInstructions<TRuntimeConfig, Name> | undefined,
  context: AgentAdapterMetadataContext<TRuntimeConfig, Name>,
): Promise<string> {
  if (input && typeof input === "object" && !Array.isArray(input) && "extend" in input) {
    // Without a parent layer, an extension receives an empty document.
    return await resolveContent(input.extend(""), context)
  }
  if (input && typeof input === "object" && !Array.isArray(input) && ("mode" in input || "template" in input)) {
    if ("mode" in input) {
      // SAFETY: mode discriminant identifies replacement instructions.
      const replacement = input as Extract<AgentAdapterInstructions<TRuntimeConfig, Name>, { mode: "replace" }>
      return await resolveContent(replacement.value, context)
    }
    // SAFETY: template discriminant identifies composed instructions.
    const composed = input as Extract<AgentAdapterInstructions<TRuntimeConfig, Name>, { template: unknown }>
    const template = await resolveContent(composed.template, context, true)
    const content = await resolveContent(composed.content, context)
    return await fillInstructionSlot(template, content)
  }
  return await resolveContent(input, context)
}

/** Unresolved sources for synchronous inspection and dynamic resolver detection. */
export function agentInstructionSources<TRuntimeConfig extends AgentRuntimeConfig, Name extends WorkspaceName>(
  input: AgentAdapterInstructions<TRuntimeConfig, Name> | undefined,
) {
  if (input && typeof input === "object" && !Array.isArray(input) && "extend" in input) return [input.extend]
  if (input && typeof input === "object" && !Array.isArray(input) && ("mode" in input || "template" in input)) {
    if ("mode" in input) {
      // SAFETY: the mode discriminant identifies the replacement instruction form.
      const replacement = input as Extract<AgentAdapterInstructions<TRuntimeConfig, Name>, { mode: "replace" }>
      return [replacement.value].flat(2)
    }
    // SAFETY: the remaining template discriminant identifies composed instructions.
    const composed = input as Extract<AgentAdapterInstructions<TRuntimeConfig, Name>, { template: unknown }>
    return [composed.template, composed.content].flat(2)
  }
  return [input].flat(2)
}
