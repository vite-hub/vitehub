import { queueErrorDiagnostics } from "../../error-diagnostics.ts"

import type { QueueClient } from "../../types.ts"
import type { QueueRuntimeProviderOptions } from "./types.ts"

/** Worker package conditions keep the Node provider and its optional peer outside the build graph. */
export async function createPostgresQueueRuntimeClient(options: QueueRuntimeProviderOptions): Promise<QueueClient> {
  throw queueErrorDiagnostics.QUEUE_PROVIDER_MISMATCH({ expected: "cloudflare", provider: options.provider })
}
