import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"

import { describe, expect, it, vi } from "vitest"

import { listViteHubDevtoolsFeatures } from "@vite-hub/devtools"
import { discoverAgentDefinitions } from "../src/discovery.ts"

import type { IncomingMessage, ServerResponse } from "node:http"
import type { Connect } from "vite"

async function createTempRoot(prefix: string) {
  return await mkdtemp(join(tmpdir(), prefix))
}

function textFromUiMessage(message: { parts?: Array<Record<string, unknown>> } | undefined) {
  return (message?.parts || [])
    .filter(part => part.type === "text" && typeof part.text === "string")
    .map(part => part.text)
    .join("")
}

function responseChunkText(chunk: unknown) {
  if (typeof chunk === "string") return chunk
  if (Buffer.isBuffer(chunk)) return chunk.toString("utf8")
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString("utf8")
  return String(chunk)
}

function createFakeServer(root: string, module: unknown) {
  const handlers: Connect.NextHandleFunction[] = []
  const server = {
    config: {
      root,
      server: { port: 3000 },
    },
    middlewares: {
      use: vi.fn((handler: Connect.NextHandleFunction) => {
        handlers.push(handler)
      }),
    },
    resolvedUrls: {
      local: ["http://localhost:3000/"],
    },
    ssrLoadModule: vi.fn(async () => module),
  }
  return { handlers, server }
}

async function configurePluginServer(plugin: { configureServer?: unknown }, server: unknown) {
  const hook = plugin.configureServer
  if (typeof hook === "function") {
    await hook(server)
  }
  else if (hook && typeof hook === "object" && "handler" in hook && typeof hook.handler === "function") {
    await hook.handler(server)
  }
}

async function invokeMiddleware(
  handler: Connect.NextHandleFunction,
  body: Record<string, unknown>,
  url = "/__vitehub/agent/chat/devtools",
) {
  let output = ""
  const req = Readable.from([JSON.stringify(body)]) as IncomingMessage
  req.headers = { "content-type": "text/plain" }
  req.method = "POST"
  req.url = url

  const result = await new Promise<{ body: string, statusCode: number }>((resolve, reject) => {
    let statusCode = 200
    const res = {
      destroy(error?: Error) {
        reject(error || new Error("response destroyed"))
      },
      end(chunk?: unknown) {
        if (chunk) output += responseChunkText(chunk)
        resolve({ body: output, statusCode })
      },
      get statusCode() {
        return statusCode
      },
      set statusCode(value: number) {
        statusCode = value
      },
      setHeader: vi.fn(),
      write(chunk: unknown) {
        output += responseChunkText(chunk)
        return true
      },
    } as unknown as ServerResponse

    handler(req, res, () => reject(new Error("middleware passed through")))
  })

  return result
}

describe("agent discovery", () => {
  it("discovers Vite suffix agents without scanning server files", async () => {
    const root = await createTempRoot("vitehub-agent-vite-")
    await mkdir(join(root, "src"), { recursive: true })
    await mkdir(join(root, "server"), { recursive: true })
    await writeFile(join(root, "src", "triager.agent.ts"), "export default {}", "utf8")
    await writeFile(join(root, "server", "ignored.agent.ts"), "export default {}", "utf8")

    expect(discoverAgentDefinitions({ rootDir: root })).toEqual([
      expect.objectContaining({
        name: "triager",
        source: "vite-suffix",
      }),
    ])
  })

  it("discovers server agent files and colocated workspace configs", async () => {
    const root = await createTempRoot("vitehub-agent-server-")
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await mkdir(join(root, "server", "agents", "docs"), { recursive: true })
    await writeFile(join(root, "server", "agents", "support.ts"), "export default {}", "utf8")
    await writeFile(join(root, "server", "agents", "docs", "config.ts"), "export default defineAgent({ workspace: {}, model })", "utf8")

    expect(discoverAgentDefinitions({
      mode: "server-agents",
      scanDirs: [join(root, "server")],
    })).toEqual([
      expect.objectContaining({ name: "docs", source: "server-agent-workspace", workspace: "docs" }),
      expect.objectContaining({ name: "support", source: "server-agents" }),
    ])
  })

  it("ignores eval definitions during server agent discovery", async () => {
    const root = await createTempRoot("vitehub-agent-server-eval-")
    await mkdir(join(root, "server", "agents", "support"), { recursive: true })
    await writeFile(join(root, "server", "agents", "support", "config.ts"), "export default defineAgent({ workspace: {}, model })", "utf8")
    await writeFile(join(root, "server", "agents", "support", "config.eval.ts"), "export default defineEval({})", "utf8")
    await writeFile(join(root, "server", "agents", "support", "eval.ts"), "export default defineEval({})", "utf8")
    await writeFile(join(root, "server", "agents", "support.eval.ts"), "export default defineEval({})", "utf8")

    expect(discoverAgentDefinitions({
      mode: "server-agents",
      scanDirs: [join(root, "server")],
    })).toEqual([
      expect.objectContaining({ name: "support", source: "server-agent-workspace", workspace: "support" }),
    ])
  })

  it("uses folder identity for colocated workspace agents", async () => {
    const root = await createTempRoot("vitehub-agent-workspace-name-")
    await mkdir(join(root, "server", "agents", "docs"), { recursive: true })
    await writeFile(join(root, "server", "agents", "docs", "config.ts"), "export default defineAgent({ workspace: {}, name: 'context', model })", "utf8")

    expect(discoverAgentDefinitions({
      mode: "server-agents",
      scanDirs: [join(root, "server")],
    })).toEqual([
      expect.objectContaining({ name: "docs", source: "server-agent-workspace", workspace: "docs" }),
    ])
  })

  it("throws on duplicate server agent names", async () => {
    const root = await createTempRoot("vitehub-agent-duplicate-")
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await writeFile(join(root, "server", "agents", "support.ts"), "export default {}", "utf8")
    await writeFile(join(root, "server", "agents", "support.js"), "export default {}", "utf8")

    expect(() => discoverAgentDefinitions({
      mode: "server-agents",
      scanDirs: [join(root, "server")],
    })).toThrow("Duplicate agent name")
  })
})

describe("agent chat capability discovery", () => {
  it("discovers chat-capable agents through normal Agent discovery", async () => {
    const root = await createTempRoot("vitehub-agent-chat-identity-")
    await mkdir(join(root, "server", "agents", "docs"), { recursive: true })
    await writeFile(join(root, "server", "agents", "support.ts"), [
      "import { defineAgent } from '@vite-hub/agent'",
      "import { chat } from '@vite-hub/agent/capabilities'",
      "export default defineAgent({",
      "  name: 'renamed-support',",
      "  capabilities: [chat({ concurrency: 'queue', events: ['directMessage'] })],",
      "})",
    ].join("\n"), "utf8")
    await writeFile(join(root, "server", "agents", "docs", "config.ts"), [
      "import { defineAgent } from '@vite-hub/agent'",
      "import { chat } from '@vite-hub/agent/capabilities'",
      "export default defineAgent({",
      "  name: 'renamed-docs',",
      "  workspace: {},",
      "  capabilities: [chat({ concurrency: 'queue', events: ['directMessage'] })],",
      "})",
    ].join("\n"), "utf8")
    await writeFile(join(root, "server", "agent.ts"), [
      "import { defineAgent } from '@vite-hub/agent'",
      "import { chat } from '@vite-hub/agent/capabilities'",
      "export const legacy = defineAgent({ capabilities: [chat({ concurrency: 'queue', events: ['directMessage'] })] })",
    ].join("\n"), "utf8")

    expect(discoverAgentDefinitions({
      mode: "server-agents",
      scanDirs: [join(root, "server")],
    })).toEqual([
      expect.objectContaining({ name: "docs", source: "server-agent-workspace", workspace: "docs" }),
      expect.objectContaining({ name: "support", source: "server-agents" }),
    ])
  })

  it("registers the chat devtools feature through hubAgent by default", async () => {
    const plugin = (await import("../src/vite.ts")).hubAgent()
    const ctx = {
      messages: {
        add: vi.fn(),
      },
      rpc: {
        register: vi.fn(),
      },
    }

    await plugin.devtools?.setup?.(ctx as never)

    expect(listViteHubDevtoolsFeatures(ctx as never)).toEqual([
      {
        bridge: "/__vitehub/agent/chat/devtools",
        icon: "ph:chat-circle-duotone",
        id: "agent.chat",
        packageName: "@vite-hub/agent",
        title: "Chat",
      },
    ])
    expect(ctx.rpc.register).toHaveBeenCalledTimes(3)
  })

  it("serves chat devtools state and send requests from the Vite bridge", async () => {
    const root = await createTempRoot("vitehub-agent-devtools-bridge-")
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await writeFile(join(root, "server", "agents", "support.ts"), "export default {}", "utf8")

    const { access, chat } = await import("../src/capabilities.ts")
    const { defineAgent, defineCapability, withWorkspaceAgentDefaults } = await import("../src/index.ts")
    const supportAudience = defineCapability({
      id: "support-audience",
      prepare(context) {
        context.instructions.add(`Audience resolved for ${context.invoker.meta?.audience}.`, { aliases: ["audience"] })
      },
    })
    const agent = withWorkspaceAgentDefaults(defineAgent({
      invoker: {
        profiles: [
          { id: "support-customer", kind: "customer", label: "Customer", meta: { audience: "customer", scope: "customer" } },
          { id: "support-technical", kind: "technical", label: "Technical", meta: { audience: "technical", scope: "support" } },
        ],
      },
      capabilities: [
        access({
          workspace: {
            resolve({ invoker }) {
              return invoker.meta?.scope === "support"
                ? { role: "admin", scope: "support" }
                : { role: "viewer", scope: "customer" }
            },
            scopes: {
              customer: { paths: ["customers/acme"] },
              support: { all: true },
            },
          },
        }),
        supportAudience,
        chat(),
      ],
      instructions: "# Support\n\n{{ capabilities.support-audience }}",
      workspace: {},
      run: (context: { invoker: { kind?: string }, workspace?: unknown }) => `answered as ${context.invoker.kind} with ${context.workspace ? "workspace" : "no workspace"}`,
    }), { workspace: "support" })
    const { handlers, server } = createFakeServer(root, { default: agent })
    const plugin = (await import("../src/vite.ts")).hubAgent()

    await configurePluginServer(plugin, server)
    expect(server.middlewares.use).toHaveBeenCalledTimes(1)

    const stateResponse = await invokeMiddleware(handlers[0]!, { action: "get-state", invokerProfileId: "support-technical" })
    const state = JSON.parse(stateResponse.body)
    expect(state).toMatchObject({
      chats: [{ name: "support", uiMessages: [] }],
      instructions: ["# Support\n\nAudience resolved for technical."],
      invokerProfiles: [
        { id: "support-customer", kind: "customer", label: "Customer" },
        { id: "support-technical", kind: "technical", label: "Technical" },
      ],
      selected: "support",
    })

    const sendResponse = await invokeMiddleware(handlers[0]!, {
      action: "send",
      chat: "support",
      invokerProfileId: "support-technical",
      stream: true,
      text: "hello",
    })
    const events = sendResponse.body
      .trim()
      .split("\n")
      .map(line => JSON.parse(line))
    const finalState = events.filter(event => event.type === "state").at(-1)?.state

    expect(events.at(-1)).toEqual({ type: "done" })
    expect(finalState.selected).toBe("support")
    expect(finalState.uiMessages.map((message: { role: string }) => message.role)).toEqual(["user", "assistant"])
    expect(finalState.invokerProfileId).toBe("support-technical")
    expect(textFromUiMessage(finalState.uiMessages[1])).toBe("answered as technical with workspace")
  })

  it("omits unfinished tool-call assistant messages from devtools prompt history", async () => {
    const { createChatDevtoolsPromptHistory } = await import("../src/chat/vite/devtools-bridge.ts")
    const history = createChatDevtoolsPromptHistory([
      {
        id: "user-1",
        parts: [{ text: "first", type: "text" }],
        role: "user",
      },
      {
        id: "assistant-partial",
        parts: [{ input: { command: "rg forecast" }, state: "input-available", toolCallId: "call-1", type: "tool-shell" }],
        role: "assistant",
      },
      {
        id: "assistant-complete",
        metadata: { completedAt: "2026-06-03T08:00:00.000Z" },
        parts: [
          { input: { command: "rg forecast" }, output: { stdout: "ok" }, state: "output-available", toolCallId: "call-2", type: "tool-shell" },
          { text: "done", type: "text" },
        ],
        role: "assistant",
      },
    ])

    expect(history.map(message => message.id)).toEqual(["user-1", "assistant-complete"])
  })

  it("skips chat devtools feature and bridge when package-local devtools are disabled", async () => {
    const plugin = (await import("../src/vite.ts")).hubAgent({ devtools: false })
    const ctx = {
      messages: {
        add: vi.fn(),
      },
      rpc: {
        register: vi.fn(),
      },
    }

    await plugin.devtools?.setup?.(ctx as never)

    expect(listViteHubDevtoolsFeatures(ctx as never)).toEqual([])
    expect(ctx.rpc.register).not.toHaveBeenCalled()

    const { server } = createFakeServer(await createTempRoot("vitehub-agent-devtools-disabled-"), {})
    await configurePluginServer(plugin, server)
    expect(server.middlewares.use).not.toHaveBeenCalled()
  })

})
