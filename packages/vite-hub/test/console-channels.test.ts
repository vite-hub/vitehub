import { afterEach, describe, expect, it } from "vitest"

import { agentChannelOperations } from "@vite-hub/agent/operations"
import { installChannelsConsoleHost } from "@vite-hub/agent/server/internal"

import { consoleOperationCall } from "../src/console/runtime/client/request.ts"
import { consoleRpcHeader } from "../src/console/runtime/rpc.ts"
import { consoleSectionDetails, resolveConsoleSectionIds } from "../src/console/runtime/sections.ts"
import { installConsoleAccess } from "../src/console/runtime/server/access.ts"
import { installConsoleOperations } from "../src/console/runtime/server/operation-contributions.ts"
import consoleRpcHandler from "../src/console/runtime/server/rpc.ts"

const retention = { durable: false, maxMessages: 100, transcripts: false, ttlMs: 604_800_000 }
const message = { attachments: [], author: { fullName: "Maxi", isMe: false, userId: "1" }, id: "1", metadata: { dateSent: "2026-06-10T12:00:00.000Z" }, role: "user", source: "provider", text: "hello", threadId: "telegram:1" }

// A handler that answers like the webhook handler of one Agent with one Telegram Channel.
const handler = {
  channels: async () => [{ conversations: true, id: "telegram", origin: "telegram", provider: "telegram", retention }],
  conversation: async () => ({ agent: "support", channel: "telegram", messages: [message], provider: "telegram", retention, threadId: "telegram:1" }),
}

function install() {
  // SAFETY: The test host has the members of the webhook handler that the operations call.
  installChannelsConsoleHost({ agents: { support: {} as never }, handlers: { support: handler as never }, options: () => ({}) })
  installConsoleOperations([{ operations: agentChannelOperations, plugin: "agent" }])
}

function rpc(operation: string, input: unknown = {}) {
  return consoleRpcHandler.fetch(new Request("http://vitehub.local/_vitehub/rpc/__call", {
    body: JSON.stringify({ input, operation }),
    headers: { "content-type": "application/json", [consoleRpcHeader]: "1" },
    method: "POST",
  }))
}

afterEach(() => {
  installConsoleAccess({ mode: "open" })
  installConsoleOperations([])
})

describe("Channels section", () => {
  it("is a section of every Console with an Agent, next to Agents and Usage", () => {
    expect(resolveConsoleSectionIds({ agent: true, workflow: false })).toEqual(["agents", "usage", "channels"])
    expect(consoleSectionDetails.channels).toMatchObject({ label: "Channels", routeName: "vitehub-console-channels" })
  })

  it("maps the page requests to the operations", () => {
    const call = (route: string, query: Record<string, string>) => consoleOperationCall(`/api/_vitehub/console/${route}`, { method: "GET", query })
    expect(call("channels", {})).toEqual({ input: {}, operation: "channels.list" })
    expect(call("channels/threads", { agent: "support", channel: "telegram", cursor: "25" })).toEqual({ input: { agent: "support", channel: "telegram", cursor: "25" }, operation: "channels.threads" })
    expect(call("channels/conversation", { agent: "support", channel: "telegram", thread: "telegram:1" }).operation).toBe("channels.conversation")
    expect(call("channels/export", { agent: "support", channel: "telegram", format: "json", media: "true", thread: "telegram:1" })).toEqual({
      input: { agent: "support", channel: "telegram", format: "json", media: true, thread: "telegram:1" },
      operation: "conversations.export",
    })
  })

  it("serves the operations to the people whose sections include channels", async () => {
    install()
    installConsoleAccess({ authorize: () => ({ sections: ["channels"] }), mode: "open" })
    const list = await rpc("channels.list")
    expect(list.status).toBe(200)
    await expect(list.json()).resolves.toMatchObject({ ok: true, value: { channels: [{ agent: "support", channel: "telegram", provider: "telegram", retention: { mode: "provider-window", warning: expect.stringContaining("not durable") } }] } })
    const conversation = await rpc("channels.conversation", { agent: "support", channel: "telegram", thread: "telegram:1" })
    await expect(conversation.json()).resolves.toMatchObject({ ok: true, value: { messageCount: 1, messages: [{ at: "2026-06-10T12:00:00.000Z", author: { id: "1", name: "Maxi" }, text: "hello" }] } })
    const exported = await rpc("conversations.export", { agent: "support", channel: "telegram", format: "markdown", thread: "telegram:1" })
    // SAFETY: The test reads the text of the export result.
    const body = await exported.json() as unknown as { value: { text: string } }
    expect(body.value.text).toContain("### Maxi · 2026-06-10 12:00:00 UTC")
  })

  it("refuses them to people whose sections leave channels out", async () => {
    install()
    installConsoleAccess({ authorize: () => ({ sections: ["agents"] }), mode: "open" })
    for (const [operation, input] of [["channels.list", {}], ["channels.threads", { agent: "support", channel: "telegram" }], ["channels.conversation", { agent: "support", channel: "telegram", thread: "t" }], ["conversations.export", { agent: "support", channel: "telegram", thread: "t" }]] as const) {
      const response = await rpc(operation, input)
      expect(response.status, operation).toBe(403)
    }
  })

  it("answers CHANNELS_HOST_UNAVAILABLE until the webhook routes have started", async () => {
    installConsoleOperations([{ operations: agentChannelOperations, plugin: "agent" }])
    Reflect.deleteProperty(globalThis, Symbol.for("vitehub.agent.channels-console"))
    const response = await rpc("channels.list")
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({ code: "CHANNELS_HOST_UNAVAILABLE", fix: expect.stringContaining("libSQL") })
  })
})
