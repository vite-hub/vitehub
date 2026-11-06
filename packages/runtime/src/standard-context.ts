import type { CloudflareWorkerExecutionContext } from "@vite-hub/internal/runtime/cloudflare-env"
import type { StandardContext } from "standard-context"

/** The host data that ViteHub puts in `runtime` of a Standard Context. */
export interface ViteHubRuntime {
  /** The Cloudflare bindings and execution context of the request. A host can pass either one without the other. */
  cloudflare?: {
    context?: CloudflareWorkerExecutionContext
    env?: Record<string, unknown>
  }
  /** The client IP address that the host reports. ViteHub does not read it from forwarding headers. */
  clientAddress?: string
}

/** The `~standard` properties of a request event in a ViteHub app. */
export type ViteHubStandardProps = StandardContext.Props<ViteHubRuntime, void>

/** A request event in a ViteHub app: any server context with Standard Context properties. */
export type ViteHubContext<C = {}> = StandardContext<C, ViteHubRuntime, void>
