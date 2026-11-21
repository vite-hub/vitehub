import type { ViteHubConsoleWebhooksSection } from "@vite-hub/internal/console"

/**
 * Console section for the webhooks of `server/webhooks/` and the member endpoints: each endpoint, the pending debounce
 * timers, and the delivery log, with Send test, Send now, Cancel, Redeliver, and Disable or Enable for a member
 * endpoint. It calls the `webhooks.*` operations with the Console user.
 */
export const webhooksConsoleSection: ViteHubConsoleWebhooksSection = {
  description: "See, test, flush, and redeliver the webhooks that the app sends.",
  icon: "i-vitehub-webhooks",
  id: "webhooks",
  label: "Webhooks",
  view: {
    kind: "webhooks",
    notice: "The list comes from the webhooks.* operations. The Console shows the names of the URL and secret variables and the host of each URL, never the full URL or the secret. Admins see member endpoints read-only and can disable one. Only the member who owns an endpoint can redeliver to it. `vitehub webhooks` and the webhooks MCP tools do the same.",
  },
}
