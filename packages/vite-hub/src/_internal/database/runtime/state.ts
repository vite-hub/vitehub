import {
  runWithActiveCloudflareEnv as ownerRunWithActiveCloudflareEnv,
  setActiveCloudflareEnv as ownerSetActiveCloudflareEnv,
} from "@vite-hub/database/runtime/cloudflare-env"

export const setActiveCloudflareEnv: (env: Record<string, unknown> | undefined) => void
  = ownerSetActiveCloudflareEnv

export const runWithActiveCloudflareEnv: <T>(env: Record<string, unknown> | undefined, callback: () => T) => T
  = ownerRunWithActiveCloudflareEnv
