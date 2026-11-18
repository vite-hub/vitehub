import type { PrepareStepFunction, PrepareStepResult, ToolSet, UserModelMessage } from "ai"

import type { AgentInvocationControlOutcome } from "../agent-invocation.ts"
import { getMessageText, isAttachmentPart } from "../messages.ts"
import type { AgentRunInput } from "../types.ts"
import { registerAgentInvocationInputHandler } from "./agent-invocation-control.ts"
import { chatContextModelText } from "./chat-message-header.ts"

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

/** Why a Driver cannot add input to an active turn as text. */
export type AgentSteeringInputIssue =
  /** The input has an image, audio or file part. Drivers steer with text only. */
  | "attachments"
  /** The input has no user text, for example only a chat message header. */
  | "empty"
  /** The input has a part that is neither text, chat context, nor an attachment. */
  | "unsupported-parts"

/**
 * Reads steering input as the text that a Driver adds to the active turn. Chat context parts, such as
 * the sender header of a group chat message, become their model text, each on its own line before the
 * message text, as in the first prompt.
 */
export function agentSteeringInput(input: AgentRunInput): { text: string } | { issue: AgentSteeringInputIssue } {
  const messages = input.messages ?? (Array.isArray(input.prompt) ? input.prompt : input.message && typeof input.message !== "string" ? [input.message] : [])
  const parts = messages.flatMap(message => Array.isArray(message.parts) ? message.parts : [undefined])
  if (parts.some(part => part && isAttachmentPart(part))) return { issue: "attachments" }
  if (parts.some(part => !part || (part.type !== "text" && chatContextModelText(part) === undefined))) return { issue: "unsupported-parts" }
  if (typeof input.prompt === "string") return input.prompt.trim() ? { text: input.prompt } : { issue: "empty" }
  if (typeof input.message === "string") return input.message.trim() ? { text: input.message } : { issue: "empty" }
  if (!messages.some(message => getMessageText(message).trim())) return { issue: "empty" }
  return {
    text: messages.map(message => [
      ...message.parts.map(part => part.type === "text" ? undefined : chatContextModelText(part)),
      getMessageText(message),
    ].filter(Boolean).join("\n")).join("\n\n"),
  }
}

/**
 * Lets a running model loop take steering input. A step that starts after the input arrives sends it
 * to the model as a user message, and the caller learns it was accepted only then.
 */
export function openModelSteering(invocationId: string): ModelSteering {
  const pending: PendingSteering[] = []
  // AI SDK 7 carries a `messages` override into later steps. AI SDK 6 does not, so steered
  // messages that a later step lacks go back in at the place where the model first read them.
  const injected: Array<{ index: number, message: UserModelMessage }> = []
  let closed = false
  const unregister = registerAgentInvocationInputHandler(invocationId, {
    sendInput(input, options) {
      if (options.mode !== "steer") return "unsupported"
      const steering = agentSteeringInput(input)
      if ("issue" in steering) return { outcome: "unsupported", reason: steering.issue }
      const text = steering.text.trim()
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
        let nextIndex = 0
        for (const entry of injected) {
          // Callers can clone messages or normalize string content into text parts. Match
          // each submission once, in order, without mistaking an earlier user prompt for it.
          const index = messages.findIndex((message, index) => index >= Math.max(nextIndex, entry.index)
            && message.role === "user"
            && (typeof message.content === "string"
              ? message.content
              : message.content.map(part => part.type === "text" ? part.text : "").join("")) === entry.message.content)
          if (index >= 0) {
            nextIndex = index + 1
          }
          else {
            if (messages === options.messages) messages = [...messages]
            messages.splice(entry.index, 0, entry.message)
            nextIndex = entry.index + 1
          }
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
