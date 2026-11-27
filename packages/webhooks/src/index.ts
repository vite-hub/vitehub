import { sendDynamicWebhook } from "./runtime.ts"

import type { Result } from "@vite-hub/runtime"
import type { SendWebhookErrorCode } from "./errors.ts"
import type { SendWebhookResult } from "./runtime.ts"

export { defineWebhook } from "./define.ts"
export type { WebhookDefinition, WebhookEvent, WebhookOptions, WebhookSignature } from "./define.ts"
export type { CreateMemberEndpointErrorCode, MemberEndpointErrorCode, MemberPairingErrorCode, SendToMemberEndpointErrorCode, SendWebhookErrorCode, WebhookDeliveryErrorCode } from "./errors.ts"
export type { SendWebhookResult, WebhookEventBody } from "./runtime.ts"
export { createMemberEndpoint, disableMemberEndpoint, enableMemberEndpoint, getMemberDelivery, getMemberDeliveryState, getMemberEndpoint, listMemberDeliveries, listMemberEndpoints, memberEndpointHosts, removeMemberEndpoint, removeMemberEndpoints, sendToMemberEndpoint } from "./members.ts"
export type { CreateMemberEndpointOptions, MemberDeliveries, MemberEndpointWithLastDelivery, SendToMemberEndpointOptions, SendToMemberEndpointResult } from "./members.ts"
export type { MemberEndpoint, MemberEndpointKind, MemberLastDelivery, MemberPairingState } from "./database.ts"
export { allowMemberPairing, cancelMemberPairing, getMemberPairing, memberPairingAddress, memberPairingLifetime, pairMemberEndpoint, refuseMemberPairing, startMemberPairing } from "./pairing.ts"
export type { AllowMemberPairingOptions, MemberAllowResult, MemberPairing, MemberPairResult } from "./pairing.ts"
export { checkWebhookUrl } from "./url-guard.ts"
export { sealWebhooksText, unsealWebhooksText } from "./sealing.ts"
export type { CheckWebhookUrlOptions } from "./url-guard.ts"

/** The webhooks of `server/webhooks/`. The generated `.vitehub/webhooks.d.ts` adds one key for each file. */
export interface WebhookRegistry {}

/** The name of a webhook of `server/webhooks/`. */
export type WebhookName = Extract<keyof WebhookRegistry, string>

/** Options of `sendWebhook()`. */
export interface SendWebhookOptions {
  /** A label for the receiver, sent as `x-vitehub-event`, such as `"comments.comment"`. */
  event: string
  /**
   * Sends with the same key collapse into one delivery while the debounce waits. Default: the webhook name, so all sends
   * of the webhook collapse. A webhook without `debounce` ignores it.
   */
  key?: string
}

/**
 * Sends `body` as JSON to the webhook `name` of `server/webhooks/<name>.ts`, signed with its secret, and returns
 * `[error, { id, status }]`. The delivery waits in the Database and goes out through the Queue, so it survives a restart
 * and the Queue retries it. With `debounce`, it waits until no send came for that long, then delivers the last body
 * once, with `x-vitehub-events` set to the number of sends.
 *
 * A missing variable, a body that is not JSON, or a Database or Queue failure comes back as the error. An unknown name
 * throws.
 *
 * ```ts
 * import { sendWebhook } from "@vite-hub/webhooks"
 *
 * const [error] = await sendWebhook("t3", { thread: thread.id }, { event: "comments.comment" })
 * ```
 */
export function sendWebhook<TName extends WebhookName>(name: TName, body: unknown, options: SendWebhookOptions): Promise<Result<SendWebhookResult, SendWebhookErrorCode>> {
  return sendDynamicWebhook(name, body, options)
}
