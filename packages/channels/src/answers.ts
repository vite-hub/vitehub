import type { ChannelTrigger } from "./types.ts"

/**
 * Answers a webhook that the Channel takes but does not act on, such as an event it does not handle.
 * Answers HTTP 200 with `{ accepted: false, ok: true, reason }`, so the sender does not retry it.
 */
export function ignored(reason: string): Response {
  return Response.json({ accepted: false, ok: true, reason })
}

/**
 * Answers a webhook that the Channel cannot take yet, such as when a dependency is down.
 * Answers HTTP 503 with `{ accepted: false, ok: false, reason }`. The sender retries it, and so does the webhook queue
 * when a queued delivery's trigger returns it on replay.
 */
export function retryLater(reason: string): Response {
  return Response.json({ accepted: false, ok: false, reason }, { status: 503 })
}

/**
 * Refuses a webhook that the Channel will never handle, such as a malformed payload.
 * Answers HTTP 400 with `{ accepted: false, ok: false, reason }`. A queued delivery settles as rejected and is not retried.
 */
export function rejected(reason: string): Response {
  return Response.json({ accepted: false, ok: false, reason }, { status: 400 })
}

/**
 * The typed signatures of `defineChannelTrigger()`. `@vite-hub/agent` adds the ones that type `invoke`, `tasks`, and
 * the trigger context, because the Agent webhook host runs triggers.
 */
export interface ChannelTriggerDefiner {}

/**
 * `defineChannelTrigger()`: the signatures of `ChannelTriggerDefiner` when `@vite-hub/agent` added them, else a plain
 * one. They are never mixed: a plain signature next to the typed ones could win and drop the trigger context type.
 */
export type DefineChannelTrigger = ChannelTriggerDefiner extends (...args: never[]) => unknown
  ? ChannelTriggerDefiner
  : <TTrigger extends ChannelTrigger>(definition: TTrigger) => TTrigger

/**
 * Defines a Channel trigger: the delivery ID, `serialize`, `debounce`, and the task or Agent that runs each
 * delivery. Use it as an `on` target of `defineChannel()`. With `durableState: true`, `invoke` gets the durable
 * trigger context.
 *
 * @example
 * export default defineChannel({
 *   adapter: webhook({ signature: 'bearer', secret: () => useServerEnv().prefect.webhookSecret }),
 *   on: { webhook: defineChannelTrigger({ invoke: (_context, input) => ({ task: 'triage', input }) }) },
 * })
 */
export const defineChannelTrigger: DefineChannelTrigger = definition => definition
