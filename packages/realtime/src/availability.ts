import availability from "#vitehub/realtime/availability"

/**
 * Returns `true` when this build has a Realtime room authority: Durable Objects on Cloudflare, or memory in one Node.js
 * process and on the dev server. Without one, no room opens and `refreshRealtimeDocument()` resolves `false`.
 */
export function isRealtimeAvailable(): boolean {
  return availability.available
}
