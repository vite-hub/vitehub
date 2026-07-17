import { defineRateLimit } from "vite-hub/rate-limit"

export default defineRateLimit({
  limit: 10,
  window: "1m",
})
