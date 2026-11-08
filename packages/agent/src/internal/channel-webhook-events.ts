import type { WebhookChannelAdapter } from "@vite-hub/channels"

interface ChannelWebhookEventTarget {
  name: string
  webhook: WebhookChannelAdapter["webhook"]
}

const targets = new WeakMap<object, ChannelWebhookEventTarget>()

/** Marks triggers that share one Channel adapter registration and select distinct event names. */
export function withChannelWebhookEvent<T extends object>(trigger: T, target: ChannelWebhookEventTarget): T {
  targets.set(trigger, target)
  return trigger
}

export function channelWebhookEventTarget(trigger: object): ChannelWebhookEventTarget | undefined {
  return targets.get(trigger)
}
