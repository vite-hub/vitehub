import type { Result } from "@vite-hub/runtime"

import type { ChannelDefinitionName } from "./registry-types.ts"
import { channelErrors } from "./error-diagnostics.ts"

/** What `sendChannelTrigger()` returns on success. */
export interface ChannelTriggerReceipt {
  /** The delivery ID that the trigger chose. A second send with the same ID is a duplicate. */
  deliveryId: string
  /** False when the queue already had the delivery, or when the trigger answered without one, such as `ignored()`. */
  queued: boolean
}

/** Codes of the errors that `sendChannelTrigger()` returns. */
export type ChannelTriggerErrorCode = "CHANNEL_TRIGGER_FAILED"

type TriggerDispatcher = (channel: string, trigger: string, input: unknown) => Promise<ChannelTriggerReceipt>

const triggerDispatcherKey = Symbol.for("vitehub.channels.triggerDispatcher")

/**
 * Starts a trigger of a Channel from server code, such as a Schedule, without a webhook request. The trigger's
 * `invoke` gets `input` as it gets a verified webhook body, and ViteHub admits the result to the webhook queue with
 * the same delivery ID, `serialize`, `debounce`, and Channel State rules. `trigger` is the name of a trigger, or of an
 * `on` handler. Call it from the persistent server that hosts the Channel, with SQLite or libSQL Agent State.
 *
 * @example
 * const [error] = await sendChannelTrigger('airtable', 'webhook', notification)
 */
export async function sendChannelTrigger(
  channel: ChannelDefinitionName | (string & {}),
  trigger: string,
  input: unknown,
): Promise<Result<ChannelTriggerReceipt, ChannelTriggerErrorCode>> {
  const dispatch = (globalThis as typeof globalThis & { [triggerDispatcherKey]?: TriggerDispatcher })[triggerDispatcherKey]
  if (!dispatch) {
    return [channelErrors.CHANNEL_TRIGGER_FAILED({ channel, trigger, cause: new Error("No Agent webhook queue runs in this process.") }), undefined]
  }
  try {
    return [undefined, await dispatch(channel, trigger, input)]
  }
  catch (cause) {
    return [channelErrors.CHANNEL_TRIGGER_FAILED({ cause, channel, trigger }), undefined]
  }
}
