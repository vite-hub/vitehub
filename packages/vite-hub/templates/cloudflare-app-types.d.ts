import { CloudflareWorkersModule } from "@cloudflare/workers-types/index"
import type { DurableObjectState as WorkerDurableObjectState } from "@cloudflare/workers-types/index"

declare global {
  namespace Cloudflare {
    interface Env {}
  }

  interface DurableObjectState<Props = unknown> extends WorkerDurableObjectState<Props> {}
}

declare module "@cloudflare/workers-types/index" {
  namespace Cloudflare {
    interface Env extends globalThis.Cloudflare.Env {}
  }
}

export = CloudflareWorkersModule
