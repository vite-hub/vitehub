import { resolve } from "pathe"

import { defaultLocalQueueBase } from "../../config.ts"
import { createLocalQueueClient, createLocalQueueEngine, localQueueDeliveryRules } from "../../providers/local.ts"
import { loadQueueDefinition, missingQueueDefinitionError } from "./state.ts"

import type { LocalQueueEngine, LocalQueueStatus } from "../../providers/local.ts"
import type { LocalQueueRules, QueueClient } from "../../types.ts"
import type { QueueRuntimeOptions, QueueRuntimeProviderOptions } from "./types.ts"
import { queueErrorDiagnostics } from "../../error-diagnostics.ts"

// One engine per directory, so every client of this process shares the delivery of its jobs.
const engines = new Map<string, { development: boolean, engine: LocalQueueEngine }>()

function getLocalQueueEngine({ base = defaultLocalQueueBase, development, rules = "local" }: { base?: string, development?: boolean, rules?: LocalQueueRules }): LocalQueueEngine {
  const directory = resolve(base)
  const cached = engines.get(directory)
  const discloseErrors = development === true
  if (cached) {
    if (cached.development !== discloseErrors) throw queueErrorDiagnostics.QUEUE_LOCAL_MODE_MISMATCH()
    return cached.engine
  }
  const engine = createLocalQueueEngine({ base: directory, development: discloseErrors, load: loadQueueDefinition, missing: missingQueueDefinitionError, rules: localQueueDeliveryRules[rules] })
  engines.set(directory, { development: discloseErrors, engine })
  return engine
}

export async function createLocalQueueRuntimeClient(options: QueueRuntimeProviderOptions): Promise<QueueClient> {
  if (options.provider !== "local") {
    throw queueErrorDiagnostics.QUEUE_PROVIDER_MISMATCH({ expected: "local", provider: options.provider })
  }
  if (!options.queue) throw queueErrorDiagnostics.QUEUE_MISSING_QUEUE()
  return createLocalQueueClient(getLocalQueueEngine(options), options.queue)
}

const providerNames: Readonly<Record<LocalQueueRules, string>> = { cloudflare: "Cloudflare", local: "local", vercel: "Vercel" }

/**
 * Starts delivery of the stored jobs when the server starts, so jobs from before a restart run without a new send.
 * Logs once where the jobs are and what survives.
 */
export function startLocalQueue(config: false | QueueRuntimeOptions): void {
  if (config === false || config.provider !== "local") return
  const engine = getLocalQueueEngine(config)
  if (config.rules && config.rules !== "local") {
    console.warn(`[vitehub:queue] The dev server runs Queue jobs in this process with the ${providerNames[config.rules]} delivery rules. It stores them in ${engine.base}. The build uses ${providerNames[config.rules]} Queues. Run \`vitehub queue jobs list\` to inspect the jobs.`)
  }
  else {
    console.warn(`[vitehub:queue] Queue uses the local provider. This process stores jobs in ${engine.base} and runs them. The jobs survive a restart on this host, but not a move to another host or a new container. Run one server process per directory.`)
  }
  engine.start().catch((error: unknown) => {
    console.error(`[vitehub:queue] The local provider cannot read the stored jobs in ${engine.base}.`, error)
  })
}

/** The engine of the stored jobs, for `vitehub queue list`, `vitehub queue jobs`, and the Console. */
export function useLocalQueueEngine(config: QueueRuntimeOptions): LocalQueueEngine | undefined {
  if (config.provider !== "local") return
  return getLocalQueueEngine(config)
}

/** Status of the stored jobs, for `vitehub queue list` and the Console. */
export async function getLocalQueueStatus(config: QueueRuntimeOptions): Promise<LocalQueueStatus | undefined> {
  return await useLocalQueueEngine(config)?.status()
}

/** Stops the timers of every local engine. The stored jobs stay. */
export function closeLocalQueues(): void {
  for (const { engine } of engines.values()) engine.close()
  engines.clear()
}
