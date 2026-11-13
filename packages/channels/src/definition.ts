import type { ChannelAdapter, ChannelDefinition, ChannelDefinitionOptions } from "./types.ts"
import { channelDefinitionBrand } from "./brand.ts"
import { channelsErrorDiagnostics } from "./error-diagnostics.ts"

function isObject(value: unknown): value is Record<PropertyKey, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** Whether `value` came from `defineChannel()`. */
export function isChannelDefinition(value: unknown): value is ChannelDefinition {
  return isObject(value) && value[channelDefinitionBrand] === true
}

/** Whether the adapter receives webhooks from an HTTP sender, such as `webhook()` or `stripe()`. */
export function isWebhookChannelAdapter(adapter: unknown): adapter is ChannelAdapter & { webhook: Record<string, unknown> } {
  return isObject(adapter) && isObject(adapter.webhook)
}

export function validateChannelDefinition(value: unknown): asserts value is ChannelDefinitionOptions {
  if (!isObject(value)) {
    throw channelsErrorDiagnostics.CHANNELS_C0001({ message: "`defineChannel()` expects an object with an `adapter`." })
  }
  const adapter = value.adapter
  if (!isObject(adapter) || typeof adapter.kind !== "string" || !adapter.kind.trim()) {
    throw channelsErrorDiagnostics.CHANNELS_C0007({ message: "`defineChannel()` needs an `adapter` with a non-empty `kind`, such as `stripe()`, `webhook()`, `slack()` from `vite-hub/agent/channels`, or `{ kind, send }`." })
  }
  if (adapter.send !== undefined && typeof adapter.send !== "function") {
    throw channelsErrorDiagnostics.CHANNELS_C0008({ message: `The "${adapter.kind}" adapter \`send\` must be a function.` })
  }
  if (value.on === undefined) return
  if (!isObject(value.on)) {
    throw channelsErrorDiagnostics.CHANNELS_C0009({ message: "`defineChannel({ on })` expects an object of targets by event name." })
  }
  for (const [name, target] of Object.entries(value.on)) {
    if (!name.trim()) {
      throw channelsErrorDiagnostics.CHANNELS_C0009({ message: "`defineChannel({ on })` event names must be non-empty." })
    }
    if (typeof target === "function") {
      if (!isWebhookChannelAdapter(adapter)) {
        throw channelsErrorDiagnostics.CHANNELS_C0010({ message: `The \`on\` handler "${name}" needs an adapter that receives webhooks, such as \`webhook()\` or \`stripe()\`. The "${adapter.kind}" adapter sends its messages to the Agent that lists the Channel. Use \`defineChannelTrigger()\` for a custom trigger.` })
      }
      continue
    }
    if (!isObject(target) || typeof target.invoke !== "function") {
      throw channelsErrorDiagnostics.CHANNELS_C0009({ message: `The \`on\` target "${name}" must be a function or a trigger from \`defineChannelTrigger()\`.` })
    }
  }
}

/**
 * Defines a Channel: one connection to a platform, in both directions. Put it in `server/channels/<name>.ts`.
 * Inbound events go to the targets in `on`, or to the Agent that lists the Channel. `useChannel(name).send()` sends
 * through the adapter.
 *
 * @example
 * export default defineChannel({
 *   adapter: stripe(),
 *   on: { 'checkout.session.completed': event => sendQueue('fulfil', event.data) },
 * })
 */
export function defineChannel<TAdapter extends ChannelAdapter<never, never>>(
  definition: ChannelDefinitionOptions<TAdapter>,
): ChannelDefinition<TAdapter> {
  validateChannelDefinition(definition)
  return Object.defineProperty({ ...definition }, channelDefinitionBrand, { value: true }) as ChannelDefinition<TAdapter>
}
