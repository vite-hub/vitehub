import { defineRateLimit } from "@vite-hub/rate-limit"

const uploads = defineRateLimit("image-upload", {
  failure: "deny",
  limit: 10,
  window: "1m",
})

export async function canUpload(key: string): Promise<boolean> {
  return (await uploads.consume(key)).allowed
}
