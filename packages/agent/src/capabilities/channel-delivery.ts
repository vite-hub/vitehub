import { ViteHubError } from "@vite-hub/runtime"

import { capabilityFinishDeliveryEffectSymbol, capabilityFinishDeliveryReminderSymbol, defineCapability } from "../capability-runtime.ts"
import { defineInternalTool } from "./internal.ts"
import { hasRuntimeType, isRuntimeRecord } from "../internal/runtime-type.ts"
import { traceAgentChannelDeliveryEffect } from "../trace.ts"

import type {
  AgentCapabilityDefinition,
  AgentCapabilityRuntimeContext,
  AgentChannelDeliveryFinishEffectCallback,
  AgentInvocationContextStore,
  AgentToolSchema,
  MaybePromise,
} from "../types.ts"

/** The Channel client that `useChannel(name)` returns, or any object with the same `send()` contract. */
export interface ChannelDeliveryClient<TOptions = never> {
  name?: string
  send: (text: string, options: TOptions) => Promise<[error: Error, receipt: null] | [error: null, receipt: { deliveryId: string }]>
}

export interface ChannelDeliveryOptions<TOptions> {
  /** The Channel to send through, for example `useChannel("teams")`. */
  channel: ChannelDeliveryClient<TOptions>
  /** Send options, such as the recipient. They are fixed by the application, not by the model. */
  options: TOptions
  /** Tool name. Defaults to `send_message`. */
  name?: string
  description?: string
  /** Fail the invocation when the Agent finishes without a successful send. Defaults to `false`. */
  required?: boolean
  /**
   * Remind the Agent when it finishes without calling the tool. Requires `required: true`.
   * `true` allows one reminder turn with the default instruction.
   */
  reminder?: boolean | ChannelDeliveryReminderOptions
  /** Maximum send attempts per invocation. Defaults to `1`. Reminder turns do not add send attempts. */
  maxCalls?: number
  /** Build the Channel text from the model's message. */
  format?: (message: string, context: AgentCapabilityRuntimeContext) => MaybePromise<string>
  /** Throw to reject a message. The model receives the error and can retry. A rejected message does not count as a call. */
  validate?: (message: string) => MaybePromise<void>
}

export interface ChannelDeliveryReminderOptions {
  /** Maximum reminder turns per invocation. Defaults to `1`. */
  turns?: number
  /** Reminder text sent to the Agent as a user message. Defaults to an instruction that names the tool. */
  instruction?: string
}

const channelDeliveryInputSchema: AgentToolSchema = {
  additionalProperties: false,
  properties: {
    message: { minLength: 1, type: "string" },
  },
  required: ["message"],
  type: "object",
}

/**
 * Give the Agent one tool that sends a message through a Channel to a recipient that the application selects.
 * Use it when a run must deliver its result somewhere other than the Channel that started it, for example from a Schedule.
 */
export function channelDelivery<TOptions>(options: ChannelDeliveryOptions<TOptions>): AgentCapabilityDefinition {
  const name = options.name ?? "send_message"
  const maxCalls = options.maxCalls ?? 1
  const reminder = options.reminder === true ? {} : options.reminder || undefined
  const reminderTurns = reminder?.turns ?? 1
  if (reminder && options.required !== true) {
    throw new TypeError("[vitehub] channelDelivery({ reminder }) requires required: true.")
  }
  if (reminder && (!Number.isInteger(reminderTurns) || reminderTurns < 1)) {
    throw new TypeError("[vitehub] channelDelivery({ reminder: { turns } }) must be a positive integer.")
  }
  if (reminder?.instruction !== undefined && (!hasRuntimeType(reminder.instruction, "string") || !reminder.instruction.trim())) {
    throw new TypeError("[vitehub] channelDelivery({ reminder: { instruction } }) must be a non-empty string.")
  }
  const reminderInstruction = reminder?.instruction
    ?? `You finished without calling ${name}, so nothing was delivered. Call ${name} now with the completed message. If your previous reply already contains it, send that text. Do not repeat completed work.`
  if (!Number.isInteger(maxCalls) || maxCalls < 1) {
    throw new TypeError("[vitehub] channelDelivery({ maxCalls }) must be a positive integer.")
  }
  if (!isRuntimeRecord(options.channel) || !hasRuntimeType(options.channel.send, "function")) {
    throw new TypeError("[vitehub] channelDelivery({ channel }) requires a Channel client, for example useChannel(\"teams\").")
  }
  const channelName = options.channel.name ? ` "${options.channel.name}"` : ""
  const description = options.description
    ?? `Send one message through Channel${channelName} to a recipient that the application selects.${maxCalls === 1 ? " Call this tool once." : ` You can call this tool at most ${maxCalls} times.`}`
  const states = new WeakMap<AgentInvocationContextStore, { calls: number, reminders: number, sent: number }>()
  const finishEffect: AgentChannelDeliveryFinishEffectCallback = ({ event, context }) => {
    const state = states.get(context)
    if (!Object.hasOwn(event, "error") && !event.invocation.cancelled && !state?.sent) {
      throw new ViteHubError("CHANNEL_DELIVERY_REQUIRED", `[vitehub] The Agent finished without a successful ${name} call.`, { details: { attempts: state?.calls ?? 0, ...(reminder ? { reminders: state?.reminders ?? 0 } : {}), tool: name } })
    }
  }
  return Object.assign(defineCapability({
    id: `channel-delivery.${name}`,
    metadata: { channel: options.channel.name, maxCalls, required: options.required === true, tool: name, ...(reminder ? { reminder: { instruction: reminderInstruction, turns: reminderTurns } } : {}) },
    resolve(context) {
      // Each invocation resolves its own counters.
      const state = { calls: 0, reminders: 0, sent: 0 }
      states.set(context.context, state)
      const checkLimit = () => {
        if (state.calls >= maxCalls) {
          throw new ViteHubError("CHANNEL_DELIVERY_LIMIT", `[vitehub] ${name} was already called ${state.calls} ${state.calls === 1 ? "time" : "times"}. Do not call it again.`, { details: { maxCalls, tool: name } })
        }
      }
      context.tools.add({
        [name]: defineInternalTool({
          description,
          metadata: { vitehubChannelDelivery: true },
          async execute(input) {
            checkLimit()
            const message = isRuntimeRecord(input) && hasRuntimeType(input.message, "string") ? input.message.trim() : ""
            if (!message) throw new TypeError(`[vitehub] ${name} requires a non-empty message.`)
            await options.validate?.(message)
            const text = options.format ? await options.format(message, context) : message
            if (!text.trim()) throw new TypeError(`[vitehub] ${name} requires formatted text to be non-empty.`)
            checkLimit()
            // Count the attempt before sending. A failed send can still have reached the recipient.
            state.calls++
            if (context.input.get().dryRun === true) {
              const runtimeContext = context.runtimeContext
              if (runtimeContext) {
                await traceAgentChannelDeliveryEffect({
                  context: context.context,
                  input: context.input.get(),
                  invoker: context.invoker,
                  run: runtimeContext.run,
                  runtime: runtimeContext,
                }, { kind: "reply", payload: message }, {
                  "channel.effect.channel": options.channel.name,
                  "channel.effect.skipped": "dry-run",
                })
              }
              state.sent++
              return { deliveryId: `dry-run:${crypto.randomUUID()}`, sent: true }
            }
            const [error, receipt] = await options.channel.send(text, options.options)
            if (error) throw error
            state.sent++
            const runtimeContext = context.runtimeContext
            if (runtimeContext) {
              await traceAgentChannelDeliveryEffect({
                context: context.context,
                input: context.input.get(),
                invoker: context.invoker,
                run: runtimeContext.run,
                runtime: runtimeContext,
              }, { kind: "reply", payload: message }, {
                "channel.effect.channel": options.channel.name,
              })
            }
            return { deliveryId: receipt.deliveryId, sent: true }
          },
          inputSchema: channelDeliveryInputSchema,
          name,
        }),
      })
    },
  }), options.required ? { [capabilityFinishDeliveryEffectSymbol]: finishEffect } : {}, reminder ? {
    [capabilityFinishDeliveryReminderSymbol]: {
      capabilityId: `channel-delivery.${name}`,
      tool: name,
      next(context: AgentInvocationContextStore) {
        const state = states.get(context)
        // A failed send may have reached its recipient. Remind only after an omission.
        if (!state || state.calls > 0 || state.reminders >= reminderTurns) return
        state.reminders++
        return { instruction: reminderInstruction, turn: state.reminders, turns: reminderTurns }
      },
    },
  } : {})
}
