import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"

import { describe, expect, it, vi } from "vitest"

import { listViteHubDevtoolsFeatures } from "@vite-hub/devtools"
import { discoverAgentDefinitions } from "../src/discovery.ts"
import { getMessageText } from "../src/messages.ts"

import type { IncomingMessage, ServerResponse } from "node:http"
import type { Connect } from "vite"
import type { AgentRunInput } from "../src/index.ts"

const { withAgentDefaults } = await import("../src/index.ts")

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
  headers: IncomingMessage["headers"] = { "content-type": "text/plain" },
  method = "POST",
) {
  let output = ""
  const req = Readable.from([JSON.stringify(body)]) as IncomingMessage
  req.headers = headers
  req.method = method
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
      off: vi.fn(),
      once: vi.fn(),
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

async function invokeState(handler: Connect.NextHandleFunction, body: Record<string, unknown>) {
  return JSON.parse((await invokeMiddleware(handler, body)).body) as Record<string, unknown>
}

async function waitForMetadataState(
  handler: Connect.NextHandleFunction,
  body: Record<string, unknown>,
  status: "error" | "loading" | "ready" = "ready",
) {
  let latest: Record<string, unknown> | undefined
  for (let attempt = 0; attempt < 50; attempt++) {
    latest = await invokeState(handler, body)
    if (latest.metadataStatus === status) return latest
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  throw new Error(`Expected chat devtools metadata status ${status}, received ${String(latest?.metadataStatus)}`)
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

  it("ignores helper files inside configured server agents", async () => {
    const root = await createTempRoot("vitehub-agent-server-helpers-")
    await mkdir(join(root, "server", "agents", "chat", "workspace"), { recursive: true })
    await mkdir(join(root, "server", "agents", "review"), { recursive: true })
    await writeFile(join(root, "server", "agents", "chat", "config.ts"), "export default defineAgent({ workspace: {}, model })", "utf8")
    await writeFile(join(root, "server", "agents", "chat", "access.ts"), "export const access = {}", "utf8")
    await writeFile(join(root, "server", "agents", "chat", "audience.test.ts"), "export const test = {}", "utf8")
    await writeFile(join(root, "server", "agents", "chat", "prompts.ts"), "export default { system: 'help' }", "utf8")
    await writeFile(join(root, "server", "agents", "chat", "workspace", "config.ts"), "export const sources = {}", "utf8")
    await writeFile(join(root, "server", "agents", "review", "config.ts"), "export default defineAgent({ model })", "utf8")

    expect(discoverAgentDefinitions({
      mode: "server-agents",
      scanDirs: [join(root, "server")],
    })).toEqual([
      expect.objectContaining({ name: "chat", source: "server-agent-workspace", workspace: "chat" }),
      expect.objectContaining({ name: "review", source: "server-agents" }),
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

  it("discovers nested agents named workspace when no parent agent owns the source root", async () => {
    const root = await createTempRoot("vitehub-agent-nested-workspace-")
    await mkdir(join(root, "server", "agents", "team", "workspace"), { recursive: true })
    await writeFile(join(root, "server", "agents", "team", "workspace", "config.ts"), "export default defineAgent({ workspace: {}, model })", "utf8")

    expect(discoverAgentDefinitions({
      mode: "server-agents",
      scanDirs: [join(root, "server")],
    })).toEqual([
      expect.objectContaining({ name: "team/workspace", source: "server-agent-workspace", workspace: "team/workspace" }),
    ])
  })

  it("discovers nested agents named workspace below plain config agents", async () => {
    const root = await createTempRoot("vitehub-agent-plain-parent-workspace-")
    await mkdir(join(root, "server", "agents", "team", "workspace"), { recursive: true })
    await writeFile(join(root, "server", "agents", "team", "config.ts"), "export default defineAgent({ run: () => 'ok' })", "utf8")
    await writeFile(join(root, "server", "agents", "team", "workspace", "config.ts"), "export default defineAgent({ workspace: {}, model })", "utf8")

    expect(discoverAgentDefinitions({
      mode: "server-agents",
      scanDirs: [join(root, "server")],
    })).toEqual([
      expect.objectContaining({ name: "team", source: "server-agents", workspace: undefined }),
      expect.objectContaining({ name: "team/workspace", source: "server-agent-workspace", workspace: "team/workspace" }),
    ])
  })

  it("discovers nested file agents below configured agents", async () => {
    const root = await createTempRoot("vitehub-agent-nested-file-agent-")
    await mkdir(join(root, "server", "agents", "team"), { recursive: true })
    await writeFile(join(root, "server", "agents", "team", "config.ts"), "export default defineAgent({ workspace: {}, model })", "utf8")
    await writeFile(join(root, "server", "agents", "team", "access.ts"), "export const access = {}", "utf8")
    await writeFile(join(root, "server", "agents", "team", "review.ts"), "export default defineAgent({ model })", "utf8")

    const definitions = discoverAgentDefinitions({
      mode: "server-agents",
      scanDirs: [join(root, "server")],
    })

    expect(definitions).toHaveLength(2)
    expect(definitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "team", source: "server-agent-workspace", workspace: "team" }),
      expect.objectContaining({ name: "team/review", source: "server-agents" }),
    ]))
  })

  it("discovers nested re-exported file agents below configured agents", async () => {
    const root = await createTempRoot("vitehub-agent-nested-reexport-agent-")
    await mkdir(join(root, "server", "agents", "team"), { recursive: true })
    await writeFile(join(root, "server", "agents", "team", "config.ts"), "export default defineAgent({ workspace: {}, model })", "utf8")
    await writeFile(join(root, "server", "agents", "team", "prompts.ts"), "export default { system: 'help' }", "utf8")
    await writeFile(join(root, "server", "agents", "team", "review.ts"), "export { default } from './review-agent'", "utf8")

    const definitions = discoverAgentDefinitions({
      mode: "server-agents",
      scanDirs: [join(root, "server")],
    })

    expect(definitions).toHaveLength(2)
    expect(definitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "team", source: "server-agent-workspace", workspace: "team" }),
      expect.objectContaining({ name: "team/review", source: "server-agents" }),
    ]))
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

  it("throws when a configured server agent also has an index definition", async () => {
    const root = await createTempRoot("vitehub-agent-config-index-duplicate-")
    await mkdir(join(root, "server", "agents", "support"), { recursive: true })
    await writeFile(join(root, "server", "agents", "support", "config.ts"), "export default defineAgent({ workspace: {}, model })", "utf8")
    await writeFile(join(root, "server", "agents", "support", "index.ts"), "export default defineAgent({ model })", "utf8")

    expect(() => discoverAgentDefinitions({
      mode: "server-agents",
      scanDirs: [join(root, "server")],
    })).toThrow("Duplicate agent name")
  })

  it("throws when a nested configured server agent also has an index definition", async () => {
    const root = await createTempRoot("vitehub-agent-nested-config-index-duplicate-")
    await mkdir(join(root, "server", "agents", "team", "review"), { recursive: true })
    await writeFile(join(root, "server", "agents", "team", "config.ts"), "export default defineAgent({ workspace: {}, model })", "utf8")
    await writeFile(join(root, "server", "agents", "team", "review", "config.ts"), "export default defineAgent({ workspace: {}, model })", "utf8")
    await writeFile(join(root, "server", "agents", "team", "review", "index.ts"), "export default defineAgent({ model })", "utf8")

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
    const { defineAgent } = await import("../src/index.ts")
    const devtoolsMeta = { email: "maximo@quiver.dk" }
    const technicalEmails = new Set(["maximo@quiver.dk"])
    const agent = withAgentDefaults(defineAgent({
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
              const email = typeof invoker.meta?.email === "string" ? invoker.meta.email.toLowerCase() : undefined
              return invoker.meta?.scope === "support" || (email && technicalEmails.has(email))
                ? { role: "admin", scope: "support" }
                : { role: "viewer", scope: "customer" }
            },
            scopes: {
              customer: { instructions: "Audience resolved for customer.", paths: ["customers/acme"] },
              support: { all: true, instructions: "Audience resolved for technical." },
            },
          },
        }),
        chat(),
      ],
      instructions: "# Support\n\n{{ capabilities.access.workspace }}",
      workspace: {},
      run: (context: { invoker: { kind?: string, meta?: Record<string, unknown> }, workspace?: unknown }) => {
        const email = typeof context.invoker.meta?.email === "string" ? `:${context.invoker.meta.email}` : ""
        return `answered as ${context.invoker.kind}${email} with ${context.workspace ? "workspace" : "no workspace"}`
      },
    }), { workspace: "support" })
    const { handlers, server } = createFakeServer(root, { default: agent })
    const plugin = (await import("../src/vite.ts")).hubAgent()

    await configurePluginServer(plugin, server)
    expect(server.middlewares.use).toHaveBeenCalledTimes(2)

    const state = await waitForMetadataState(handlers[0]!, { action: "get-state", invokerProfileId: "support-technical" })
    expect(state).toMatchObject({
      chats: [{ name: "support", uiMessages: [] }],
      instructions: ["# Support\n\nAudience resolved for technical."],
      metadataStatus: "ready",
      invokerProfileId: "support-technical",
      invokerProfiles: [
        { id: "support-customer", kind: "customer", label: "Customer" },
        { id: "support-technical", kind: "technical", label: "Technical" },
      ],
      selected: "support",
      title: "support",
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

    const clearedTechnicalResponse = await invokeMiddleware(handlers[0]!, {
      action: "clear",
      chat: "support",
      invokerProfileId: "support-technical",
    })
    const clearedTechnicalState = JSON.parse(clearedTechnicalResponse.body)
    expect(clearedTechnicalState).toMatchObject({
      instructions: ["# Support\n\nAudience resolved for technical."],
      invokerProfileId: "support-technical",
      selected: "support",
      uiMessages: [],
    })

    const clearedFallbackResponse = await invokeMiddleware(handlers[0]!, {
      action: "clear",
      chat: "support",
      invokerFallback: true,
      meta: devtoolsMeta,
    })
    const clearedFallbackState = JSON.parse(clearedFallbackResponse.body)
    expect(clearedFallbackState).toMatchObject({
      invokerFallback: true,
      metadataStatus: "loading",
      selected: "support",
      uiMessages: [],
    })
    expect(clearedFallbackState.invokerProfileId).toBeUndefined()
    const resolvedFallbackState = await waitForMetadataState(handlers[0]!, {
      action: "get-state",
      chat: "support",
      invokerFallback: true,
      meta: devtoolsMeta,
    })
    expect(resolvedFallbackState).toMatchObject({
      instructions: ["# Support\n\nAudience resolved for technical."],
      invokerFallback: true,
      metadataStatus: "ready",
      selected: "support",
    })
    expect(resolvedFallbackState.invokerProfileId).toBeUndefined()

    const fallbackSendResponse = await invokeMiddleware(handlers[0]!, {
      action: "send",
      chat: "support",
      invokerFallback: true,
      meta: devtoolsMeta,
      stream: true,
      text: "hello fallback",
    })
    const fallbackEvents = fallbackSendResponse.body
      .trim()
      .split("\n")
      .map(line => JSON.parse(line))
    const fallbackFinalState = fallbackEvents.filter(event => event.type === "state").at(-1)?.state

    expect(fallbackEvents.at(-1)).toEqual({ type: "done" })
    expect(fallbackFinalState.invokerFallback).toBe(true)
    expect(fallbackFinalState.invokerProfileId).toBeUndefined()
    expect(textFromUiMessage(fallbackFinalState.uiMessages[1])).toBe("answered as devtools:maximo@quiver.dk with workspace")
  })

  it("serves Agent Invocation Stream events from the Vite endpoint", async () => {
    const root = await createTempRoot("vitehub-agent-invocation-stream-")
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await writeFile(join(root, "server", "agents", "support.ts"), "export default {}", "utf8")

    const { chat } = await import("../src/capabilities.ts")
    const { defineAgent } = await import("../src/index.ts")
    const { agentInvocationStreamHeader, agentInvocationStreamHeaderValue, agentInvocationStreamRoute } = await import("../src/invocation-stream.ts")
    let abortSignal: AbortSignal | undefined
    const agent = defineAgent({
      capabilities: [chat()],
      run: ({ input }: { input: { abortSignal?: AbortSignal } }) => {
        abortSignal = input.abortSignal
        return "hello from stream"
      },
    })
    const { handlers, server } = createFakeServer(root, { default: agent })
    const plugin = (await import("../src/vite.ts")).hubAgent({ devtools: false })

    await configurePluginServer(plugin, server)

    const response = await invokeMiddleware(handlers[0]!, {
      messages: [{
        id: "user-1",
        parts: [{ text: "hello", type: "text" }],
        role: "user",
      }],
    }, agentInvocationStreamRoute, {
      "content-type": "application/json",
      [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue,
    })
    const events = response.body
      .trim()
      .split("\n")
      .map(line => JSON.parse(line))

    expect(events).toEqual([
      expect.objectContaining({ agent: "support", trigger: "chat.message", type: "start" }),
      { text: "hello from stream", type: "text-delta" },
      { type: "finish" },
      { type: "done" },
    ])
    expect(abortSignal).toBeInstanceOf(AbortSignal)
  })

  it("runs Capability CLI commands through the Vite endpoint", async () => {
    const root = await createTempRoot("vitehub-agent-invocation-stream-cli-")
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await writeFile(join(root, "server", "agents", "chat.ts"), "export default {}", "utf8")

    const { defineAgent, defineCapability } = await import("../src/index.ts")
    const { agentInvocationStreamHeader, agentInvocationStreamHeaderValue, agentInvocationStreamRoute } = await import("../src/invocation-stream.ts")
    const agent = defineAgent({
      capabilities: [
        defineCapability({
          cli: {
            commands: {
              "purchase-orders": {
                commands: {
                  list: {
                    description: "List purchase orders.",
                    output: { format: "json" },
                    run: ({ json }) => ({ json, orders: [{ id: "po_1" }] }),
                  },
                },
                description: "Purchase-order runtime data.",
              },
            },
            name: "portal",
          },
          id: "portal-runtime",
        }),
      ],
      run: () => "chat fallback",
    })
    const { handlers, server } = createFakeServer(root, { default: agent })
    const plugin = (await import("../src/vite.ts")).hubAgent({ devtools: false })

    await configurePluginServer(plugin, server)

    const response = await invokeMiddleware(handlers[0]!, {
      agent: "chat",
      cli: {
        argv: ["purchase-orders", "list", "--json"],
        name: "portal",
      },
    }, agentInvocationStreamRoute, {
      "content-type": "application/json",
      [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue,
    })

    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({
      argv: ["purchase-orders", "list", "--json"],
      capability: "portal-runtime",
      cli: "portal",
      command: "portal purchase-orders list --json",
      exitCode: 0,
      json: {
        json: true,
        orders: [{ id: "po_1" }],
      },
    })
  })

  it("bypasses output renderers for Capability CLI endpoint envelopes", async () => {
    const root = await createTempRoot("vitehub-agent-invocation-stream-cli-renderer-")
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await writeFile(join(root, "server", "agents", "chat.ts"), "export default {}", "utf8")

    const { defineAgent, defineCapability } = await import("../src/index.ts")
    const { agentInvocationStreamHeader, agentInvocationStreamHeaderValue, agentInvocationStreamRoute } = await import("../src/invocation-stream.ts")
    const renderOutput = vi.fn(() => ({ wrapped: true }))
    const agent = defineAgent({
      capabilities: [
        defineCapability({
          cli: {
            commands: {
              list: {
                output: { format: "json" },
                run: () => [{ id: "po_1" }],
              },
            },
            name: "portal",
          },
          id: "portal-runtime",
          output(context) {
            context.output.render(renderOutput)
          },
        }),
      ],
      run: () => "chat fallback",
    })
    const { handlers, server } = createFakeServer(root, { default: agent })
    const plugin = (await import("../src/vite.ts")).hubAgent({ devtools: false })

    await configurePluginServer(plugin, server)

    const response = await invokeMiddleware(handlers[0]!, {
      agent: "chat",
      cli: {
        argv: ["list", "--json"],
        name: "portal",
      },
    }, agentInvocationStreamRoute, {
      "content-type": "application/json",
      [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue,
    })

    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({
      argv: ["list", "--json"],
      capability: "portal-runtime",
      cli: "portal",
      exitCode: 0,
      json: [{ id: "po_1" }],
      stdout: "[\n  {\n    \"id\": \"po_1\"\n  }\n]\n",
    })
    expect(renderOutput).not.toHaveBeenCalled()
  })

  it("preserves handled Responses from Capability CLI invocations", async () => {
    const root = await createTempRoot("vitehub-agent-invocation-stream-cli-response-")
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await writeFile(join(root, "server", "agents", "chat.ts"), "export default {}", "utf8")

    const { defineAgent, defineCapability } = await import("../src/index.ts")
    const { agentInvocationStreamHeader, agentInvocationStreamHeaderValue, agentInvocationStreamRoute } = await import("../src/invocation-stream.ts")
    const agent = defineAgent({
      capabilities: [
        defineCapability({
          cli: {
            commands: {
              list: {
                run: () => {
                  throw new Error("CLI command should not run")
                },
              },
            },
            name: "portal",
          },
          id: "portal-runtime",
          input: () => Response.json({ reason: "blocked" }, { status: 409 }),
        }),
      ],
      run: () => "chat fallback",
    })
    const { handlers, server } = createFakeServer(root, { default: agent })
    const plugin = (await import("../src/vite.ts")).hubAgent({ devtools: false })

    await configurePluginServer(plugin, server)

    const response = await invokeMiddleware(handlers[0]!, {
      agent: "chat",
      cli: {
        argv: ["list"],
        name: "portal",
      },
    }, agentInvocationStreamRoute, {
      "content-type": "application/json",
      [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue,
    })

    expect(response.statusCode).toBe(409)
    expect(JSON.parse(response.body)).toEqual({ reason: "blocked" })
  })

  it("enforces Capability CLI invocation timeouts", async () => {
    const root = await createTempRoot("vitehub-agent-invocation-stream-cli-timeout-")
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await writeFile(join(root, "server", "agents", "chat.ts"), "export default {}", "utf8")

    const { defineAgent, defineCapability } = await import("../src/index.ts")
    const { agentInvocationStreamHeader, agentInvocationStreamHeaderValue, agentInvocationStreamRoute } = await import("../src/invocation-stream.ts")
    const agent = defineAgent({
      capabilities: [
        defineCapability({
          cli: {
            commands: {
              slow: {
                run: () => new Promise(() => {}) as never,
              },
            },
            name: "portal",
          },
          id: "portal-runtime",
        }),
      ],
      run: () => "chat fallback",
    })
    const { handlers, server } = createFakeServer(root, { default: agent })
    const plugin = (await import("../src/vite.ts")).hubAgent({ devtools: false })

    await configurePluginServer(plugin, server)

    const response = await invokeMiddleware(handlers[0]!, {
      agent: "chat",
      cli: {
        argv: ["slow"],
        name: "portal",
      },
      timeout: 1,
    }, agentInvocationStreamRoute, {
      "content-type": "application/json",
      [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue,
    })

    expect(response.statusCode).toBe(504)
    expect(response.body).toBe("Agent Invocation Stream timed out after 1ms.")
  })

  it("normalizes Agent Invocation Stream usage before serializing endpoint events", async () => {
    const root = await createTempRoot("vitehub-agent-invocation-stream-usage-")
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await writeFile(join(root, "server", "agents", "support.ts"), "export default {}", "utf8")

    const { defineAgent } = await import("../src/index.ts")
    const { agentInvocationStreamHeader, agentInvocationStreamHeaderValue, agentInvocationStreamRoute } = await import("../src/invocation-stream.ts")
    const usage = { inputTokens: 2, outputTokens: 3, totalTokens: 5 }
    const agent = defineAgent({
      async * run() {
        yield { text: "hello from stream", type: "text-delta" }
        yield { finishReason: "stop", totalUsage: usage, type: "finish" }
      },
    })
    const { handlers, server } = createFakeServer(root, { default: agent })
    const plugin = (await import("../src/vite.ts")).hubAgent({ devtools: false })

    await configurePluginServer(plugin, server)

    const response = await invokeMiddleware(handlers[0]!, {
      messages: [{
        id: "user-1",
        parts: [{ text: "hello", type: "text" }],
        role: "user",
      }],
    }, agentInvocationStreamRoute, {
      "content-type": "application/json",
      [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue,
    })
    const events = response.body
      .trim()
      .split("\n")
      .map(line => JSON.parse(line))

    expect(events).toEqual([
      expect.objectContaining({ agent: "support", type: "start" }),
      { text: "hello from stream", type: "text-delta" },
      { type: "usage", usageRecord: { usage } },
      { reason: "stop", type: "finish" },
      { type: "done" },
    ])
  })

  it("passes Agent Dev Loop payload into message-shaped channel invocations", async () => {
    const root = await createTempRoot("vitehub-agent-invocation-stream-payload-")
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await writeFile(join(root, "server", "agents", "support.ts"), "export default {}", "utf8")

    const { webChat } = await import("../src/channels.ts")
    const { defineAgent } = await import("../src/index.ts")
    const { agentInvocationStreamHeader, agentInvocationStreamHeaderValue, agentInvocationStreamRoute } = await import("../src/invocation-stream.ts")
    const headers = {
      "content-type": "application/json",
      [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue,
    }
    const agent = defineAgent({
      channels: {
        portal: webChat(),
      },
      run: ({ context, invoker, messages }) => `payload ${context.get<{ meta?: { audience?: string } }>("chat")?.meta?.audience} ${invoker.id} ${getMessageText(messages[0]!)}`,
    })
    const { handlers, server } = createFakeServer(root, { default: agent })
    const plugin = (await import("../src/vite.ts")).hubAgent({ devtools: false })

    await configurePluginServer(plugin, server)

    const discovery = await invokeMiddleware(handlers[0]!, {}, agentInvocationStreamRoute, {
      [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue,
    }, "GET")
    expect(JSON.parse(discovery.body)).toMatchObject({
      agents: [{
        name: "support",
        triggers: ["chat.message"],
      }],
    })

    const response = await invokeMiddleware(handlers[0]!, {
      agent: "support",
      payload: {
        meta: { audience: "technical" },
        user: { id: "github:onmax" },
      },
      messages: [{
        id: "user-1",
        parts: [{ text: "/summary", type: "text" }],
        role: "user",
      }],
    }, agentInvocationStreamRoute, headers)
    const events = response.body
      .trim()
      .split("\n")
      .map(line => JSON.parse(line))

    expect(events).toEqual([
      expect.objectContaining({ agent: "support", trigger: "chat.message", type: "start" }),
      { text: "payload technical dev:github:onmax /summary", type: "text-delta" },
      { type: "finish" },
      { type: "done" },
    ])
  })

  it("does not require Telegram webhook secrets for Agent Dev Loop chat invocations", async () => {
    const root = await createTempRoot("vitehub-agent-invocation-stream-telegram-dev-")
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await writeFile(join(root, "server", "agents", "nuxt.ts"), "export default {}", "utf8")

    const { telegram } = await import("../src/channels.ts")
    const { defineAgent } = await import("../src/index.ts")
    const { agentInvocationStreamHeader, agentInvocationStreamHeaderValue, agentInvocationStreamRoute } = await import("../src/invocation-stream.ts")
    const agent = defineAgent({
      channels: {
        telegram: telegram({
          adapter: () => ({}) as never,
          webhooks: { secretToken: "secret-token" },
        }),
      },
      run: ({ messages }) => `nuxt ${getMessageText(messages[0]!)}`,
    })
    const { handlers, server } = createFakeServer(root, { default: agent })
    const plugin = (await import("../src/vite.ts")).hubAgent({ devtools: false })

    await configurePluginServer(plugin, server)

    const response = await invokeMiddleware(handlers[0]!, {
      agent: "nuxt",
      messages: [{
        id: "user-1",
        parts: [{ text: "difference between useFetch and lazy use fetch?", type: "text" }],
        role: "user",
      }],
    }, agentInvocationStreamRoute, {
      "content-type": "application/json",
      [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue,
    })
    const events = response.body
      .trim()
      .split("\n")
      .map(line => JSON.parse(line))

    expect(events).toEqual([
      expect.objectContaining({ agent: "nuxt", trigger: "chat.message", type: "start" }),
      { text: "nuxt difference between useFetch and lazy use fetch?", type: "text-delta" },
      { type: "finish" },
      { type: "done" },
    ])
  })

  it("passes Agent Dev Loop payload and prompt into explicit channel trigger invocations", async () => {
    const root = await createTempRoot("vitehub-agent-invocation-stream-channel-payload-")
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await writeFile(join(root, "server", "agents", "review.ts"), "export default {}", "utf8")

    const { defineChannel } = await import("../src/channels.ts")
    const { defineAgent } = await import("../src/index.ts")
    const { agentInvocationStreamHeader, agentInvocationStreamHeaderValue, agentInvocationStreamRoute } = await import("../src/invocation-stream.ts")
    const triggerInputs: unknown[] = []
    const agent = defineAgent({
      channels: {
        github: defineChannel("github", {
          messages: false,
          triggers: {
            webhook: {
              invoke: (_context, input) => {
                triggerInputs.push(input)
                return {
                  input: {
                    context: { pullRequest: (input as { pullRequest?: unknown }).pullRequest } as AgentRunInput["context"],
                    prompt: (input as { prompt?: string }).prompt,
                  },
                  run: { channelId: "github", origin: "github-pull-request-comment", runId: "github-run" },
                }
              },
            },
          },
          webhooks: { secretHeader: "x-test-secret", secretToken: "secret-token" },
        }),
      },
      run: ({ context, input }) => `context ${context.get<{ number: number }>("pullRequest")?.number} ${input.prompt}`,
    })
    const { handlers, server } = createFakeServer(root, { default: agent })
    const plugin = (await import("../src/vite.ts")).hubAgent({ devtools: false })

    await configurePluginServer(plugin, server)

    const response = await invokeMiddleware(handlers[0]!, {
      agent: "review",
      payload: {
        pullRequest: { number: 42 },
      },
      messages: [{
        id: "user-1",
        parts: [{ text: "/review", type: "text" }],
        role: "user",
      }],
      trigger: "github.webhook",
    }, agentInvocationStreamRoute, {
      "content-type": "application/json",
      [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue,
    })
    const events = response.body
      .trim()
      .split("\n")
      .map(line => JSON.parse(line))

    expect(triggerInputs).toEqual([expect.objectContaining({
      pullRequest: { number: 42 },
      prompt: "/review",
    })])
    expect(events).toEqual([
      expect.objectContaining({ agent: "review", trigger: "github.webhook", type: "start" }),
      { text: "context 42 /review", type: "text-delta" },
      { type: "finish" },
      { type: "done" },
    ])
  })

  it("derives built-in GitHub webhook dev input from webhook payload", async () => {
    const root = await createTempRoot("vitehub-agent-invocation-stream-github-payload-")
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await writeFile(join(root, "server", "agents", "review.ts"), "export default {}", "utf8")

    const { github } = await import("../src/channels.ts")
    const { defineAgent } = await import("../src/index.ts")
    const { agentInvocationStreamHeader, agentInvocationStreamHeaderValue, agentInvocationStreamRoute } = await import("../src/invocation-stream.ts")
    const agent = defineAgent({
      channels: {
        github: github({ events: { pullRequestComments: { reply: false } }, webhooks: { secretToken: "secret-token" } }),
      },
      run: ({ context, input }) => {
        const github = context.get<{ command: string, repository: string }>("github")
        const pullRequest = context.get<{ pullRequest: { number: number } }>("pullRequest")
        return `context ${github?.repository}#${pullRequest?.pullRequest.number} ${github?.command} ${input.prompt}`
      },
    })
    const { handlers, server } = createFakeServer(root, { default: agent })
    const plugin = (await import("../src/vite.ts")).hubAgent({ devtools: false })

    await configurePluginServer(plugin, server)

    const response = await invokeMiddleware(handlers[0]!, {
      agent: "review",
      payload: {
        github: { event: "issue_comment" },
        payload: {
          action: "created",
          comment: {
            body: "/review",
            id: 123,
            user: { login: "maxi" },
          },
          issue: {
            number: 709,
            pull_request: {
              html_url: "https://github.com/quiverdk/portal/pull/709",
              url: "https://api.github.com/repos/quiverdk/portal/pulls/709",
            },
          },
          repository: { full_name: "quiverdk/portal" },
        },
      },
      trigger: "github.webhook",
    }, agentInvocationStreamRoute, {
      "content-type": "application/json",
      [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue,
    })
    const events = response.body
      .trim()
      .split("\n")
      .map(line => JSON.parse(line))

    expect(events).toEqual([
      expect.objectContaining({ agent: "review", trigger: "github.webhook", type: "start" }),
      { text: "context quiverdk/portal#709 /review /review", type: "text-delta" },
      { type: "finish" },
      { type: "done" },
    ])
  })

  it("accepts declared workspace agent names as dev loop aliases", async () => {
    const root = await createTempRoot("vitehub-agent-invocation-stream-alias-")
    await mkdir(join(root, "server", "agents", "review"), { recursive: true })
    await writeFile(join(root, "server", "agents", "review", "config.ts"), "export default {}", "utf8")

    const { defineAgent } = await import("../src/index.ts")
    const { agentInvocationStreamHeader, agentInvocationStreamHeaderValue, agentInvocationStreamRoute } = await import("../src/invocation-stream.ts")
    const headers = {
      "content-type": "application/json",
      [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue,
    }
    const agent = defineAgent({
      name: "summary",
      run: () => "ok",
      workspace: {},
    })
    const { handlers, server } = createFakeServer(root, { default: agent })
    const plugin = (await import("../src/vite.ts")).hubAgent({ devtools: false })

    await configurePluginServer(plugin, server)

    const discovery = await invokeMiddleware(handlers[0]!, {}, agentInvocationStreamRoute, {
      [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue,
    }, "GET")
    expect(JSON.parse(discovery.body)).toMatchObject({
      agents: [{
        aliases: ["summary"],
        name: "review",
      }],
    })

    for (const name of ["summary", "review"]) {
      const response = await invokeMiddleware(handlers[0]!, {
        agent: name,
        messages: [{
          id: "user-1",
          parts: [{ text: "hello", type: "text" }],
          role: "user",
        }],
      }, agentInvocationStreamRoute, headers)
      const events = response.body
        .trim()
        .split("\n")
        .map(line => JSON.parse(line))

      expect(events).toEqual([
        expect.objectContaining({ agent: "review", type: "start" }),
        { text: "ok", type: "text-delta" },
        { type: "finish" },
        { type: "done" },
      ])
    }
  })

  it("prefers exact dev loop agent names over aliases", async () => {
    const root = await createTempRoot("vitehub-agent-invocation-stream-exact-name-")
    await mkdir(join(root, "server", "agents", "review"), { recursive: true })
    await writeFile(join(root, "server", "agents", "review", "config.ts"), "export default {}", "utf8")
    await writeFile(join(root, "server", "agents", "summary.ts"), "export default {}", "utf8")

    const { defineAgent } = await import("../src/index.ts")
    const { agentInvocationStreamHeader, agentInvocationStreamHeaderValue, agentInvocationStreamRoute } = await import("../src/invocation-stream.ts")
    const headers = {
      "content-type": "application/json",
      [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue,
    }
    const aliasAgent = defineAgent({
      name: "summary",
      run: () => "alias",
      workspace: {},
    })
    const exactAgent = defineAgent({
      run: () => "exact",
    })
    const { handlers, server } = createFakeServer(root, { default: aliasAgent })
    server.ssrLoadModule.mockImplementation(async (...args: unknown[]) => String(args[0] || "").includes("/summary.ts")
      ? { default: exactAgent }
      : { default: aliasAgent })
    const plugin = (await import("../src/vite.ts")).hubAgent({ devtools: false })

    await configurePluginServer(plugin, server)

    const response = await invokeMiddleware(handlers[0]!, {
      agent: "summary",
      messages: [{
        id: "user-1",
        parts: [{ text: "hello", type: "text" }],
        role: "user",
      }],
    }, agentInvocationStreamRoute, headers)
    const events = response.body
      .trim()
      .split("\n")
      .map(line => JSON.parse(line))

    expect(events).toEqual([
      expect.objectContaining({ agent: "summary", type: "start" }),
      { text: "exact", type: "text-delta" },
      { type: "finish" },
      { type: "done" },
    ])
  })

  it("previews trigger Channel Delivery Effects for Agent Dev Loop channel invocations", async () => {
    const root = await createTempRoot("vitehub-agent-invocation-stream-effects-")
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await writeFile(join(root, "server", "agents", "review.ts"), "export default {}", "utf8")

    const { defineChannel } = await import("../src/channels.ts")
    const { defineAgent, defineCapability, runAgentTrigger } = await import("../src/index.ts")
    const { agentInvocationStreamHeader, agentInvocationStreamHeaderValue, agentInvocationStreamRoute } = await import("../src/invocation-stream.ts")
    const reactionEffect = vi.fn()
    const replyEffect = vi.fn()
    let abortSignal: AbortSignal | undefined
    let timeout: unknown
    const agent = defineAgent({
      capabilities: [
        defineCapability({
          id: "review-output",
          prepare: context => {
            context.delivery.effect({ kind: "reaction", payload: "queued" })
            context.delivery.finishEffect(() => ({ kind: "reply", payload: "capability-finished" }))
          },
        }),
      ],
      channels: {
        github: defineChannel("github", {
          effects: { reaction: reactionEffect, reply: replyEffect },
          messages: false,
          triggers: {
            webhook: {
              invoke: (context, input) => ({
                delivery: {
                  finishEffects: () => ({ kind: "reply", payload: "finished" }),
                },
                input,
                run: { channelId: context.trigger.channelId, origin: "github", runId: "github-run" },
              }),
            },
          },
        }),
      },
      run: ({ input }) => {
        abortSignal = input.abortSignal
        timeout = input.timeout
        return "Review completed."
      },
    })

    await expect(runAgentTrigger(agent, { memo: vi.fn(), runtime: "unknown" as const, waitUntil: vi.fn() }, "github.webhook", {})).resolves.toBe("Review completed.")
    expect(reactionEffect).toHaveBeenCalledOnce()
    expect(replyEffect).toHaveBeenCalledTimes(2)
    reactionEffect.mockClear()
    replyEffect.mockClear()

    const { handlers, server } = createFakeServer(root, { default: agent })
    const plugin = (await import("../src/vite.ts")).hubAgent({ devtools: false })

    await configurePluginServer(plugin, server)

    const response = await invokeMiddleware(handlers[0]!, {
      agent: "review",
      payload: { prompt: "review" },
      timeout: 1234,
      trigger: "github.webhook",
    }, agentInvocationStreamRoute, {
      "content-type": "application/json",
      [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue,
    })
    const events = response.body
      .trim()
      .split("\n")
      .map(line => JSON.parse(line))

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ agent: "review", trigger: "github.webhook", type: "start" }),
      expect.objectContaining({ channelId: "github", effect: { kind: "reaction", payload: "queued" }, type: "delivery-preview" }),
      expect.objectContaining({ channelId: "github", effect: { kind: "reply", payload: "finished" }, type: "delivery-preview" }),
      expect.objectContaining({ channelId: "github", effect: { kind: "reply", payload: "capability-finished" }, type: "delivery-preview" }),
      { text: "Review completed.", type: "text-delta" },
      { type: "finish" },
      { type: "done" },
    ]))
    expect(reactionEffect).not.toHaveBeenCalled()
    expect(replyEffect).not.toHaveBeenCalled()
    expect(abortSignal).toBeInstanceOf(AbortSignal)
    expect(timeout).toBe(1234)
  })

  it("serves plain Agent Definitions from the Agent Invocation Stream endpoint", async () => {
    const root = await createTempRoot("vitehub-agent-invocation-stream-plain-")
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await writeFile(join(root, "server", "agents", "ping.ts"), "export default {}", "utf8")

    const { defineAgent } = await import("../src/index.ts")
    const { agentInvocationStreamHeader, agentInvocationStreamHeaderValue, agentInvocationStreamRoute } = await import("../src/invocation-stream.ts")
    let abortSignal: AbortSignal | undefined
    const agent = defineAgent({
      run: ({ input }) => {
        abortSignal = input.abortSignal
        return { text: `plain ${input.messages?.[0] ? getMessageText(input.messages[0]) : ""}` }
      },
    })
    const { handlers, server } = createFakeServer(root, { default: agent })
    const plugin = (await import("../src/vite.ts")).hubAgent({ devtools: false })

    await configurePluginServer(plugin, server)

    const response = await invokeMiddleware(handlers[0]!, {
      messages: [{
        id: "user-1",
        parts: [{ text: "ping", type: "text" }],
        role: "user",
      }],
    }, agentInvocationStreamRoute, {
      "content-type": "application/json",
      [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue,
    })
    const events = response.body
      .trim()
      .split("\n")
      .map(line => JSON.parse(line))

    expect(events).toEqual([
      expect.objectContaining({ agent: "ping", type: "start" }),
      { text: "plain ping", type: "text-delta" },
      { type: "finish" },
      { type: "done" },
    ])
    expect(events[0]).not.toHaveProperty("trigger")
    expect(abortSignal).toBeInstanceOf(AbortSignal)
  })

  it("blocks browser-safe POSTs to the Agent Invocation Stream endpoint", async () => {
    const root = await createTempRoot("vitehub-agent-invocation-stream-guard-")
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await writeFile(join(root, "server", "agents", "support.ts"), "export default {}", "utf8")

    const { chat } = await import("../src/capabilities.ts")
    const { defineAgent } = await import("../src/index.ts")
    const { agentInvocationStreamRoute } = await import("../src/invocation-stream.ts")
    const { handlers, server } = createFakeServer(root, {
      default: defineAgent({
        capabilities: [chat()],
        run: () => "unused",
      }),
    })
    const plugin = (await import("../src/vite.ts")).hubAgent({ devtools: false })

    await configurePluginServer(plugin, server)

    const response = await invokeMiddleware(handlers[0]!, {
      messages: [{
        id: "user-1",
        parts: [{ text: "hello", type: "text" }],
        role: "user",
      }],
    }, agentInvocationStreamRoute)

    expect(response.statusCode).toBe(403)
  })

  it("blocks Agent Invocation Stream discovery before loading agents", async () => {
    const root = await createTempRoot("vitehub-agent-invocation-stream-get-guard-")
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await writeFile(join(root, "server", "agents", "support.ts"), "export default {}", "utf8")

    const { chat } = await import("../src/capabilities.ts")
    const { defineAgent } = await import("../src/index.ts")
    const { agentInvocationStreamRoute } = await import("../src/invocation-stream.ts")
    const { handlers, server } = createFakeServer(root, {
      default: defineAgent({
        capabilities: [chat()],
        run: () => "unused",
      }),
    })
    const plugin = (await import("../src/vite.ts")).hubAgent({ devtools: false })

    await configurePluginServer(plugin, server)

    const response = await invokeMiddleware(handlers[0]!, {}, agentInvocationStreamRoute, {}, "GET")

    expect(response.statusCode).toBe(403)
    expect(server.ssrLoadModule).not.toHaveBeenCalled()
  })

  it("consumes Response outputs from the Agent Invocation Stream endpoint", async () => {
    const root = await createTempRoot("vitehub-agent-invocation-stream-response-")
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await writeFile(join(root, "server", "agents", "support.ts"), "export default {}", "utf8")

    const { chat } = await import("../src/capabilities.ts")
    const { defineAgent } = await import("../src/index.ts")
    const { agentInvocationStreamHeader, agentInvocationStreamHeaderValue, agentInvocationStreamRoute } = await import("../src/invocation-stream.ts")
    const finish = vi.fn()
    const { handlers, server } = createFakeServer(root, {
      default: defineAgent({
        capabilities: [chat()],
        hooks: { "agent:finish": finish },
        run: () => new Response("hello from response"),
      }),
    })
    const plugin = (await import("../src/vite.ts")).hubAgent({ devtools: false })

    await configurePluginServer(plugin, server)

    const response = await invokeMiddleware(handlers[0]!, {
      messages: [{
        id: "user-1",
        parts: [{ text: "hello", type: "text" }],
        role: "user",
      }],
    }, agentInvocationStreamRoute, {
      "content-type": "application/json",
      [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue,
    })
    const events = response.body
      .trim()
      .split("\n")
      .map(line => JSON.parse(line))

    expect(events).toEqual([
      expect.objectContaining({ agent: "support", trigger: "chat.message", type: "start" }),
      { text: "hello from response", type: "text-delta" },
      { type: "finish" },
      { type: "done" },
    ])
    expect(finish).toHaveBeenCalledTimes(1)
  })

  it("serves initial chat devtools state while workspace metadata resolves", async () => {
    const root = await createTempRoot("vitehub-agent-devtools-metadata-")
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await writeFile(join(root, "server", "agents", "support.ts"), "export default {}", "utf8")

    const { chat } = await import("../src/capabilities.ts")
    const { defineAgent } = await import("../src/index.ts")
    let resolveInstructions!: (value: string) => void
    const instructionsReady = new Promise<string>((resolve) => {
      resolveInstructions = resolve
    })
    const readInstructions = vi.fn(async () => await instructionsReady)
    const agent = withAgentDefaults(defineAgent({
      capabilities: [chat()],
      instructions: readInstructions,
      model: {} as never,
      workspace: {
        sources: {
          docs: { name: "docs" } as never,
        },
      },
      run: () => "ok",
    }), { workspace: "support" })
    const { handlers, server } = createFakeServer(root, { default: agent })
    const plugin = (await import("../src/vite.ts")).hubAgent()

    await configurePluginServer(plugin, server)

    const firstState = await invokeState(handlers[0]!, { action: "get-state" })
    expect(firstState).toMatchObject({
      files: [expect.objectContaining({ path: "docs" })],
      instructions: ["Dynamic system instructions resolver configured."],
      metadataStatus: "loading",
      selected: "support",
    })

    resolveInstructions("Resolved workspace instructions")
    const resolvedState = await waitForMetadataState(handlers[0]!, { action: "get-state" })
    expect(resolvedState).toMatchObject({
      instructions: ["Resolved workspace instructions"],
      metadataStatus: "ready",
      selected: "support",
    })

    await invokeState(handlers[0]!, { action: "get-state" })
    expect(readInstructions).toHaveBeenCalledTimes(1)
  })

  it("refreshes chat devtools workspace metadata after source materialization", async () => {
    const root = await createTempRoot("vitehub-agent-devtools-materialized-source-")
    await mkdir(join(root, "server", "agents", "support"), { recursive: true })
    await writeFile(join(root, "server", "agents", "support", "config.ts"), "export default defineAgent({ workspace: {}, model })", "utf8")

    const { chat } = await import("../src/capabilities.ts")
    const { defineAgent } = await import("../src/index.ts")
    const { custom } = await import("@vite-hub/workspace")
    const { registerWorkspace } = await import("@vite-hub/workspace/test")
    const agent = withAgentDefaults(defineAgent({
      capabilities: [chat()],
      instructions: "Answer from the workspace.",
      model: {} as never,
      workspace: {
        store: { provider: "memory" },
        sources: {
          ingestion: custom({
            cache: { maxAge: 60 },
            materialize: "lazy",
            mount: "ingestion",
            async getKeys() {
              return ["customers/acme.csv"]
            },
            async getItem(key) {
              return { content: "sku,demand\nA,4\n", key }
            },
          }),
        },
      },
      async run({ workspace }) {
        const fs = workspace?.fs as { materializeSources?: (options: { sources: string[] }) => Promise<unknown> } | undefined
        await fs?.materializeSources?.({ sources: ["ingestion"] })
        return "materialized ingestion"
      },
    }), { workspace: "support" })
    registerWorkspace("support", agent as never)
    const { handlers, server } = createFakeServer(root, { default: agent })
    const plugin = (await import("../src/vite.ts")).hubAgent()

    await configurePluginServer(plugin, server)
    const initialState = await waitForMetadataState(handlers[0]!, { action: "get-state", chat: "support" })
    expect(initialState.files).toEqual([
      expect.objectContaining({
        materialized: false,
        path: "ingestion",
        source: "ingestion",
        status: "lazy",
      }),
    ])

    const sendResponse = await invokeMiddleware(handlers[0]!, {
      action: "send",
      chat: "support",
      stream: true,
      text: "load ingestion",
    })
    const events = sendResponse.body
      .trim()
      .split("\n")
      .map(line => JSON.parse(line))
    const finalState = events.filter(event => event.type === "state").at(-1)?.state

    expect(finalState.files).toEqual([
      expect.objectContaining({
        children: [
          expect.objectContaining({
            children: [
              expect.objectContaining({
                kind: "file",
                path: "ingestion/customers/acme.csv",
                source: "ingestion",
              }),
            ],
            kind: "directory",
            path: "ingestion/customers",
            source: "ingestion",
          }),
        ],
        materialized: true,
        path: "ingestion",
        source: "ingestion",
        status: "ready",
      }),
    ])
    expect(textFromUiMessage(finalState.uiMessages[1])).toBe("materialized ingestion")
  })

  it("materializes resolver-backed lazy sources from the chat devtools file tree", async () => {
    const root = await createTempRoot("vitehub-agent-devtools-click-source-")
    await mkdir(join(root, "server", "agents", "support"), { recursive: true })
    await writeFile(join(root, "server", "agents", "support", "config.ts"), "export default defineAgent({ workspace: {}, model })", "utf8")

    const { chat } = await import("../src/capabilities.ts")
    const { defineAgent } = await import("../src/index.ts")
    const { custom } = await import("@vite-hub/workspace")
    const { registerWorkspace } = await import("@vite-hub/workspace/test")
    const agent = withAgentDefaults(defineAgent({
      capabilities: [chat()],
      instructions: "Answer from the workspace.",
      model: {} as never,
      workspace: {
        store: { provider: "memory" },
        sources: {
          ingestion: custom({
            fingerprint: { source: "resolved-ingestion" },
            materialize: "lazy",
            async getKeys() {
              return []
            },
            async getItem(key) {
              throw new Error(`unresolved source read: ${key}`)
            },
            async resolve() {
              return custom({
                cache: { maxAge: 60 },
                fingerprint: { source: "resolved-ingestion" },
                materialize: "lazy",
                mount: "ingestion",
                async getKeys() {
                  return ["customers/acme.csv"]
                },
                async getItem(key) {
                  return { content: "sku,demand\nA,4\n", key }
                },
              })
            },
          }),
          portal: custom({
            cache: { maxAge: 60 },
            fingerprint: { source: "portal" },
            materialize: "lazy",
            mount: "portal",
            async getKeys() {
              return ["package.json"]
            },
            async getItem(key) {
              return { content: "{\"name\":\"portal\"}\n", key }
            },
          }),
        },
      },
      run: () => "ok",
    }), { workspace: "support" })
    registerWorkspace("support", agent as never)
    const { handlers, server } = createFakeServer(root, { default: agent })
    const plugin = (await import("../src/vite.ts")).hubAgent()

    await configurePluginServer(plugin, server)
    const initialState = await waitForMetadataState(handlers[0]!, { action: "get-state", chat: "support" })
    expect(initialState.files).toEqual([
      expect.objectContaining({
        materialized: false,
        path: "ingestion",
        source: "ingestion",
        status: "lazy",
      }),
      expect.objectContaining({
        materialized: false,
        path: "portal",
        source: "portal",
        status: "lazy",
      }),
    ])

    const materializedState = await invokeState(handlers[0]!, {
      action: "materialize-source",
      chat: "support",
      path: "ingestion",
      source: "ingestion",
    })

    expect(materializedState.title).toBe("support")
    expect(materializedState.files).toEqual(expect.arrayContaining([
      expect.objectContaining({
        children: [
          expect.objectContaining({
            children: [
              expect.objectContaining({
                kind: "file",
                path: "ingestion/customers/acme.csv",
                source: "ingestion",
              }),
            ],
            kind: "directory",
            path: "ingestion/customers",
            source: "ingestion",
          }),
        ],
        materialized: true,
        path: "ingestion",
        source: "ingestion",
        status: "ready",
      }),
    ]))

    const nextState = await invokeState(handlers[0]!, {
      action: "materialize-source",
      chat: "support",
      path: "portal",
      source: "portal",
    })

    expect(nextState.title).toBe("support")
    expect(nextState.files).toEqual([
      expect.objectContaining({
        children: [
          expect.objectContaining({
            children: [
              expect.objectContaining({
                kind: "file",
                path: "ingestion/customers/acme.csv",
                source: "ingestion",
              }),
            ],
            kind: "directory",
            path: "ingestion/customers",
            source: "ingestion",
          }),
        ],
        materialized: true,
        path: "ingestion",
        source: "ingestion",
        status: "ready",
      }),
      expect.objectContaining({
        children: [
          expect.objectContaining({
            kind: "file",
            path: "portal/package.json",
            source: "portal",
          }),
        ],
        materialized: true,
        path: "portal",
        source: "portal",
        status: "ready",
      }),
    ])
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
    expect(server.middlewares.use).toHaveBeenCalledTimes(1)
  })

})
