import {
  runWithActiveCloudflareEnv as ownerRunWithActiveCloudflareEnv,
  setActiveCloudflareEnv as ownerSetActiveCloudflareEnv,
} from "@vite-hub/database/runtime/cloudflare-env"
import { runWithDatabaseRequest as ownerRunWithDatabaseRequest } from "@vite-hub/database/runtime/state"

export const setActiveCloudflareEnv: (env: Record<string, unknown> | undefined) => void
  = ownerSetActiveCloudflareEnv

export const runWithActiveCloudflareEnv: <T>(env: Record<string, unknown> | undefined, callback: () => T) => T
  = ownerRunWithActiveCloudflareEnv

export const runWithDatabaseRequest: <T>(event: unknown, next: () => T) => Promise<Awaited<T>>
  = ownerRunWithDatabaseRequest
