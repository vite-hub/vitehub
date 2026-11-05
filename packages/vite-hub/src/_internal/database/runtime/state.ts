import {
  getRequestCloudflareEnv as ownerGetRequestCloudflareEnv,
  runWithActiveCloudflareEnv as ownerRunWithActiveCloudflareEnv,
  runWithDatabaseRequest as ownerRunWithDatabaseRequest,
  setActiveCloudflareEnv as ownerSetActiveCloudflareEnv,
} from "@vite-hub/database/runtime/cloudflare-env"

import type { ViteHubContext } from "@vite-hub/runtime"

export const setActiveCloudflareEnv: (env: Record<string, unknown> | undefined) => void
  = ownerSetActiveCloudflareEnv

export const runWithActiveCloudflareEnv: <T>(env: Record<string, unknown> | undefined, callback: () => T) => T
  = ownerRunWithActiveCloudflareEnv

export const runWithDatabaseRequest: <T>(event: ViteHubContext, next: () => T) => Promise<Awaited<T>>
  = ownerRunWithDatabaseRequest

/** The Nuxt request middleware reads the request's Cloudflare bindings through this alias of the Database runtime state. */
export const getRequestCloudflareEnv: (event: ViteHubContext) => Record<string, unknown> | undefined
  = ownerGetRequestCloudflareEnv
