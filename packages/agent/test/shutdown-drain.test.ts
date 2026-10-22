import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"

import { isRuntimeFunction } from "../src/internal/runtime-value.ts"

type Drain = (context: { signal: AbortSignal, timeoutMs: number }) => unknown

async function generateQueuePlugin(options: { preset?: string, shutdown?: false | { drainMs?: number } }) {
  const { hubAgent } = await import("../src/vite.ts")
  const root = await mkdtemp(join(tmpdir(), "vitehub-agent-shutdown-drain-"))
  try {
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await writeFile(join(root, "server", "agents", "support.ts"), "export default {}", "utf8")
    const plugin = hubAgent({
      // Ephemeral hosts need a remote state URL.
      providers: { state: { provider: "libsql", url: options.preset ? "libsql://state.example.com" : "file:agent-state.sqlite" } },
      ...(options.shutdown === undefined ? {} : { shutdown: options.shutdown }),
    })
    if (!isRuntimeFunction(plugin.configResolved)) throw new TypeError("Expected Agent configResolved hook.")
    // SAFETY: The hook reads only command, preset, and root from this test config.
    await plugin.configResolved.call({} as never, { command: "build", ...(options.preset ? { preset: options.preset } : {}), root } as never)
    return await readFile(join(root, ".vitehub/agent/webhook-queue-plugin.ts"), "utf8")
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
}

/** Run the generated plugin source with replacements for its imports and the Nitro build flags. */
function runQueuePlugin(source: string, options: { dev?: boolean, env?: Record<string, string | undefined> } = {}) {
  const drains = new Map<string, Drain>()
  const drainChat = vi.fn(async (_options: { timeoutMs: number }) => ({ active: 1, interrupted: 0, unsettled: 0 }))
  const queueStop = vi.fn(async () => {})
  const webhookQueueShutdown = vi.fn(async () => {})
  const body = source
    .replace(/^import .*\n/gm, "")
    .replaceAll("import.meta.dev", String(Boolean(options.dev)))
    .replaceAll("import.meta.prerender", "false")
    .replace("export default ", "return ")
  // SAFETY: The generated plugin module returns its default export after the replacements above.
  const plugin = new Function("resumeWebhookQueues", "warmWebhookRoutes", "waitUntilFromEvent", "drainInlineChatInvocations", "onShutdown", "webhookQueueShutdown", "process", "setTimeout", body)(
    () => queueStop,
    async () => {},
    () => undefined,
    drainChat,
    (_app: unknown, name: string, drain: Drain) => drains.set(name, drain),
    webhookQueueShutdown,
    { env: options.env ?? {} },
    (callback: () => void) => callback(),
  ) as (app: { hooks: { hook: () => void } }) => void
  plugin({ hooks: { hook: () => {} } })
  return { drainChat, drains, queueStop, webhookQueueShutdown }
}

const context = (timeoutMs: number) => ({ signal: new AbortController().signal, timeoutMs })

describe("generated Agent shutdown drains", () => {
  it("registers the chat and queue drains with ViteHub shutdown on a persistent server", async () => {
    const source = await generateQueuePlugin({ shutdown: { drainMs: 45_000 } })
    expect(source).toContain('import { drainInlineChatInvocations, onShutdown, webhookQueueShutdown } from "@vite-hub/agent/server/internal"')
    expect(source).not.toContain("SIGTERM")
    expect(source).not.toContain("process.exit")

    const env: Record<string, string | undefined> = {}
    const { drainChat, drains, queueStop, webhookQueueShutdown } = runQueuePlugin(source, { env })
    expect([...drains.keys()]).toEqual(["agent.chat", "agent.webhook-queues"])
    // `agent.shutdown.drainMs` sets the default of the shared budget.
    expect(env.VITEHUB_SHUTDOWN_DRAIN_MS).toBe("45000")

    await drains.get("agent.chat")!(context(45_000))
    expect(drainChat).toHaveBeenCalledWith({ timeoutMs: 45_000 })
    await drains.get("agent.webhook-queues")!(context(45_000))
    expect(queueStop).toHaveBeenCalledOnce()
    expect(webhookQueueShutdown).toHaveBeenCalledOnce()
  })

  it("keeps a budget that the environment already sets", async () => {
    const source = await generateQueuePlugin({ shutdown: { drainMs: 45_000 } })
    const env: Record<string, string | undefined> = { VITEHUB_SHUTDOWN_DRAIN_MS: "5000" }
    runQueuePlugin(source, { env })
    expect(env.VITEHUB_SHUTDOWN_DRAIN_MS).toBe("5000")
  })

  it("does not change the budget without agent.shutdown.drainMs", async () => {
    const source = await generateQueuePlugin({})
    expect(source).not.toContain("VITEHUB_SHUTDOWN_DRAIN_MS")
    expect([...runQueuePlugin(source).drains.keys()]).toEqual(["agent.chat", "agent.webhook-queues"])
  })

  it("does not drain inline Chat invocations in development, when disabled, or on ephemeral hosts", async () => {
    const persistent = await generateQueuePlugin({})
    expect([...runQueuePlugin(persistent, { dev: true }).drains.keys()]).toEqual(["agent.webhook-queues"])

    const disabled = await generateQueuePlugin({ shutdown: false })
    expect(disabled).not.toContain("drainInlineChatInvocations")
    expect([...runQueuePlugin(disabled).drains.keys()]).toEqual(["agent.webhook-queues"])

    const ephemeral = await generateQueuePlugin({ preset: "vercel" })
    expect(ephemeral).not.toContain("drainInlineChatInvocations")
    expect([...runQueuePlugin(ephemeral).drains.keys()]).toEqual(["agent.webhook-queues"])
  })
})
