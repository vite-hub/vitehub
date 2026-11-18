import type { ViteHubConsoleWebhooksSection } from "@vite-hub/internal/console"

/**
 * Console section for the webhooks of `server/webhooks/`: each endpoint, the pending debounce timers, and the delivery
 * log, with Send test, Send now, Cancel, and Redeliver. It calls the `webhooks.*` operations with the Console user.
 */
export const webhooksConsoleSection: ViteHubConsoleWebhooksSection = {
  description: "See, test, flush, and redeliver the webhooks that the app sends.",
  icon: "i-vitehub-webhooks",
  id: "webhooks",
  label: "Webhooks",
  view: {
    kind: "webhooks",
    notice: "The list comes from the webhooks.* operations. The Console shows the names of the URL and secret variables and the URL host, never the full URL or the secret. `vitehub webhooks` and the webhooks MCP tools do the same.",
  },
}
