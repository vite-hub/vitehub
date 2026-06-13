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
        context.instructions.add(`Audience resolved for ${context.invoker.meta?.audience}.`)
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

    const state = await waitForMetadataState(handlers[0]!, { action: "get-state", invokerProfileId: "support-technical" })
    expect(state).toMatchObject({
      chats: [{ name: "support", uiMessages: [] }],
      instructions: ["# Support"],
      metadataStatus: "ready",
      invokerProfileId: "support-technical",
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

    const clearedTechnicalResponse = await invokeMiddleware(handlers[0]!, {
      action: "clear",
      chat: "support",
      invokerProfileId: "support-technical",
    })
    const clearedTechnicalState = JSON.parse(clearedTechnicalResponse.body)
    expect(clearedTechnicalState).toMatchObject({
      instructions: ["# Support"],
      invokerProfileId: "support-technical",
      selected: "support",
      uiMessages: [],
    })

    const clearedFallbackResponse = await invokeMiddleware(handlers[0]!, {
      action: "clear",
      chat: "support",
      invokerFallback: true,
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
    })
    expect(resolvedFallbackState).toMatchObject({
      instructions: ["# Support"],
      invokerFallback: true,
      metadataStatus: "ready",
      selected: "support",
    })
    expect(resolvedFallbackState.invokerProfileId).toBeUndefined()

    const fallbackSendResponse = await invokeMiddleware(handlers[0]!, {
      action: "send",
      chat: "support",
      invokerFallback: true,
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
    expect(textFromUiMessage(fallbackFinalState.uiMessages[1])).toBe("answered as devtools with workspace")
  })

  it("serves initial chat devtools state while workspace metadata resolves", async () => {
    const root = await createTempRoot("vitehub-agent-devtools-metadata-")
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await writeFile(join(root, "server", "agents", "support.ts"), "export default {}", "utf8")

    const { chat } = await import("../src/capabilities.ts")
    const { defineAgent, withWorkspaceAgentDefaults } = await import("../src/index.ts")
    let resolveInstructions!: (value: string) => void
    const instructionsReady = new Promise<string>((resolve) => {
      resolveInstructions = resolve
    })
    const readInstructions = vi.fn(async () => await instructionsReady)
    const agent = withWorkspaceAgentDefaults(defineAgent({
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
    await writeFile(join(root, "server", "agents", "support", "config.ts"), "export default {}", "utf8")

    const { chat } = await import("../src/capabilities.ts")
    const { defineAgent, withWorkspaceAgentDefaults } = await import("../src/index.ts")
    const { source } = await import("@vite-hub/workspace")
    const { registerWorkspace } = await import("@vite-hub/workspace/test")
    const agent = withWorkspaceAgentDefaults(defineAgent({
      capabilities: [chat()],
      instructions: "Answer from the workspace.",
      model: {} as never,
      workspace: {
        store: { provider: "memory" },
        sources: {
          ingestion: source.custom({
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
    await writeFile(join(root, "server", "agents", "support", "config.ts"), "export default {}", "utf8")

    const { chat } = await import("../src/capabilities.ts")
    const { defineAgent, withWorkspaceAgentDefaults } = await import("../src/index.ts")
    const { source } = await import("@vite-hub/workspace")
    const { registerWorkspace } = await import("@vite-hub/workspace/test")
    const agent = withWorkspaceAgentDefaults(defineAgent({
      capabilities: [chat()],
      instructions: "Answer from the workspace.",
      model: {} as never,
      workspace: {
        store: { provider: "memory" },
        sources: {
          ingestion: source.custom({
            fingerprint: { source: "resolved-ingestion" },
            materialize: "lazy",
            async getKeys() {
              return []
            },
            async getItem(key) {
              throw new Error(`unresolved source read: ${key}`)
            },
            async resolve() {
              return source.custom({
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
          portal: source.custom({
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

    expect(materializedState.files).toEqual([
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
        materialized: false,
        path: "portal",
        source: "portal",
        status: "lazy",
      }),
    ])

    const nextState = await invokeState(handlers[0]!, {
      action: "materialize-source",
      chat: "support",
      path: "portal",
      source: "portal",
    })

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
    expect(server.middlewares.use).not.toHaveBeenCalled()
  })

})
