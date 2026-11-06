import type { QueueProviderOptions, ResolvedQueueOptions } from "../../types.ts"

/** Only the generated development integration enables handler error details. */
interface QueueDevelopmentOptions {
  development?: boolean
}

export type QueueRuntimeOptions = ResolvedQueueOptions & QueueDevelopmentOptions
export type QueueRuntimeProviderOptions = QueueProviderOptions & QueueDevelopmentOptions
