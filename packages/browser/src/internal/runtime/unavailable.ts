import type { BrowserAvailability } from "../../types.ts"

// Builds without a Browser integration resolve `#vitehub/browser/availability` here.
const availability: BrowserAvailability = {
  available: false,
  reason: "This build does not enable Browser.",
  fix: "Set `browser: true` in vitehub() with the Cloudflare preset.",
}

export default availability
