import type { ModelMessage, PrepareStepFunction, PrepareStepResult, ToolSet, UserModelMessage } from "ai"

import type { AgentInvocationControlOutcome } from "../agent-invocation.ts"
import { getMessageText } from "../messages.ts"
import type { AgentRunInput } from "../types.ts"
import { registerAgentInvocationInputHandler } from "./agent-invocation-control.ts"

interface PendingSteering {
  message: UserModelMessage
  settle: (outcome: AgentInvocationControlOutcome) => void
}

export interface ModelSteering {
  /** Ends steering for this Invocation. Input that no step has read yet is reported as unavailable. */
  close: () => void
  /** Wraps the caller's `prepareStep` so each model step first reads the steering that arrived since the last one. */
  prepareStep: (prepareStep: unknown) => PrepareStepFunction<ToolSet>
}

/** Reads the text of steering input. Returns `undefined` when the input has a non-text part. */
export function agentSteeringText(input: AgentRunInput): string | undefined {
  const messages = input.messages ?? (Array.isArray(input.prompt) ? input.prompt : input.message && typeof input.message !== "string" ? [input.message] : [])
  if (messages.some(message => !Array.isArray(message.parts) || message.parts.some(part => part.type !== "text"))) return undefined
  if (typeof input.prompt === "string") return input.prompt
  if (typeof input.message === "string") return input.message
  return messages.map(getMessageText).filter((value): value is string => typeof value === "string").join("\n\n")
}

/**
 * Lets a running model loop take steering input. A step that starts after the input arrives sends it
 * to the model as a user message, and the caller learns it was accepted only then.
 */
export function openModelSteering(invocationId: string): ModelSteering {
  const pending: PendingSteering[] = []
  // AI SDK 7 carries a `messages` override into later steps. AI SDK 6 does not, so steered
  // messages that a later step lacks go back in at the place where the model first read them.
  const injected: Array<{ index: number, message: ModelMessage }> = []
  let closed = false
  const unregister = registerAgentInvocationInputHandler(invocationId, {
    sendInput(input, options) {
      if (options.mode !== "steer") return "unsupported"
      const text = agentSteeringText(input)?.trim()
      if (!text) return "unsupported"
      if (closed) return "unavailable"
      return new Promise<AgentInvocationControlOutcome>((settle) => {
        pending.push({ message: { content: text, role: "user" }, settle })
      })
    },
    get support() { return { steer: !closed } },
  })
  return {
    close() {
      if (closed) return
      closed = true
      unregister()
      for (const entry of pending.splice(0)) entry.settle("unavailable")
    },
    prepareStep(prepareStep) {
      return async (options) => {
        let messages = options.messages
        const missing = injected.filter(entry => !messages.includes(entry.message))
        if (missing.length) {
          messages = [...messages]
          for (const entry of missing) messages.splice(entry.index, 0, entry.message)
        }
        const arrived = closed ? [] : pending.splice(0)
        for (const entry of arrived) {
          if (messages === options.messages) messages = [...messages]
          injected.push({ index: messages.length, message: entry.message })
          messages.push(entry.message)
        }
        let result: PrepareStepResult<ToolSet>
        try {
          result = typeof prepareStep === "function"
            // SAFETY: Agent call settings pass the caller's AI SDK prepareStep through unchanged.
            ? await (prepareStep as PrepareStepFunction<ToolSet>)({ ...options, messages })
            : undefined
        }
        catch (error) {
          for (const entry of arrived) entry.settle("unavailable")
          throw error
        }
        for (const entry of arrived) entry.settle("accepted")
        if (messages === options.messages) return result
        return { ...result, messages: result?.messages ?? messages }
      }
    },
  }
}
