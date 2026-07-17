import { defineRateLimit } from "@vite-hub/rate-limit"

export default defineRateLimit({
  failure: "deny",
  limit: 10,
  window: "1m",
})
