import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as v from "valibot"
import { defineAgent } from "@vite-hub/agent"
import { defineChannel } from "@vite-hub/agent/channels"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "@vite-hub/agent/server"
import { defineCollection } from "@vite-hub/source"

import { installConsoleAgentDefinitions } from "../src/console/runtime/server/agents.ts"
import channelReplayHandler from "../src/console/runtime/server/channel-replay.ts"

import type { ConsoleRequestEvent } from "../src/console/runtime/server/request.ts"

const messages = [{ id: "m1", subject: "Invoice" }, { id: "m2", subject: "Receipt" }]

function labeller() {
  const label = vi.fn()
  const history = defineCollection(async ({ cursor, limit }) => {
    const offset = cursor ? messages.findIndex(message => message.id === cursor) + 1 : 0
    return messages.slice(offset, offset + limit)
  }, {
    cursor: (message: { id: string }) => message.id,
    cursorSchema: v.string(),
    querySchema: v.object({ folder: v.optional(v.string()) }),
  })
  const agent = defineAgent({
    channels: {
      mailbox: defineChannel("mailbox", {
        history: { collection: history, key: message => message.id },
        message: { methods: { label: (_context, name: string) => label(name) } },
        messages: false,
        triggers: {
          received: {
            invoke: (_context, message: { id: string, subject: string }) => ({ input: { prompt: message.subject }, message: { id: message.id } }),
          },
        },
      }),
    },
    driver: { run: () => "Finance" },
    hooks: {
      async "agent:finish"(event) {
        if (event.message?.channel === "mailbox") await event.message.label(String(event.text))
      },
    },
    invocations: defineAgentInvocations({ store: createMemoryAgentInvocationStore() }),
    name: "labeller",
    runtime: false,
  })
  return { agent, label }
}

function replayEvent(body: unknown, headers: Record<string, string> = { "content-type": "application/json" }): ConsoleRequestEvent {
  return {
    method: "POST",
    req: {
      headers: new Headers(headers),
      json: async () => body,
      method: "POST",
      url: new URL("https://app.test/_vitehub/channels/replay"),
    },
  }
}

describe("Console Channel replay route", () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "vitehub-console-replay-"))
  })
  afterEach(async () => {
    await rm(root, { force: true, recursive: true })
  })

  it("describes and replays Channel history when Console invocation is enabled", async () => {
    const { agent, label } = labeller()
    installConsoleAgentDefinitions([{ definition: { default: agent }, fallbackName: "labeller" }], { invoke: true, projectRoot: root })

    const description = await channelReplayHandler(replayEvent({ agent: "labeller", channel: "mailbox", describe: true }))
    expect(description.status).toBe(200)
    await expect(description.json()).resolves.toMatchObject({ query: { properties: { folder: expect.any(Object) } }, trigger: "received" })

    const response = await channelReplayHandler(replayEvent({ agent: "labeller", channel: "mailbox", dryRun: true, limit: 5 }))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ nextCursor: null, processed: 2 })
    expect(label).not.toHaveBeenCalled()

    const live = await channelReplayHandler(replayEvent({ agent: "labeller", channel: "mailbox" }))
    await expect(live.json()).resolves.toMatchObject({ processed: 2, skipped: 0 })
    expect(label.mock.calls).toEqual([["Finance"], ["Finance"]])
  })

  it.each([
    { url: "/_vitehub/channels/replay", host: "app.test", origin: "https://app.test" },
    { url: "http://internal:3000/_vitehub/channels/replay", host: "app.test", origin: "https://app.test" },
    { url: "http://internal:3000/_vitehub/channels/replay", host: "app.test:8443", origin: "https://app.test:8443" },
  ])("accepts public origin $origin for request URL $url", async ({ url, host, origin }) => {
    const { agent } = labeller()
    installConsoleAgentDefinitions([{ definition: { default: agent }, fallbackName: "labeller" }], { invoke: true, projectRoot: root })
    const event = replayEvent({ agent: "labeller", channel: "mailbox", describe: true }, {
      "content-type": "application/json", origin, host: "internal:3000", "x-forwarded-host": host, "x-forwarded-proto": "https",
    })
    event.req!.url = url
    expect((await channelReplayHandler(event)).status).toBe(200)
    event.req!.headers = new Headers({ "content-type": "application/json", origin: "https://evil.test", host: "app.test", "x-forwarded-proto": "https" })
    expect((await channelReplayHandler(event)).status).toBe(403)
  })

  it("accepts a path-only Nitro Node request with host and forwarded protocol headers", async () => {
    const { agent } = labeller()
    installConsoleAgentDefinitions([{ definition: { default: agent }, fallbackName: "labeller" }], { invoke: true, projectRoot: root })
    const event: ConsoleRequestEvent = {
      node: { req: { method: "POST", url: "/_vitehub/channels/replay", headers: { "content-type": "application/json", host: "app.test", origin: "https://app.test", "x-forwarded-proto": "https" } } },
      req: { json: async () => ({ agent: "labeller", channel: "mailbox", describe: true }) },
    }
    expect((await channelReplayHandler(event)).status).toBe(200)
  })

  it("stays unavailable while Console invocation is disabled", async () => {
    const { agent } = labeller()
    installConsoleAgentDefinitions([{ definition: { default: agent }, fallbackName: "labeller" }], { projectRoot: root })
    const response = await channelReplayHandler(replayEvent({ agent: "labeller", channel: "mailbox" }))
    expect(response.status).toBe(404)
  })

  it("rejects cross-site and malformed requests before replay", async () => {
    const { agent, label } = labeller()
    installConsoleAgentDefinitions([{ definition: { default: agent }, fallbackName: "labeller" }], { invoke: true, projectRoot: root })
    const body = { agent: "labeller", channel: "mailbox" }

    expect((await channelReplayHandler(replayEvent(body, { "content-type": "application/json", origin: "https://evil.test" }))).status).toBe(403)
    expect((await channelReplayHandler(replayEvent(body, { "content-type": "text/plain" }))).status).toBe(415)
    expect((await channelReplayHandler(replayEvent({ channel: "mailbox" }))).status).toBe(400)
    expect((await channelReplayHandler(replayEvent({ ...body, query: { folder: 1 } }))).status).toBe(400)
    expect((await channelReplayHandler({ ...replayEvent(body), method: "GET" })).status).toBe(405)
    expect(label).not.toHaveBeenCalled()
  })
})
