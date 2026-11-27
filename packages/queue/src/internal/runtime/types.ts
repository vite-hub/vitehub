import type { QueueDriverOptions, ResolvedQueueOptions } from "../../types.ts"

interface QueueDevelopmentOptions {
  development?: boolean
}

export type QueueRuntimeOptions = ResolvedQueueOptions & QueueDevelopmentOptions
export type QueueRuntimeDriverOptions = QueueDriverOptions & QueueDevelopmentOptions
