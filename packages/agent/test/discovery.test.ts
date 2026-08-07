import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"

import { describe, expect, it, vi } from "vitest"

import { createAgentEvalInclude, discoverAgentDefinitions, discoverAgentEvalFiles } from "../src/discovery.ts"
import { getMessageText } from "../src/messages.ts"

import type { IncomingMessage, ServerResponse } from "node:http"
import type { Connect } from "vite"
import type { AgentRunInput } from "../src/index.ts"

async function createTempRoot(prefix: string) {
  return await mkdtemp(join(tmpdir(), prefix))
}

it("escapes glob syntax in Agent Eval roots", () => {
  const include = createAgentEvalInclude(["/repo/app[1]/server?(external)"])
  expect(include).toContain("/repo/app\\[1\\]/server\\?\\(external\\)/**/*.eval.?(m)ts")
})

it("discovers executable Agent Eval files without treating fixture directories as evals", async () => {
  const root = await createTempRoot("vitehub-agent-evals-")
  try {
    await mkdir(join(root, "evals"), { recursive: true })
    await mkdir(join(root, "server", "agents", "support"), { recursive: true })
    await writeFile(join(root, "evals", "cases.json"), "[]\n", "utf8")
    await writeFile(join(root, "evals", "reference.xlsx"), "fixture", "utf8")
    await writeFile(join(root, "server", "agents", "support", "EVAL.TS"), "export default defineEval({})", "utf8")

    expect(discoverAgentEvalFiles([root])).toEqual([])

    const suffixEval = join(root, "server", "agents", "support.eval.ts")
    const folderEval = join(root, "server", "agents", "support", "eval.mts")
    const tsxEval = join(root, "server", "agents", "support.eval.tsx")
    await writeFile(suffixEval, "export default defineEval({})", "utf8")
    await writeFile(folderEval, "export default defineEval({})", "utf8")
    await writeFile(tsxEval, "export default defineEval({})", "utf8")

    expect(discoverAgentEvalFiles([root])).toEqual([suffixEval, tsxEval, folderEval])
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
})

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
  url = "/__vitehub/agent/invocation-stream",
  headers: IncomingMessage["headers"] = { "content-type": "text/plain" },
  method = "POST",
  options: { onResponse?: (res: ServerResponse) => void } = {},
) {
  let output = ""
  const req = Readable.from([JSON.stringify(body)]) as IncomingMessage
  req.headers = headers
  req.method = method
  req.url = url

  const result = await new Promise<{ body: string, statusCode: number }>((resolve, reject) => {
    let statusCode = 200
    const closeListeners = new Set<(...args: unknown[]) => void>()
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
      emit(event: string, ...args: unknown[]) {
        if (event !== "close") return false
        const listeners = [...closeListeners]
        closeListeners.clear()
        for (const listener of listeners) listener(...args)
        return listeners.length > 0
      },
      off(event: string, listener: (...args: unknown[]) => void) {
        if (event === "close") closeListeners.delete(listener)
        return res
      },
      once(event: string, listener: (...args: unknown[]) => void) {
        if (event === "close") closeListeners.add(listener)
        return res
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

    options.onResponse?.(res)
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
    await writeFile(join(root, "server", "agents", "docs", "agent.ts"), "export default defineAgent({ workspace: {}, driver: { model } })", "utf8")

    expect(discoverAgentDefinitions({
      mode: "server-agents",
      scanDirs: [join(root, "server")],
    })).toEqual([
      expect.objectContaining({ name: "docs", source: "server-agent-workspace", workspace: "docs" }),
      expect.objectContaining({ name: "support", source: "server-agents" }),
    ])
  })

  it("discovers a flat Agent named agent", async () => {
    const root = await createTempRoot("vitehub-agent-flat-agent-")
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await writeFile(join(root, "server", "agents", "agent.ts"), "export default defineAgent({ driver: { model } })", "utf8")

    expect(discoverAgentDefinitions({
      mode: "server-agents",
      scanDirs: [join(root, "server")],
    })).toEqual([
      expect.objectContaining({ name: "agent", source: "server-agents" }),
    ])
  })

  it("does not discover legacy folder config files", async () => {
    const root = await createTempRoot("vitehub-agent-legacy-config-")
    await mkdir(join(root, "server", "agents", "support"), { recursive: true })
    await writeFile(join(root, "server", "agents", "support", "config.ts"), "export default defineAgent({ driver: { model } })", "utf8")

    expect(discoverAgentDefinitions({
      mode: "server-agents",
      scanDirs: [join(root, "server")],
    })).toEqual([])
  })

  it("does not discover TypeScript files inside Agent Skill trees", async () => {
    const root = await createTempRoot("vitehub-agent-server-skills-")
    await mkdir(join(root, "server", "agents", "review", "skills", "helper", "scripts"), { recursive: true })
    await writeFile(join(root, "server", "agents", "review", "agent.ts"), "export default {}", "utf8")
    await writeFile(join(root, "server", "agents", "review", "skills", "helper", "agent.ts"), "export default {}", "utf8")
    await writeFile(join(root, "server", "agents", "review", "skills", "helper", "scripts", "run.ts"), "export {}", "utf8")

    expect(discoverAgentDefinitions({
      mode: "server-agents",
      scanDirs: [join(root, "server")],
    })).toEqual([
      expect.objectContaining({ name: "review", source: "server-agents" }),
    ])
  })

  it("allows a top-level folder Agent named skills", async () => {
    const root = await createTempRoot("vitehub-agent-server-skills-name-")
    await mkdir(join(root, "server", "agents", "skills"), { recursive: true })
    await writeFile(join(root, "server", "agents", "skills", "agent.ts"), "export default {}", "utf8")

    expect(discoverAgentDefinitions({
      mode: "server-agents",
      scanDirs: [join(root, "server")],
    })).toEqual([
      expect.objectContaining({ name: "skills", source: "server-agents" }),
    ])
  })

  it("does not discover Agent-like files inside Agent Home trees", async () => {
    const root = await createTempRoot("vitehub-agent-server-home-")
    await mkdir(join(root, "server", "agents", "review", "home", "tools"), { recursive: true })
    await writeFile(join(root, "server", "agents", "review", "agent.ts"), "export default {}", "utf8")
    await writeFile(join(root, "server", "agents", "review", "home", "agent.ts"), "export default {}", "utf8")
    await writeFile(join(root, "server", "agents", "review", "home", "tools", "index.ts"), "export default {}", "utf8")

    expect(discoverAgentDefinitions({
      mode: "server-agents",
      scanDirs: [join(root, "server")],
    })).toEqual([
      expect.objectContaining({ name: "review", source: "server-agents" }),
    ])
  })

  it("ignores eval definitions during server agent discovery", async () => {
    const root = await createTempRoot("vitehub-agent-server-eval-")
    await mkdir(join(root, "server", "agents", "support"), { recursive: true })
    await writeFile(join(root, "server", "agents", "support", "agent.ts"), "export default defineAgent({ workspace: {}, driver: { model } })", "utf8")
    await writeFile(join(root, "server", "agents", "support", "agent.eval.ts"), "export default defineEval({})", "utf8")
    await writeFile(join(root, "server", "agents", "support", "eval.ts"), "export default defineEval({})", "utf8")
    await writeFile(join(root, "server", "agents", "support.eval.ts"), "export default defineEval({})", "utf8")

    expect(discoverAgentDefinitions({
      mode: "server-agents",
      scanDirs: [join(root, "server")],
    })).toEqual([
      expect.objectContaining({ name: "support", source: "server-agent-workspace", workspace: "support" }),
    ])
  })

  it("ignores helper files inside folder Agents", async () => {
    const root = await createTempRoot("vitehub-agent-server-helpers-")
    await mkdir(join(root, "server", "agents", "chat", "workspace"), { recursive: true })
    await mkdir(join(root, "server", "agents", "review"), { recursive: true })
    await writeFile(join(root, "server", "agents", "chat", "agent.ts"), "export default defineAgent({ workspace: {}, driver: { model } })", "utf8")
    await writeFile(join(root, "server", "agents", "chat", "access.ts"), "export const access = {}", "utf8")
    await writeFile(join(root, "server", "agents", "chat", "audience.test.ts"), "export const test = {}", "utf8")
    await writeFile(join(root, "server", "agents", "chat", "prompts.ts"), "export default { system: 'help' }", "utf8")
    await writeFile(join(root, "server", "agents", "chat", "workspace", "config.ts"), "export const sources = {}", "utf8")
    await writeFile(join(root, "server", "agents", "review", "agent.ts"), "export default defineAgent({ driver: { model } })", "utf8")

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
    await writeFile(join(root, "server", "agents", "docs", "agent.ts"), "export default defineAgent({ workspace: {}, name: 'context', driver: { model } })", "utf8")

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
    await writeFile(join(root, "server", "agents", "team", "workspace", "agent.ts"), "export default defineAgent({ workspace: {}, driver: { model } })", "utf8")

    expect(discoverAgentDefinitions({
      mode: "server-agents",
      scanDirs: [join(root, "server")],
    })).toEqual([
      expect.objectContaining({ name: "team/workspace", source: "server-agent-workspace", workspace: "team/workspace" }),
    ])
  })

  it("discovers nested agents named workspace below plain folder Agents", async () => {
    const root = await createTempRoot("vitehub-agent-plain-parent-workspace-")
    await mkdir(join(root, "server", "agents", "team", "workspace"), { recursive: true })
    await writeFile(join(root, "server", "agents", "team", "agent.ts"), "export default defineAgent({ driver: { run: () => 'ok' } })", "utf8")
    await writeFile(join(root, "server", "agents", "team", "workspace", "agent.ts"), "export default defineAgent({ workspace: {}, driver: { model } })", "utf8")

    expect(discoverAgentDefinitions({
      mode: "server-agents",
      scanDirs: [join(root, "server")],
    })).toEqual([
      expect.objectContaining({ name: "team", source: "server-agents", workspace: undefined }),
      expect.objectContaining({ name: "team/workspace", source: "server-agent-workspace", workspace: "team/workspace" }),
    ])
  })

  it("discovers nested file Agents below folder Agents", async () => {
    const root = await createTempRoot("vitehub-agent-nested-file-agent-")
    await mkdir(join(root, "server", "agents", "team"), { recursive: true })
    await writeFile(join(root, "server", "agents", "team", "agent.ts"), "export default defineAgent({ workspace: {}, driver: { model } })", "utf8")
    await writeFile(join(root, "server", "agents", "team", "access.ts"), "export const access = {}", "utf8")
    await writeFile(join(root, "server", "agents", "team", "review.ts"), "export default defineAgent({ driver: { model } })", "utf8")

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

  it("discovers nested re-exported file Agents below folder Agents", async () => {
    const root = await createTempRoot("vitehub-agent-nested-reexport-agent-")
    await mkdir(join(root, "server", "agents", "team"), { recursive: true })
    await writeFile(join(root, "server", "agents", "team", "agent.ts"), "export default defineAgent({ workspace: {}, driver: { model } })", "utf8")
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

  it("throws when a folder Agent also has an index definition", async () => {
    const root = await createTempRoot("vitehub-agent-folder-index-duplicate-")
    await mkdir(join(root, "server", "agents", "support"), { recursive: true })
    await writeFile(join(root, "server", "agents", "support", "agent.ts"), "export default defineAgent({ workspace: {}, driver: { model } })", "utf8")
    await writeFile(join(root, "server", "agents", "support", "index.ts"), "export default defineAgent({ driver: { model } })", "utf8")

    expect(() => discoverAgentDefinitions({
      mode: "server-agents",
      scanDirs: [join(root, "server")],
    })).toThrow("Duplicate agent name")
  })

  it("keeps skill scripts out of index-based Agent discovery", async () => {
    const root = await createTempRoot("vitehub-agent-index-skills-")
    await mkdir(join(root, "server", "agents", "review", "skills", "helper", "scripts"), { recursive: true })
    await writeFile(join(root, "server", "agents", "review", "index.ts"), "export default defineAgent({ driver: { model } })", "utf8")
    await writeFile(join(root, "server", "agents", "review", "skills", "helper", "scripts", "run.ts"), "export default {}", "utf8")

    expect(discoverAgentDefinitions({
      mode: "server-agents",
      scanDirs: [join(root, "server")],
    })).toEqual([
      expect.objectContaining({ name: "review", source: "server-agents" }),
    ])
  })

  it("keeps helper indexes out of folder Agent discovery", async () => {
    const root = await createTempRoot("vitehub-agent-helper-index-")
    await mkdir(join(root, "server", "agents", "support", "lib"), { recursive: true })
    await writeFile(join(root, "server", "agents", "support", "agent.ts"), "export default defineAgent({ driver: { model } })", "utf8")
    await writeFile(join(root, "server", "agents", "support", "lib", "index.ts"), "export * from './helper'", "utf8")

    expect(discoverAgentDefinitions({
      mode: "server-agents",
      scanDirs: [join(root, "server")],
    })).toEqual([
      expect.objectContaining({ name: "support", source: "server-agents" }),
    ])
  })

  it("throws when a nested folder Agent also has an index definition", async () => {
    const root = await createTempRoot("vitehub-agent-nested-folder-index-duplicate-")
    await mkdir(join(root, "server", "agents", "team", "review"), { recursive: true })
    await writeFile(join(root, "server", "agents", "team", "agent.ts"), "export default defineAgent({ workspace: {}, driver: { model } })", "utf8")
    await writeFile(join(root, "server", "agents", "team", "review", "agent.ts"), "export default defineAgent({ workspace: {}, driver: { model } })", "utf8")
    await writeFile(join(root, "server", "agents", "team", "review", "index.ts"), "export default defineAgent({ driver: { model } })", "utf8")

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
    await writeFile(join(root, "server", "agents", "docs", "agent.ts"), [
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
      driver: { run: ({ input }: { input: { abortSignal?: AbortSignal } }) => {
          abortSignal = input.abortSignal
          return "hello from stream"
        } },
    })
    const { handlers, server } = createFakeServer(root, { default: agent })
    const plugin = (await import("../src/vite.ts")).hubAgent()

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

  it("passes prior chat history to second-turn Agent Dev Loop invocations", async () => {
    const root = await createTempRoot("vitehub-agent-invocation-stream-history-")
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await writeFile(join(root, "server", "agents", "support.ts"), "export default {}", "utf8")

    const { chat } = await import("../src/capabilities.ts")
    const { defineAgent } = await import("../src/index.ts")
    const { agentInvocationStreamHeader, agentInvocationStreamHeaderValue, agentInvocationStreamRoute } = await import("../src/invocation-stream.ts")
    const agent = defineAgent({
      capabilities: [chat()],
      driver: {
        run: ({ messages }) => messages.map(message => `${message.role}:${getMessageText(message)}`).join(" | "),
      },
    })
    const { handlers, server } = createFakeServer(root, { default: agent })
    const plugin = (await import("../src/vite.ts")).hubAgent()

    await configurePluginServer(plugin, server)

    const response = await invokeMiddleware(handlers[0]!, {
      messages: [
        {
          id: "user-1",
          parts: [{ text: "remember blue", type: "text" }],
          role: "user",
        },
        {
          id: "assistant-1",
          parts: [{ text: "blue is remembered", type: "text" }],
          role: "assistant",
        },
        {
          id: "user-2",
          parts: [{ text: "what did I ask you to remember?", type: "text" }],
          role: "user",
        },
      ],
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
      { text: "user:remember blue | assistant:blue is remembered | user:what did I ask you to remember?", type: "text-delta" },
      { type: "finish" },
      { type: "done" },
    ])
  })

  it("runs invocation-resolved Capability CLI commands through the Vite endpoint", async () => {
    const root = await createTempRoot("vitehub-agent-invocation-stream-cli-")
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await writeFile(join(root, "server", "agents", "chat.ts"), "export default {}", "utf8")

    const { defineAgent, defineCapability } = await import("../src/index.ts")
    const { agentInvocationStreamHeader, agentInvocationStreamHeaderValue, agentInvocationStreamRoute } = await import("../src/invocation-stream.ts")
    const agent = defineAgent({
      capabilities: [
        defineCapability({
          cli: ({ run }) => run?.origin === "dev"
            ? {
                commands: {
                  items: {
                    commands: {
                      list: {
                        description: "List inventory items.",
                        output: { format: "json" },
                        run: ({ json }) => ({ items: [{ id: "item_1" }], json }),
                      },
                    },
                    description: "Inventory item data.",
                  },
                },
                name: "inventory",
              }
            : undefined,
          id: "inventory-runtime",
        }),
      ],
      driver: { run: () => "chat fallback" },
    })
    const { handlers, server } = createFakeServer(root, { default: agent })
    const plugin = (await import("../src/vite.ts")).hubAgent()

    await configurePluginServer(plugin, server)

    const response = await invokeMiddleware(handlers[0]!, {
      agent: "chat",
      cli: {
        argv: ["items", "list", "--json"],
        name: "inventory",
      },
    }, agentInvocationStreamRoute, {
      "content-type": "application/json",
      [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue,
    })

    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({
      argv: ["items", "list", "--json"],
      capability: "inventory-runtime",
      cli: "inventory",
      command: "inventory items list --json",
      exitCode: 0,
      json: {
        items: [{ id: "item_1" }],
        json: true,
      },
    })
  })

  it("propagates client aborts to Capability CLI runs", async () => {
    const root = await createTempRoot("vitehub-agent-invocation-stream-cli-abort-")
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await writeFile(join(root, "server", "agents", "chat.ts"), "export default {}", "utf8")

    const { defineAgent, defineCapability } = await import("../src/index.ts")
    const { agentInvocationStreamHeader, agentInvocationStreamHeaderValue, agentInvocationStreamRoute } = await import("../src/invocation-stream.ts")
    let closeResponse: (() => void) | undefined
    let commandSignal: AbortSignal | undefined
    const agent = defineAgent({
      capabilities: [
        defineCapability({
          cli: {
            commands: {
              wait: {
                run: async ({ context }) => {
                  commandSignal = context.input.get().abortSignal
                  if (!commandSignal) throw new Error("Missing Capability CLI abort signal.")
                  const aborted = new Promise<void>((resolve) => {
                    if (commandSignal?.aborted) resolve()
                    else commandSignal?.addEventListener("abort", () => resolve(), { once: true })
                  })
                  closeResponse?.()
                  await aborted
                  return "aborted"
                },
              },
            },
            name: "inventory",
          },
          id: "inventory-runtime",
        }),
      ],
      driver: { run: () => "chat fallback" },
    })
    const { handlers, server } = createFakeServer(root, { default: agent })
    const plugin = (await import("../src/vite.ts")).hubAgent()

    await configurePluginServer(plugin, server)

    const response = await invokeMiddleware(handlers[0]!, {
      agent: "chat",
      cli: {
        argv: ["wait"],
        name: "inventory",
      },
      timeout: 90_000,
    }, agentInvocationStreamRoute, {
      "content-type": "application/json",
      [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue,
    }, "POST", {
      onResponse(res) {
        closeResponse = () => (res as ServerResponse & { emit: (event: string) => boolean }).emit("close")
      },
    })

    expect(response.statusCode).toBe(200)
    expect(commandSignal).toBeInstanceOf(AbortSignal)
    expect(commandSignal?.aborted).toBe(true)
  })

  it("runs Capability CLI commands on harness-backed agents through the Vite endpoint", async () => {
    const root = await createTempRoot("vitehub-agent-invocation-stream-harness-cli-")
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
                output: { format: "json" },
                run: () => [{ id: "item_1" }],
              },
            },
            name: "inventory",
          },
          id: "inventory-runtime",
        }),
      ],
      driver: { harness: {} as never },
    })
    const { handlers, server } = createFakeServer(root, { default: agent })
    const plugin = (await import("../src/vite.ts")).hubAgent()

    await configurePluginServer(plugin, server)

    const response = await invokeMiddleware(handlers[0]!, {
      agent: "chat",
      cli: {
        argv: ["list", "--json"],
        name: "inventory",
      },
    }, agentInvocationStreamRoute, {
      "content-type": "application/json",
      [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue,
    })

    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({
      capability: "inventory-runtime",
      cli: "inventory",
      exitCode: 0,
      json: [{ id: "item_1" }],
    })
  })

  it("respects Capability CLI opt-out through the Vite endpoint", async () => {
    const root = await createTempRoot("vitehub-agent-invocation-stream-cli-opt-out-")
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
                output: { format: "json" },
                run: () => [{ id: "item_1" }],
              },
            },
            name: "inventory",
          },
          id: "inventory-runtime",
        }),
      ],
      cli: { capabilities: false },
      driver: { harness: {} as never },
    })
    const { handlers, server } = createFakeServer(root, { default: agent })
    const plugin = (await import("../src/vite.ts")).hubAgent()

    await configurePluginServer(plugin, server)

    const response = await invokeMiddleware(handlers[0]!, {
      agent: "chat",
      cli: {
        argv: ["list", "--json"],
        name: "inventory",
      },
    }, agentInvocationStreamRoute, {
      "content-type": "application/json",
      [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue,
    })

    expect(response.statusCode).toBe(500)
    expect(response.body).toBe("Agent Invocation Stream endpoint failed.")
  })

  it("preserves model driver context for Capability CLI dev runs", async () => {
    const root = await createTempRoot("vitehub-agent-invocation-stream-model-cli-")
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await writeFile(join(root, "server", "agents", "chat.ts"), "export default {}", "utf8")
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ customers: ["acme"] }), {
      headers: { "content-type": "application/json" },
      status: 200,
    }))

    try {
      const { openapi } = await import("../src/capabilities.ts")
      const { defineAgent } = await import("../src/index.ts")
      const { agentInvocationStreamHeader, agentInvocationStreamHeaderValue, agentInvocationStreamRoute } = await import("../src/invocation-stream.ts")
      const agent = defineAgent({
        capabilities: [
          openapi({
            cli: { name: "portal" },
            operations: ["listCustomers"],
            spec: {
              paths: {
                "/customers": {
                  get: {
                    operationId: "listCustomers",
                    summary: "List customers.",
                  },
                },
              },
              servers: [{ url: "https://portal.example.com/runtime" }],
            },
          }),
        ],
        driver: { model: {} as never },
      })
      const { handlers, server } = createFakeServer(root, { default: agent })
      const plugin = (await import("../src/vite.ts")).hubAgent()

      await configurePluginServer(plugin, server)

      const response = await invokeMiddleware(handlers[0]!, {
        agent: "chat",
        cli: {
          argv: ["list-customers", "--json"],
          name: "portal",
        },
      }, agentInvocationStreamRoute, {
        "content-type": "application/json",
        [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue,
      })

      expect(response.statusCode).toBe(200)
      expect(JSON.parse(response.body)).toMatchObject({
        cli: "portal",
        command: "portal list-customers --json",
        exitCode: 0,
        json: { customers: ["acme"] },
      })
      expect(request.mock.calls[0]?.[0]).toBe("https://portal.example.com/runtime/customers")
    }
    finally {
      request.mockRestore()
    }
  })

  it("previews Channel Delivery Effects for Capability CLI dev runs", async () => {
    const root = await createTempRoot("vitehub-agent-invocation-stream-cli-effects-")
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await writeFile(join(root, "server", "agents", "chat.ts"), "export default {}", "utf8")

    const { defineChannel } = await import("../src/channels.ts")
    const { defineAgent, defineCapability } = await import("../src/index.ts")
    const { agentInvocationStreamHeader, agentInvocationStreamHeaderValue, agentInvocationStreamRoute } = await import("../src/invocation-stream.ts")
    const reactionEffect = vi.fn()
    const agent = defineAgent({
      capabilities: [
        defineCapability({
          cli: {
            commands: {
              list: {
                output: { format: "json" },
                run: () => [{ id: "item_1" }],
              },
            },
            name: "inventory",
          },
          id: "inventory-runtime",
          prepare(context) {
            context.delivery.effect({ kind: "reaction", payload: "queued" })
          },
        }),
      ],
      channels: {
        github: defineChannel("github", {
          effects: { reaction: reactionEffect },
          messages: false,
        }),
      },
      driver: { run: () => "chat fallback" },
    })
    const { handlers, server } = createFakeServer(root, { default: agent })
    const plugin = (await import("../src/vite.ts")).hubAgent()

    await configurePluginServer(plugin, server)

    const response = await invokeMiddleware(handlers[0]!, {
      agent: "chat",
      cli: {
        argv: ["list", "--json"],
        name: "inventory",
      },
      run: { channelId: "github", origin: "dev", runId: "dev-run" },
    }, agentInvocationStreamRoute, {
      "content-type": "application/json",
      [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue,
    })

    expect(response.statusCode).toBe(200)
    const result = JSON.parse(response.body)
    expect(result).toMatchObject({
      cli: "inventory",
      exitCode: 0,
      json: [{ id: "item_1" }],
    })
    expect(result.stderr).toContain("[delivery preview] would reaction on github")
    expect(result.stderr).toContain("\"payload\": \"queued\"")
    expect(reactionEffect).not.toHaveBeenCalled()
  })

  it("passes invoker profile selection into Capability CLI dev runs", async () => {
    const root = await createTempRoot("vitehub-agent-invocation-stream-cli-invoker-")
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await writeFile(join(root, "server", "agents", "chat.ts"), "export default {}", "utf8")

    const { defineAgent, defineCapability } = await import("../src/index.ts")
    const { agentInvocationStreamHeader, agentInvocationStreamHeaderValue, agentInvocationStreamRoute } = await import("../src/invocation-stream.ts")
    const agent = defineAgent({
      capabilities: [
        defineCapability({
          cli: {
            commands: {
              whoami: {
                output: { format: "json" },
                run: ({ context }) => ({ invoker: context.invoker.id }),
              },
            },
            name: "inventory",
          },
          id: "inventory-runtime",
        }),
      ],
      invoker: {
        profiles: [
          { id: "support-customer", kind: "customer", label: "Customer" },
          { id: "support-technical", kind: "technical", label: "Technical" },
        ],
      },
      driver: { run: () => "chat fallback" },
    })
    const { handlers, server } = createFakeServer(root, { default: agent })
    const plugin = (await import("../src/vite.ts")).hubAgent()

    await configurePluginServer(plugin, server)

    const response = await invokeMiddleware(handlers[0]!, {
      agent: "chat",
      cli: {
        argv: ["whoami", "--json"],
        name: "inventory",
      },
      invokerProfileId: "support-technical",
    }, agentInvocationStreamRoute, {
      "content-type": "application/json",
      [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue,
    })

    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({
      json: { invoker: "support-technical" },
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
                run: () => [{ id: "item_1" }],
              },
            },
            name: "inventory",
          },
          id: "inventory-runtime",
          output(context) {
            context.output.render(renderOutput)
          },
        }),
      ],
      driver: { run: () => "chat fallback" },
    })
    const { handlers, server } = createFakeServer(root, { default: agent })
    const plugin = (await import("../src/vite.ts")).hubAgent()

    await configurePluginServer(plugin, server)

    const response = await invokeMiddleware(handlers[0]!, {
      agent: "chat",
      cli: {
        argv: ["list", "--json"],
        name: "inventory",
      },
    }, agentInvocationStreamRoute, {
      "content-type": "application/json",
      [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue,
    })

    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({
      argv: ["list", "--json"],
      capability: "inventory-runtime",
      cli: "inventory",
      exitCode: 0,
      json: [{ id: "item_1" }],
      stdout: "[\n  {\n    \"id\": \"item_1\"\n  }\n]\n",
    })
    expect(renderOutput).not.toHaveBeenCalled()
  })

  it("bypasses tool transforms for Capability CLI endpoint dispatch", async () => {
    const root = await createTempRoot("vitehub-agent-invocation-stream-cli-transform-")
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
                output: { format: "json" },
                run: () => [{ id: "item_1" }],
              },
            },
            name: "inventory",
          },
          id: "inventory-runtime",
          prepare(context) {
            context.tools.transform(() => undefined)
          },
        }),
      ],
      driver: { run: () => "chat fallback" },
    })
    const { handlers, server } = createFakeServer(root, { default: agent })
    const plugin = (await import("../src/vite.ts")).hubAgent()

    await configurePluginServer(plugin, server)

    const response = await invokeMiddleware(handlers[0]!, {
      agent: "chat",
      cli: {
        argv: ["list", "--json"],
        name: "inventory",
      },
    }, agentInvocationStreamRoute, {
      "content-type": "application/json",
      [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue,
    })

    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({
      capability: "inventory-runtime",
      cli: "inventory",
      exitCode: 0,
      json: [{ id: "item_1" }],
    })
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
            name: "inventory",
          },
          id: "inventory-runtime",
          input: () => Response.json({ reason: "blocked" }, { status: 409 }),
        }),
      ],
      driver: { run: () => "chat fallback" },
    })
    const { handlers, server } = createFakeServer(root, { default: agent })
    const plugin = (await import("../src/vite.ts")).hubAgent()

    await configurePluginServer(plugin, server)

    const response = await invokeMiddleware(handlers[0]!, {
      agent: "chat",
      cli: {
        argv: ["list"],
        name: "inventory",
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
            name: "inventory",
          },
          id: "inventory-runtime",
        }),
      ],
      driver: { run: () => "chat fallback" },
    })
    const { handlers, server } = createFakeServer(root, { default: agent })
    const plugin = (await import("../src/vite.ts")).hubAgent()

    await configurePluginServer(plugin, server)

    const response = await invokeMiddleware(handlers[0]!, {
      agent: "chat",
      cli: {
        argv: ["slow"],
        name: "inventory",
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
      driver: {
        async * run() {
          yield { text: "hello from stream", type: "text-delta" }
          yield { finishReason: "stop", totalUsage: usage, type: "finish" }
        }
      },
    })
    const { handlers, server } = createFakeServer(root, { default: agent })
    const plugin = (await import("../src/vite.ts")).hubAgent()

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
      driver: { run: ({ context, invoker, messages }) => `payload ${context.get<{ meta?: { audience?: string } }>("chat")?.meta?.audience} ${invoker.id} ${getMessageText(messages[0]!)}` },
    })
    const { handlers, server } = createFakeServer(root, { default: agent })
    const plugin = (await import("../src/vite.ts")).hubAgent()

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
      driver: { run: ({ messages }) => `nuxt ${getMessageText(messages[0]!)}` },
    })
    const { handlers, server } = createFakeServer(root, { default: agent })
    const plugin = (await import("../src/vite.ts")).hubAgent()

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
      driver: { run: ({ context, input }) => `context ${context.get<{ number: number }>("pullRequest")?.number} ${input.prompt}` },
    })
    const { handlers, server } = createFakeServer(root, { default: agent })
    const plugin = (await import("../src/vite.ts")).hubAgent()

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
        github: github({ pullRequest: { reply: false, workspace: false }, webhooks: { secretToken: "secret-token" } }),
      },
      driver: { run: ({ context, input }) => {
          const github = context.get<{ command: string, repository: string }>("github")
          const pullRequest = context.get<{ pullRequest: { number: number } }>("pullRequest")
          return `context ${github?.repository}#${pullRequest?.pullRequest.number} ${github?.command} ${input.prompt}`
        } },
    })
    const { handlers, server } = createFakeServer(root, { default: agent })
    const plugin = (await import("../src/vite.ts")).hubAgent()

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
    await writeFile(join(root, "server", "agents", "review", "agent.ts"), "export default {}", "utf8")

    const { defineAgent } = await import("../src/index.ts")
    const { agentInvocationStreamHeader, agentInvocationStreamHeaderValue, agentInvocationStreamRoute } = await import("../src/invocation-stream.ts")
    const headers = {
      "content-type": "application/json",
      [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue,
    }
    const agent = defineAgent({
      name: "summary",
      driver: { run: () => "ok" },
      workspace: {},
    })
    const { handlers, server } = createFakeServer(root, { default: agent })
    const plugin = (await import("../src/vite.ts")).hubAgent()

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
        expect.objectContaining({ id: "workspace.prepare:summary", phase: "workspace.prepare", status: "started", type: "progress" }),
        expect.objectContaining({ durationMs: expect.any(Number), id: "workspace.prepare:summary", phase: "workspace.prepare", status: "completed", type: "progress" }),
        { text: "ok", type: "text-delta" },
        { type: "finish" },
        { type: "done" },
      ])
    }
  })

  it("prefers exact dev loop agent names over aliases", async () => {
    const root = await createTempRoot("vitehub-agent-invocation-stream-exact-name-")
    await mkdir(join(root, "server", "agents", "review"), { recursive: true })
    await writeFile(join(root, "server", "agents", "review", "agent.ts"), "export default {}", "utf8")
    await writeFile(join(root, "server", "agents", "summary.ts"), "export default {}", "utf8")

    const { defineAgent } = await import("../src/index.ts")
    const { agentInvocationStreamHeader, agentInvocationStreamHeaderValue, agentInvocationStreamRoute } = await import("../src/invocation-stream.ts")
    const headers = {
      "content-type": "application/json",
      [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue,
    }
    const aliasAgent = defineAgent({
      name: "summary",
      driver: { run: () => "alias" },
      workspace: {},
    })
    const exactAgent = defineAgent({
      driver: { run: () => "exact" },
    })
    const { handlers, server } = createFakeServer(root, { default: aliasAgent })
    server.ssrLoadModule.mockImplementation(async (...args: unknown[]) => String(args[0] || "").includes("/summary.ts")
      ? { default: exactAgent }
      : { default: aliasAgent })
    const plugin = (await import("../src/vite.ts")).hubAgent()

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
      driver: { run: ({ input }) => {
          abortSignal = input.abortSignal
          timeout = input.timeout
          return "Review completed."
        } },
    })

    await expect(runAgentTrigger(agent, { memo: vi.fn(), runtime: "unknown" as const, waitUntil: vi.fn() }, "github.webhook", {})).resolves.toBe("Review completed.")
    expect(reactionEffect).toHaveBeenCalledOnce()
    expect(replyEffect).toHaveBeenCalledTimes(2)
    reactionEffect.mockClear()
    replyEffect.mockClear()

    const { handlers, server } = createFakeServer(root, { default: agent })
    const plugin = (await import("../src/vite.ts")).hubAgent()

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
    expect(timeout).toBeUndefined()
  })

  it("serves plain Agent Definitions from the Agent Invocation Stream endpoint", async () => {
    const root = await createTempRoot("vitehub-agent-invocation-stream-plain-")
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await writeFile(join(root, "server", "agents", "ping.ts"), "export default {}", "utf8")

    const { defineAgent } = await import("../src/index.ts")
    const { agentInvocationStreamHeader, agentInvocationStreamHeaderValue, agentInvocationStreamRoute } = await import("../src/invocation-stream.ts")
    let abortSignal: AbortSignal | undefined
    const agent = defineAgent({
      driver: { run: ({ input }) => {
          abortSignal = input.abortSignal
          return { text: `plain ${input.messages?.[0] ? getMessageText(input.messages[0]) : ""}` }
        } },
    })
    const { handlers, server } = createFakeServer(root, { default: agent })
    const plugin = (await import("../src/vite.ts")).hubAgent()

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
        driver: { run: () => "unused" },
      }),
    })
    const plugin = (await import("../src/vite.ts")).hubAgent()

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
        driver: { run: () => "unused" },
      }),
    })
    const plugin = (await import("../src/vite.ts")).hubAgent()

    await configurePluginServer(plugin, server)

    const response = await invokeMiddleware(handlers[0]!, {}, agentInvocationStreamRoute, {}, "GET")

    expect(response.statusCode).toBe(403)
    expect(server.ssrLoadModule).not.toHaveBeenCalled()
  })

  it("serves Agent inspection through the guarded Agent Dev Loop endpoint", async () => {
    const root = await createTempRoot("vitehub-agent-inspection-")
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await writeFile(join(root, "server", "agents", "support.ts"), "export default {}", "utf8")

    const { defineAgent, defineCapability } = await import("../src/index.ts")
    const { agentInvocationStreamHeader, agentInvocationStreamHeaderValue, agentInvocationStreamRoute } = await import("../src/invocation-stream.ts")
    const { handlers, server } = createFakeServer(root, {
      default: defineAgent({
        capabilities: ({ actor }) => actor.kind === "inspection"
          ? [defineCapability({ id: "inspection-only", tools: { inspect: { name: "inspect" } } })]
          : [],
        name: "support",
        driver: { run: () => "ok" },
      }),
    })

    await configurePluginServer((await import("../src/vite.ts")).hubAgent(), server)

    const response = await invokeMiddleware(
      handlers[0]!,
      {},
      `${agentInvocationStreamRoute}?inspect=1&agent=support`,
      { [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue },
      "GET",
    )

    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({
      inspection: {
        config: { driver: { kind: "run" } },
        name: "support",
        tools: [{ name: "inspection-only" }],
      },
      root,
    })
  })

  it("provides generated runtime Capabilities to Agent Dev Loop invocations", async () => {
    const root = await createTempRoot("vitehub-agent-dev-runtime-capabilities-")
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await writeFile(join(root, "server", "agents", "calories.ts"), "export default {}", "utf8")

    const { db } = await import("../src/capabilities.ts")
    const { defineAgent } = await import("../src/index.ts")
    const { agentInvocationStreamHeader, agentInvocationStreamHeaderValue, agentInvocationStreamRoute } = await import("../src/invocation-stream.ts")
    const initialAgentDb = { query: vi.fn() }
    let agentDb = initialAgentDb
    const runtimeDbs: unknown[] = []
    const schedules = { create: vi.fn() }
    const setScheduleRuntimeRegistry = vi.fn()
    let runtimeSchedule: unknown
    const agent = defineAgent({
      capabilities: [db()],
      driver: {
        run: ({ capabilities }) => {
          runtimeDbs.push(capabilities?.db)
          runtimeSchedule = capabilities?.schedule
          return "ok"
        },
      },
    })
    const { handlers, server } = createFakeServer(root, { default: agent })
    server.ssrLoadModule.mockImplementation(async (...args: unknown[]) => {
      if (args[0] === "@vite-hub/database/drizzle") return { agentDb }
      if (args[0] === "#vitehub/schedule/registry") return { default: { reminders: vi.fn() } }
      if (args[0] === "@vite-hub/schedule/runtime") return { schedules, setScheduleRuntimeRegistry }
      return { default: agent }
    })
    const plugin = (await import("../src/vite.ts")).hubAgent()
    if (typeof plugin.configResolved === "function") {
      await plugin.configResolved.call({} as never, {
        command: "serve",
        plugins: [{ name: "@vite-hub/database/vite" }, { name: "@vite-hub/schedule/vite" }],
        root,
      } as never)
    }
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

    expect(response.body.trim().split("\n").map(line => JSON.parse(line))).toEqual([
      expect.objectContaining({ agent: "calories", type: "start" }),
      { text: "ok", type: "text-delta" },
      { type: "finish" },
      { type: "done" },
    ])
    expect(server.ssrLoadModule).toHaveBeenCalledWith("@vite-hub/database/drizzle")
    expect(runtimeDbs).toEqual([initialAgentDb])
    expect(runtimeSchedule).toEqual({ schedules })
    expect(setScheduleRuntimeRegistry).toHaveBeenCalledOnce()

    const refreshedAgentDb = { query: vi.fn() }
    agentDb = refreshedAgentDb
    await invokeMiddleware(handlers[0]!, {
      messages: [{ id: "user-2", parts: [{ text: "again", type: "text" }], role: "user" }],
    }, agentInvocationStreamRoute, {
      "content-type": "application/json",
      [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue,
    })
    expect(runtimeDbs).toEqual([initialAgentDb, refreshedAgentDb])
    expect(setScheduleRuntimeRegistry).toHaveBeenCalledTimes(2)
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
        driver: { run: () => new Response("hello from response") },
      }),
    })
    const plugin = (await import("../src/vite.ts")).hubAgent()

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


})
