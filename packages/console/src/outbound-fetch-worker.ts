/**
 * The fetch that the Console server uses to reach MCP and OAuth servers on Workers. Workers fetch cannot reach private
 * addresses, so the host name check of the MCP client is enough.
 */
export function consoleOutboundFetch(_allowPrivate: boolean): typeof fetch {
  return fetch
}
