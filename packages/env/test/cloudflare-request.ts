import type { ViteHubContext } from "@vite-hub/runtime"

export function cloudflareRequest(env: Record<string, unknown>): ViteHubContext {
  return {
    "~standard": {
      vendor: "test",
      req: new Request("https://example.test/"),
      res: { headers: new Headers() },
      runtime: { cloudflare: { env } },
    },
  }
}
