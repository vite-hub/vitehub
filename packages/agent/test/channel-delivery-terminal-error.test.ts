import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"

import { defineChannel, defineChannelTrigger } from "../src/channels.ts"
import { defineAgent } from "../src/index.ts"
import { createChannelWebhookRouteHandler } from "../src/server/internal.ts"
import { createLibsqlAgentState } from "../src/state/sqlite.ts"

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function deliveryEvents(...spies: Array<{ mock: { calls: unknown[][] } }>) {
  return spies.flatMap(spy => spy.mock.calls.flatMap(([line]) => {
    if (typeof line !== "string" || !line.startsWith("{")) return []
    const parsed = JSON.parse(line) as { error?: string, scope?: string, type?: string }
    return parsed.scope === "vitehub.channel.delivery" && parsed.type ? [{ error: parsed.error, type: parsed.type }] : []
  }))
}

it("records why a trigger result made the webhook route answer with a 5xx", async () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {})
  const error = vi.spyOn(console, "error").mockImplementation(() => {})
  const log = vi.spyOn(console, "log").mockImplementation(() => {})
  const stateDir = await mkdtemp(join(tmpdir(), "vitehub-terminal-error-"))
  const state = createLibsqlAgentState({ url: `file:${join(stateDir, "state.sqlite")}` })
  cleanups.push(async () => {
    await state.disconnect()
    await rm(stateDir, { force: true, recursive: true })
  })
  const agent = defineAgent({
    channels: {
      hook: defineChannel("hook", {
        messages: false,
        triggers: {
          webhook: defineChannelTrigger({
            async prepare() {},
            invoke() {
              return {
                // A function cannot be queued, and `prepare` runs from the queued input.
                input: { context: { load: () => "bytes" }, prompt: "hi" },
                webhook: { concurrencyKey: "hook", concurrencyLimit: 1, deliveryId: "delivery-1" },
              }
            },
          }),
        },
        webhooks: { path: "/hook", provider: "hook", secretToken: false },
      }),
    },
    driver: { run: () => "unused" },
  })

  const response = await createChannelWebhookRouteHandler(agent as never)(new Request("https://example.com/hook", {
    body: "{}",
    headers: { "content-type": "application/json" },
    method: "POST",
  }), "", { agentName: "terminal", webhookState: state })

  expect(response.status).toBe(500)
  expect(deliveryEvents(info, error, log).at(-1)).toEqual({
    error: 'Trigger "hook.webhook" uses prepare or a task, so its queued input and run metadata must be JSON-serializable.',
    type: "failed",
  })
})
