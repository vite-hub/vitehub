import type { RealtimeAvailability } from "../../types.ts"

// Builds without the Realtime integration resolve `#vitehub/realtime/availability` here.
const availability: RealtimeAvailability = {
  available: false,
  reason: "This build does not enable Realtime.",
  fix: "Enable `realtime` in vitehub() with the Cloudflare preset, or with `authority: \"memory\"` for one Node.js process.",
}

export default availability
