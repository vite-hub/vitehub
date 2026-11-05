import {
  getRequestCloudflareEnv as ownerGetRequestCloudflareEnv,
  runWithActiveCloudflareEnv as ownerRunWithActiveCloudflareEnv,
  runWithDatabaseRequest as ownerRunWithDatabaseRequest,
  setActiveCloudflareEnv as ownerSetActiveCloudflareEnv,
} from "@vite-hub/database/runtime/cloudflare-env"

/**
 * A request event with Standard Context, the `ViteHubContext` of `@vite-hub/runtime`. This declaration repeats the
 * shape, so the installed facade declaration needs no other package.
 */
interface RequestEvent {
  readonly "~standard": {
    readonly vendor: string
    readonly req: Request
    readonly res: { headers?: Headers, status?: number }
    readonly runtime?: { cloudflare?: { context?: { waitUntil?: (promise: Promise<unknown>) => void }, env: Record<string, unknown> }, clientAddress?: string }
    readonly waitUntil?: (promise: Promise<unknown>) => void
  }
}

export const setActiveCloudflareEnv: (env: Record<string, unknown> | undefined) => void
  = ownerSetActiveCloudflareEnv

export const runWithActiveCloudflareEnv: <T>(env: Record<string, unknown> | undefined, callback: () => T) => T
  = ownerRunWithActiveCloudflareEnv

export const runWithDatabaseRequest: <T>(event: RequestEvent, next: () => T) => Promise<Awaited<T>>
  = ownerRunWithDatabaseRequest

/** The Nuxt request middleware reads the request's Cloudflare bindings through this alias of the Database runtime state. */
export const getRequestCloudflareEnv: (event: RequestEvent) => Record<string, unknown> | undefined
  = ownerGetRequestCloudflareEnv
