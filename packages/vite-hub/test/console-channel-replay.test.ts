import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as v from "valibot"
import { defineAgent } from "@vite-hub/agent"
import { channelAdapter } from "@vite-hub/agent/channels"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "@vite-hub/agent/server"
import { defineCollection } from "@vite-hub/source"

import { installConsoleAgentDefinitions } from "../src/console/runtime/server/agents.ts"
import { installConsoleAccess } from "../src/console/runtime/server/access.ts"
import { consoleRpcHeader } from "../src/console/runtime/rpc.ts"

import type { AgentRunContext } from "@vite-hub/agent"
import { handleConsoleRpcRequest } from "./support/console-rpc.ts"
import { signedConsoleAccess } from "./support/console-signature.ts"
import { operationRpcBody, operationRpcResponseResult } from "../../internal/test-utils/operation-rpc.ts"

const messages = [{ id: "m1", subject: "Invoice" }, { id: "m2", subject: "Receipt" }]

function labeller() {
  const label = vi.fn()
  let runContext: AgentRunContext | undefined
  const history = defineCollection(async ({ cursor, limit }) => {
    const offset = cursor ? messages.findIndex(message => message.id === cursor) + 1 : 0
    return messages.slice(offset, offset + limit)
  }, {
    route: false,
    cursor: (message: { id: string }) => message.id,
    cursorSchema: v.string(),
    querySchema: v.object({ folder: v.optional(v.string()) }),
  })
  const agent = defineAgent({
    channels: {
      mailbox: channelAdapter("mailbox", {
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
    driver: { run: (context: AgentRunContext) => { runContext = context; return "Finance" } },
    hooks: {
      async "agent:finish"(event) {
        if (event.message?.channel === "mailbox") await event.message.label(String(event.text))
      },
    },
    invocations: defineAgentInvocations({ store: createMemoryAgentInvocationStore() }),
    name: "labeller",
    runtime: false,
  })
  return { agent, label, get runContext() { return runContext } }
}

/** One `channels.replay` call through the Console RPC. */
async function replay(input: unknown, headers: Record<string, string> = {}, sign: (request: Request) => Promise<Request> = async request => request): Promise<{ body: Record<string, unknown>, status: number }> {
  const response = await handleConsoleRpcRequest(await sign(new Request("https://app.test/_vitehub/rpc", {
    body: operationRpcBody("channels.replay", input),
    headers: { "content-type": "application/json", [consoleRpcHeader]: "1", ...headers },
    method: "POST",
  })))
  return { body: Object(await operationRpcResponseResult(response)), status: response.status }
}

describe("Console Channel replay operation", () => {
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

    const description = await replay({ agent: "labeller", channel: "mailbox", describe: true })
    expect(description.status).toBe(200)
    expect(description.body).toMatchObject({ ok: true, value: { query: { properties: { folder: expect.any(Object) } }, trigger: "received" } })

    const dryRun = await replay({ agent: "labeller", channel: "mailbox", dryRun: true, limit: 5 })
    expect(dryRun).toMatchObject({ body: { ok: true, value: { nextCursor: null, processed: 2 } }, status: 200 })
    expect(label).not.toHaveBeenCalled()

    const live = await replay({ agent: "labeller", channel: "mailbox" })
    expect(live.body).toMatchObject({ ok: true, value: { processed: 2, skipped: 0 } })
    expect(label.mock.calls).toEqual([["Finance"], ["Finance"]])
  })

  it("passes the verified Console user and request headers to Channel replay", async () => {
    const fixture = labeller()
    installConsoleAgentDefinitions([{ definition: { default: fixture.agent }, fallbackName: "labeller" }], { invoke: true, projectRoot: root })
    const signer = await signedConsoleAccess()
    try {
      const result = await replay({ agent: "labeller", channel: "mailbox" }, { cookie: "session=verified" }, request => signer.sign(request, { id: "console-user" }))
      expect(result).toMatchObject({ body: { ok: true, value: { processed: 2 } }, status: 200 })
      expect(fixture.runContext?.request?.headers.get("cookie")).toBe("session=verified")
      expect(fixture.runContext?.invoker).toMatchObject({ id: "console-user", kind: "authUser" })
    }
    finally {
      signer.restore()
      installConsoleAccess({ mode: "open" })
    }
  })

  it("stays unavailable while Console invocation is disabled", async () => {
    const { agent } = labeller()
    installConsoleAgentDefinitions([{ definition: { default: agent }, fallbackName: "labeller" }], { projectRoot: root })
    const result = await replay({ agent: "labeller", channel: "mailbox" })
    expect(result).toMatchObject({ body: { message: expect.stringContaining("Enable Console invocation"), ok: false }, status: 404 })
  })

  it("keeps the code of an Agent failure", async () => {
    const { agent } = labeller()
    installConsoleAgentDefinitions([{ definition: { default: agent }, fallbackName: "labeller" }], { invoke: true, projectRoot: root })
    const result = await replay({ agent: "labeller", channel: "missing" })
    expect(result).toMatchObject({ body: { code: "AGENT_R0931", ok: false }, status: 404 })
  })

  it("rejects cross-site and malformed calls before replay", async () => {
    const { agent, label } = labeller()
    installConsoleAgentDefinitions([{ definition: { default: agent }, fallbackName: "labeller" }], { invoke: true, projectRoot: root })
    const body = { agent: "labeller", channel: "mailbox" }

    expect((await replay(body, { origin: "https://evil.test" })).status).toBe(403)
    expect((await replay({ channel: "mailbox" })).status).toBe(400)
    expect((await replay({ ...body, query: { folder: 1 } })).status).toBe(400)
    expect((await replay({ ...body, unknown: true })).status).toBe(400)
    expect(label).not.toHaveBeenCalled()
  })
})
