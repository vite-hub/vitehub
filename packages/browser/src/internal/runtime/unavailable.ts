import type { BrowserAvailability } from "../../types.ts"

const availability: BrowserAvailability = {
  available: false,
  reason: "This build does not enable Browser.",
  fix: "Set `browser: true` in vitehub() with the Cloudflare preset.",
}

export default availability
