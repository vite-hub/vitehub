import { resolve } from "pathe"

import { defaultLocalQueueBase } from "../../config.ts"
import { createLocalQueueClient, createLocalQueueEngine } from "../../providers/local.ts"
import { loadQueueDefinition, missingQueueDefinitionError } from "./state.ts"

import type { LocalQueueEngine, LocalQueueStatus } from "../../providers/local.ts"
import type { QueueClient, QueueProviderOptions, ResolvedQueueOptions } from "../../types.ts"
import { queueErrorDiagnostics } from "../../error-diagnostics.ts"

// One engine per directory, so every client of this process shares the delivery of its jobs.
const engines = new Map<string, LocalQueueEngine>()

function getLocalQueueEngine(base = defaultLocalQueueBase): LocalQueueEngine {
  const directory = resolve(base)
  let engine = engines.get(directory)
  if (!engine) {
    engine = createLocalQueueEngine({ base: directory, load: loadQueueDefinition, missing: missingQueueDefinitionError })
    engines.set(directory, engine)
  }
  return engine
}

export async function createLocalQueueRuntimeClient(options: QueueProviderOptions): Promise<QueueClient> {
  if (options.provider !== "local") {
    throw queueErrorDiagnostics.QUEUE_PROVIDER_MISMATCH({ expected: "local", provider: options.provider })
  }
  if (!options.queue) throw queueErrorDiagnostics.QUEUE_MISSING_QUEUE()
  return createLocalQueueClient(getLocalQueueEngine(options.base), options.queue)
}

/**
 * Starts delivery of the stored jobs when the server starts, so jobs from before a restart run without a new send.
 * Logs once where the jobs are and what survives.
 */
export function startLocalQueue(config: false | ResolvedQueueOptions): void {
  if (config === false || config.provider !== "local") return
  const engine = getLocalQueueEngine(config.base)
  console.warn(`[vitehub:queue] Queue uses the local provider. This process stores jobs in ${engine.base} and runs them. The jobs survive a restart on this host, but not a move to another host or a new container. Run one server process per directory.`)
  engine.start().catch((error: unknown) => {
    console.error(`[vitehub:queue] The local provider cannot read the stored jobs in ${engine.base}.`, error)
  })
}

/** Status of the stored jobs, for `vitehub queue list` and the Console. */
export async function getLocalQueueStatus(config: ResolvedQueueOptions): Promise<LocalQueueStatus | undefined> {
  if (config.provider !== "local") return
  return await getLocalQueueEngine(config.base).status()
}

/** Stops the timers of every local engine. The stored jobs stay. */
export function closeLocalQueues(): void {
  for (const engine of engines.values()) engine.close()
  engines.clear()
}
