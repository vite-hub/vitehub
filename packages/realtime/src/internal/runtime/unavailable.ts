import type { RealtimeAvailability } from "../../types.ts"

const availability: RealtimeAvailability = {
  available: false,
  reason: "This build does not enable Realtime.",
  fix: "Enable `realtime` in vitehub() with the Cloudflare or Node preset.",
}

export default availability
