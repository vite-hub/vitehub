import availability from "#vitehub/realtime/availability"

/**
 * Returns `true` when this build has a Realtime room authority: Durable Objects on Cloudflare, a Node server, or memory
 * on the dev server. Without one, no room opens and `refreshRealtimeDocument()` resolves `false`.
 */
export function isRealtimeAvailable(): boolean {
  return availability.available
}
