import { connectRealtimeRoom } from "@vite-hub/realtime/client"
import { connectPage as connectAgentPage } from "@vite-hub/agent/page"

import type { ConnectPageOptions, ConnectedPage, PageBridge } from "@vite-hub/agent/page"

export type { ConnectPageOptions, ConnectedPage, JoinPageRoom, PageBridge, PageRoom } from "@vite-hub/agent/page"

/**
 * Lets a ViteHub Agent with the `page()` Capability work this page through a ui-sdk bridge, over Realtime. Pass the
 * result to `useChat(agent, { page })` from `vite-hub/agent/vue`.
 *
 * @example
 * const page = connectPage(createAgent())
 * const chat = useChat(useAgent("settings"), { page })
 */
export function connectPage(bridge: PageBridge, options: ConnectPageOptions = {}): ConnectedPage {
  return connectAgentPage(bridge, { join: connectRealtimeRoom, ...options })
}
