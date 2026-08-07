import { setActiveCloudflareEnv as ownerSetActiveCloudflareEnv } from "@vite-hub/database/runtime/cloudflare-env"

export const setActiveCloudflareEnv: (env: Record<string, unknown> | undefined) => void
  = ownerSetActiveCloudflareEnv
