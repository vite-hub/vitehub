import { agentDiagnostics } from "../agent-diagnostics.ts"
import { emulatorUrlEnv, modelEmulationEnv } from "./agent-emulation.ts"
import { startAiEmulator, upstreamMessage } from "./ai-emulator.ts"

import type { AgentModelsEmulateSeed } from "../types.ts"
import type { AiEmulator } from "./ai-emulator.ts"

interface DevModelEmulatorLogger {
  info: (message: string) => void
}

// Several dev servers in one process share process.env, so they share one emulator. The last owner closes it.
const owners = new Set<object>()
let running: Promise<AiEmulator> | undefined
let runningUrl = ""
let appliedSeed = ""
let previous: Record<string, string | undefined> = {}

function seedConfig(seed: true | AgentModelsEmulateSeed): AgentModelsEmulateSeed {
  return seed === true ? {} : seed
}

function setEnv(values: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

async function replaceRules(url: string, seed: AgentModelsEmulateSeed): Promise<void> {
  const response = await fetch(`${url}/_ai/rules`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(seed),
  })
  if (!response.ok) throw agentDiagnostics.AGENT_EMULATOR_RULES_INVALID({ detail: upstreamMessage(await response.text()) })
}

/**
 * Starts the AI emulator for a dev server, or joins the one that runs in this process, and returns its origin.
 * It sets `VITEHUB_MODELS=emulate` and `VITEHUB_EMULATE_URL` until the last owner releases it. A new seed, such as
 * after a config edit and a restart, replaces the rules of the running emulator.
 */
export async function acquireDevModelEmulator(owner: object, seed: true | AgentModelsEmulateSeed, logger: DevModelEmulatorLogger): Promise<string> {
  const config = seedConfig(seed)
  const key = JSON.stringify(config)
  owners.add(owner)
  if (!running) {
    const starting = startAiEmulator(config)
    running = starting
    let emulator: AiEmulator
    try {
      emulator = await starting
    }
    catch (error) {
      if (running === starting) running = undefined
      owners.delete(owner)
      throw error
    }
    // The last owner released the emulator while it started. That release stops it.
    if (running !== starting) return emulator.url
    appliedSeed = key
    runningUrl = emulator.url
    previous = { [modelEmulationEnv]: process.env[modelEmulationEnv], [emulatorUrlEnv]: process.env[emulatorUrlEnv] }
    setEnv({ [modelEmulationEnv]: "emulate", [emulatorUrlEnv]: runningUrl })
    logger.info(`[vitehub] AI emulator: ${runningUrl}. Agent models answer from its rules with no AI key (VITEHUB_MODELS=emulate). Open the URL to see the calls.`)
    return runningUrl
  }
  try {
    await running
    if (key !== appliedSeed) {
      await replaceRules(runningUrl, config)
      appliedSeed = key
      logger.info("[vitehub] AI emulator: the rules of agent.models.emulate changed and were replaced.")
    }
  }
  catch (error) {
    owners.delete(owner)
    throw error
  }
  return runningUrl
}

/** Releases the emulator of a dev server. The last owner stops it and restores the two Server Env variables. */
export async function releaseDevModelEmulator(owner: object): Promise<void> {
  if (!owners.delete(owner) || owners.size || !running) return
  const stopping = running
  running = undefined
  appliedSeed = ""
  runningUrl = ""
  setEnv(previous)
  previous = {}
  await (await stopping.catch(() => undefined))?.close()
}
