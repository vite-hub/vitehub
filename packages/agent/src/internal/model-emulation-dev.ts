import { agentDiagnostics } from "../agent-diagnostics.ts"
import { emulatorUrlEnv, modelEmulationEnv } from "./agent-emulation.ts"
import { startAiEmulator } from "./ai-emulator.ts"

import type { AgentModelsEmulateSeed } from "../types.ts"
import type { AiEmulator, AiEmulatorSeed } from "./ai-emulator.ts"

interface DevModelEmulatorLogger {
  info: (message: string) => void
}

/** The emulation setting of one app, by Vite root, and the dev servers of that app that are live. */
interface DevApp {
  seed: AgentModelsEmulateSeed | undefined
  key: string | undefined
  servers: Set<object>
}

// Agent model routing reads process.env, so every dev server in this process shares it and one emulator. An app is a
// Vite root: a restart is a new dev server of the same app, and its setting replaces the old one.
const apps = new Map<string, DevApp>()
let emulator: AiEmulator | undefined
let appliedKey: string | undefined
let previous: Record<string, string | undefined> = {}
let queue: Promise<unknown> = Promise.resolve()

function setEnv(values: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

/** Runs one change of the shared state at a time, so a start, a reseed, and a stop never overlap. */
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task)
  queue = run.catch(() => undefined)
  return run
}

/** Makes the emulator and the two variables match the setting of the live apps. All live apps have the same setting. */
async function sync(logger?: DevModelEmulatorLogger): Promise<string | undefined> {
  const wanted = apps.values().next().value
  if (!wanted?.seed) {
    if (!emulator) return
    const stopping = emulator
    emulator = undefined
    appliedKey = undefined
    setEnv(previous)
    previous = {}
    await stopping.close()
    return
  }
  if (!emulator) {
    // SAFETY: The emulator validates the seed when it starts and throws AGENT_EMULATOR_RULES_INVALID for a bad one.
    emulator = await startAiEmulator(wanted.seed as AiEmulatorSeed)
    appliedKey = wanted.key
    previous = { [modelEmulationEnv]: process.env[modelEmulationEnv], [emulatorUrlEnv]: process.env[emulatorUrlEnv] }
    setEnv({ [modelEmulationEnv]: "emulate", [emulatorUrlEnv]: emulator.url })
    logger?.info(`[vitehub] AI emulator: ${emulator.url}. Agent models answer from its rules with no AI key (VITEHUB_MODELS=emulate). Open the URL to see the calls.`)
  }
  else if (appliedKey !== wanted.key) {
    // SAFETY: As at startup, the emulator validates the seed and throws AGENT_EMULATOR_RULES_INVALID for a bad one.
    emulator.reseed(wanted.seed as AiEmulatorSeed)
    appliedKey = wanted.key
    logger?.info("[vitehub] AI emulator: the rules of agent.models.emulate changed and were replaced.")
  }
  return emulator.url
}

/**
 * Registers a dev server of the app at `root` and returns the emulator origin when the app sets `agent.models.emulate`.
 * The emulator runs, with `VITEHUB_MODELS=emulate` and `VITEHUB_EMULATE_URL` set, while a live app emulates. A new seed
 * of the same app, such as after a config edit and a restart, replaces the rules and the seed that a reset restores.
 * A dev server of another app with another setting fails with `AGENT_EMULATOR_DEV_APPS_CONFLICT`, because the routing
 * is process-wide and the other app would get the wrong answers.
 */
export function acquireDevModelEmulator(owner: object, root: string, emulate: boolean | AgentModelsEmulateSeed | undefined, logger: DevModelEmulatorLogger): Promise<string | undefined> {
  return serialized(async () => {
    const seed = emulate === true ? {} : emulate || undefined
    const key = seed && JSON.stringify(seed)
    for (const [other, app] of apps) {
      if (other !== root && app.key !== key) throw agentDiagnostics.AGENT_EMULATOR_DEV_APPS_CONFLICT({ root, other })
    }
    const before = apps.get(root)
    apps.set(root, { seed, key, servers: new Set([...before?.servers ?? [], owner]) })
    try {
      return await sync(logger)
    }
    catch (error) {
      if (before) apps.set(root, before)
      else apps.delete(root)
      throw error
    }
  })
}

/** Releases a dev server. When the last dev server of the last emulating app closes, the emulator stops and both variables return to their old values. */
export function releaseDevModelEmulator(owner: object, root: string): Promise<void> {
  return serialized(async () => {
    const app = apps.get(root)
    if (!app?.servers.delete(owner)) return
    if (!app.servers.size) apps.delete(root)
    await sync()
  })
}
