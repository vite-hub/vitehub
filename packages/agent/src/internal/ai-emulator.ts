import { once } from "node:events"
import { agentDiagnostics } from "../agent-diagnostics.ts"

import type { AddressInfo } from "node:net"
import type { AiSeedConfig } from "@emulators/ai"

/** The `ai` seed of the AI emulator, without the fields that the starter sets. */
export type AiEmulatorSeed = Omit<AiSeedConfig, "baseUrl" | "port">

/** A running AI emulator from `startAiEmulator()`. */
export interface AiEmulator {
  /** Origin of the bound loopback listener, such as `http://127.0.0.1:41234`. */
  url: string
  /** Replaces the seed that `POST /_ai/reset` restores, and resets the rules, budgets, and calls to it. */
  reseed: (seed: AiEmulatorSeed) => void
  close: () => Promise<void>
}

async function loadEmulators() {
  try {
    return await Promise.all([import("@emulators/core"), import("@emulators/ai")])
  }
  catch (error) {
    throw agentDiagnostics.AGENT_EMULATOR_PACKAGES_MISSING({ cause: error })
  }
}

/**
 * Starts the upstream AI emulator (`@emulators/ai`) on a free loopback port. The URL is the address that the listener
 * bound, so it never names `localhost`, which can resolve to `::1` first. `emulateModels()` and `agent.models.emulate`
 * in `vite dev` both use it.
 */
export async function startAiEmulator(seed: AiEmulatorSeed): Promise<AiEmulator> {
  const [{ createServer, serve }, { aiPlugin, seedFromConfig, AiConfigError }] = await loadEmulators()
  let app: ReturnType<typeof createServer>["app"] | undefined
  const server = serve({
    fetch: request => app?.fetch(request) ?? new Response("Starting", { status: 503 }),
    hostname: "127.0.0.1",
    port: 0,
    abortOnClose: true,
  })
  const close = () => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
    server.closeAllConnections()
  })
  await once(server, "listening")
  try {
    const address = server.address() as AddressInfo
    const url = `http://${address.address}:${address.port}`
    const runtime = createServer(aiPlugin, { baseUrl: url, port: address.port })
    // seedFromConfig validates the whole seed before it changes the store, so a rejected seed keeps the current one.
    const reseed = (next: AiEmulatorSeed) => {
      try {
        seedFromConfig(runtime.store, url, next)
      }
      catch (error) {
        if (error instanceof AiConfigError) throw agentDiagnostics.AGENT_EMULATOR_RULES_INVALID({ detail: error.message, cause: error })
        throw error
      }
    }
    reseed(seed)
    app = runtime.app
    return { url, reseed, close }
  }
  catch (error) {
    await close()
    throw error
  }
}

/** Returns `error.message` of an upstream OpenAI error envelope, or the body as it is. */
export function upstreamMessage(body: string): string {
  try {
    const message = (JSON.parse(body) as { error?: { message?: unknown } }).error?.message
    return typeof message === "string" ? message : body
  }
  catch {
    return body
  }
}
