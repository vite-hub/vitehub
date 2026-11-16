import type { ViteHubConsoleOperationSection } from "@vite-hub/internal/console"

// Only OAuth Connections connect in the browser. API keys and ChatGPT plans use `vitehub connections`.
const oauth = ["oauth2"]

/** Console section of the app's Connections. It lists `connections.list`, and connects and revokes OAuth Connections. */
export const connectionsConsoleSection: ViteHubConsoleOperationSection = {
  description: "Connect, reconnect, and revoke the provider accounts of the app.",
  icon: "i-vitehub-connections",
  id: "connections",
  label: "Connections",
  view: {
    actions: [
      { input: { name: "name" }, label: "Connect", operation: "connections.connect", tab: true, when: { credential: oauth, status: ["disconnected", "revoked"] } },
      { input: { name: "name" }, label: "Reconnect", operation: "connections.connect", tab: true, when: { credential: oauth, status: ["connected", "reauth_required"] } },
      { confirm: "Revoke {name}? Calls that use it fail until someone connects it again.", input: { name: "name" }, label: "Revoke", operation: "connections.revoke", when: { status: ["connected", "reauth_required"] } },
    ],
    columns: [
      { key: "name", label: "Connection" },
      { key: "provider", label: "Provider" },
      { format: "status", key: "status", label: "Status", tones: { connected: "success", reauth_required: "warning" } },
      { key: "account", label: "Account" },
      { format: "datetime", key: "refreshedAt", label: "Refreshed" },
    ],
    kind: "operation-view",
    notice: "Connect opens the provider in a new tab. The provider returns to the app, and the app keeps the grant: the Console never sees a token. API key and ChatGPT Connections connect with `vitehub connections`.",
    operation: "connections.list",
  },
}
