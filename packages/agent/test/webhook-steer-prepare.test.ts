import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"

import * as v from "valibot"
import { expect, it, vi } from "vitest"

import { defineChannel, defineChannelTrigger } from "../src/channels.ts"
import { defineAgent } from "../src/index.ts"
import {
  agentInvocationControlId,
  registerAgentInvocationInputHandler,
} from "../src/internal/agent-invocation-control.ts"
import { createChannelWebhookRouteHandler } from "../src/server/internal.ts"
import { createLibsqlAgentState } from "../src/state/sqlite.ts"
import type {
  AgentRunContext,
  AgentRunInput,
} from "../src/index.ts"
import type { AgentWebhookInvocationOwnership } from "../src/types.ts"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

it.each([false, true])(
  "prepares queued webhook invocations and skips active steering (rehydrate: %s)",
  async (rehydrate) => {
    const dir = await mkdtemp(join(import.meta.dirname, ".steer-prepare-"))
    const state = createLibsqlAgentState({ url: `file:${join(dir, "state.sqlite")}` })
    const firstStarted = deferred()
    const secondStarted = deferred()
    const release = deferred()
    const inputs: AgentRunInput[] = []
    const steered: AgentRunInput[] = []
    let rejectSteering = false
    const prepare = vi.fn((_context: unknown, { input }: { input: AgentRunInput }) => ({
      ...input,
      prompt: `${input.prompt}:prepared`,
    }))
    const run = vi.fn(async (context: AgentRunContext) => {
      inputs.push(context.input)
      if (inputs.length === 1) {
        const controlId = agentInvocationControlId(context)
        if (!controlId) throw new Error("Expected an invocation control ID")
        const close = registerAgentInvocationInputHandler(controlId, {
          sendInput(input) {
            if (rejectSteering) throw new Error("Steering unavailable")
            steered.push(input)
            return "accepted"
          },
          support: { steer: true },
        })
        firstStarted.resolve()
        try {
          await release.promise
        } finally {
          close()
        }
      } else secondStarted.resolve()
      return "Draft reply"
    })
    const agent = defineAgent({
      name: "support",
      driver: { run },
      channels: {
        support: defineChannel("support", {
          messages: false,
          triggers: {
            webhook: defineChannelTrigger({
              input: v.object({ payload: v.object({ id: v.string() }) }),
              prepare,
              invoke: (_context, { payload: { id } }) => {
                const ownership = {
                  busy: "steer",
                  concurrencyKey: "conversation",
                  concurrencyLimit: 1,
                  concurrencyTtlMs: 30_000,
                  deliveryId: id,
                } satisfies AgentWebhookInvocationOwnership
                return {
                  input: { prompt: id },
                  run: { runId: id },
                  webhook: {
                    ...ownership,
                    ...(rehydrate
                      ? {
                          rehydrate: () => ({
                            input: { prompt: id },
                            run: { runId: id },
                            webhook: ownership,
                          }),
                        }
                      : {}),
                  },
                }
              },
            }),
          },
          webhooks: { path: "/support", secretToken: false },
        }),
      },
    })
    const handler = createChannelWebhookRouteHandler(agent)
    const pending: Promise<unknown>[] = []
    const options = {
      agentName: "support",
      webhookState: state,
      waitUntil: (task: Promise<unknown>) => {
        pending.push(task)
      },
    }
    const stop = handler.resume(options)
    const send = (id: string) =>
      handler(
        new Request("https://example.com/support", {
          method: "POST",
          body: JSON.stringify({ id }),
          headers: { "content-type": "application/json" },
        }),
        "support",
        options,
      )
    try {
      const first = await send("first")
      expect(first.status).toBe(200)
      await expect(first.json()).resolves.toMatchObject({ queued: true })
      await firstStarted.promise
      expect(inputs[0]?.prompt).toBe("first:prepared")
      expect(prepare).toHaveBeenCalledOnce()

      await expect((await send("second")).json()).resolves.toMatchObject({ steered: true })
      await expect((await send("second")).json()).resolves.toMatchObject({ duplicate: true })
      expect(steered.map((input) => input.prompt)).toEqual(["second"])
      expect(prepare).toHaveBeenCalledOnce()

      rejectSteering = true
      await expect((await send("third")).json()).resolves.toMatchObject({ queued: true })
      expect(prepare).toHaveBeenCalledOnce()
      release.resolve()
      await secondStarted.promise
      expect(inputs.map((input) => input.prompt)).toEqual(["first:prepared", "third:prepared"])
      expect(prepare).toHaveBeenCalledTimes(2)
    } finally {
      release.resolve()
      await stop()
      await Promise.all(pending)
      await state.disconnect()
      await rm(dir, { force: true, recursive: true })
    }
  },
  15_000,
)

it("rejects webhook steering into a named task", async () => {
  const { github } = await import("../src/channels.ts")
  const run = vi.fn()
  const prepare = vi.fn()
  const agent = defineAgent({
    channels: {
      github: github({
        triggers: {
          webhook: {
            tasks: { mirror: { prepare, run } },
            invoke: () => ({
              task: "mirror",
              input: { prompt: "mirror" },
              webhook: {
                busy: "steer",
                concurrencyKey: "thread",
                concurrencyLimit: 1,
                deliveryId: "task",
              },
            }),
          },
        },
        webhooks: { secretToken: false },
      }),
    },
    driver: { run },
  })
  const handler = createChannelWebhookRouteHandler(agent)
  const response = await handler(
    new Request("https://example.com/api/github/webhook", {
      body: "{}",
      headers: { "content-type": "application/json", "x-github-event": "pull_request" },
      method: "POST",
    }),
    "github",
  )
  expect(response.status).toBe(500)
  await expect(response.json()).resolves.toMatchObject({
    message: 'Webhook busy: "steer" sends input to a running Invocation. It does not run a task.',
  })
  expect(prepare).not.toHaveBeenCalled()
  expect(run).not.toHaveBeenCalled()
})
