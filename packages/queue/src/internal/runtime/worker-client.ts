import { queueErrorDiagnostics } from "../../error-diagnostics.ts"

import type { QueueClient } from "../../types.ts"
import type { QueueRuntimeDriverOptions } from "./types.ts"

/** Worker package conditions keep the Node driver and its optional peer outside the build graph. */
export async function createPostgresQueueRuntimeClient(options: QueueRuntimeDriverOptions): Promise<QueueClient> {
  throw queueErrorDiagnostics.QUEUE_DRIVER_MISMATCH({ driver: options.driver, expected: "cloudflare" })
}
