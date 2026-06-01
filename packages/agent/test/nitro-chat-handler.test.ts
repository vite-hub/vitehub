import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createApp, toWebHandler } from "h3"
import { describe, expect, it, vi } from "vitest"

import { chat } from "../src/capabilities.ts"

import type { UIMessage } from "ai"

interface TestNitroHandler {
  handler: string
  method: string
  route: string
}

async function createTempRoot(prefix: string) {
  return await mkdtemp(join(tmpdir(), prefix))
}

function messageText(message: { parts?: Array<{ text?: unknown, type?: unknown }> }): string {
  return (message.parts || [])
    .filter(part => part.type === "text" && typeof part.text === "string")
    .map(part => part.text)
    .join("")
}

describe("agent Nitro chat routes", () => {
  it("exposes chat.message through an AI SDK-compatible route", async () => {
    const { DefaultChatTransport, readUIMessageStream } = await import("ai")
    const { defineAgent } = await import("../src/index.ts")
    const { defineAgentChatHandler } = await import("../src/nitro.ts")
    const seen: Array<{ chat: unknown, messages: string[], run: unknown }> = []
    const agent = defineAgent({
      capabilities: [chat({ app: true, sessions: true })],
      run(context) {
        seen.push({
          chat: context.input.context?.chat,
          messages: context.messages.map(messageText),
          run: context.run,
        })
        return "agent answer"
      },
    })
    const app = createApp()
    app.use(defineAgentChatHandler(agent, { inferredName: "support" }))
    const webHandler = toWebHandler(app)
    const transport = new DefaultChatTransport<UIMessage>({
      api: "https://example.test/api/_vitehub/agents/support/chat",
      fetch: async (input, init) => await webHandler(new Request(input, init)),
    })

    const stream = await transport.sendMessages({
      abortSignal: undefined,
      chatId: "support-session",
      messageId: undefined,
      messages: [{
        id: "user-1",
        metadata: { selection: { label: "Availability", value: "82.4%" } },
        parts: [{ text: "hello from Nuxt UI", type: "text" }],
        role: "user",
      }],
      trigger: "submit-message",
    })
    const messages: UIMessage[] = []
    for await (const message of readUIMessageStream({ stream })) {
      messages.push(message)
    }

    expect(messageText(messages.at(-1)!)).toBe("agent answer")
    expect(seen).toEqual([{
      chat: expect.objectContaining({
        message: {
          id: "user-1",
          metadata: { selection: { label: "Availability", value: "82.4%" } },
          text: "hello from Nuxt UI",
        },
        session: { id: "support-session" },
      }),
      messages: ["hello from Nuxt UI"],
      run: expect.objectContaining({
        messageId: "user-1",
        origin: "http",
        threadId: "support-session",
      }),
    }])
  })

  it("requires an agent route param for registry chat handlers", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { defineAgentChatRegistryHandler } = await import("../src/nitro.ts")
    const agent = defineAgent({
      capabilities: [chat({ app: true })],
      run: () => "registry answer",
    })
    const app = createApp()
    app.use(defineAgentChatRegistryHandler({
      support: async () => agent,
    }))
    const webHandler = toWebHandler(app)
    const response = await webHandler(new Request("https://example.test/api/_vitehub/agents/support/chat", {
      body: JSON.stringify({
        id: "support-session",
        messages: [{ id: "user-1", parts: [{ text: "hello", type: "text" }], role: "user" }],
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }))

    expect(response.status).toBe(400)
    expect(await response.text()).toContain("Missing agent route param: agent")
  })

  it("returns a bad request when the chat route receives no UI messages", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { defineAgentChatHandler } = await import("../src/nitro.ts")
    const app = createApp()
    app.use(defineAgentChatHandler(defineAgent({
      capabilities: [chat({ app: true })],
      run: () => "agent answer",
    })))
    const response = await toWebHandler(app)(new Request("https://example.test/api/_vitehub/agents/support/chat", {
      body: JSON.stringify({ id: "support-session" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }))

    expect(response.status).toBe(400)
    expect(await response.text()).toContain("Agent chat route requires messages.")
  })

  it("uses the configured Chat App Route origin instead of request body origin", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { defineAgentChatHandler } = await import("../src/nitro.ts")
    let seenRun: unknown
    const app = createApp()
    app.use(defineAgentChatHandler(defineAgent({
      capabilities: [chat({ app: "portal" })],
      run(context) {
        seenRun = context.run
        return "agent answer"
      },
    })))
    const response = await toWebHandler(app)(new Request("https://example.test/api/_vitehub/agents/support/chat", {
      body: JSON.stringify({
        id: "support-session",
        messages: [{ id: "user-1", parts: [{ text: "hello", type: "text" }], role: "user" }],
        run: { origin: "teams" },
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }))

    expect(response.status).toBe(200)
    expect(seenRun).toEqual(expect.objectContaining({
      messageId: "user-1",
      origin: "portal",
      threadId: "support-session",
    }))
  })

  it("does not expose agents without Chat App Exposure through chat route handlers", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { defineAgentChatHandler } = await import("../src/nitro.ts")
    const app = createApp()
    app.use(defineAgentChatHandler(defineAgent({
      capabilities: [chat()],
      run: () => "agent answer",
    })))
    const response = await toWebHandler(app)(new Request("https://example.test/api/_vitehub/agents/support/chat", {
      body: JSON.stringify({
        id: "support-session",
        messages: [{ id: "user-1", parts: [{ text: "hello", type: "text" }], role: "user" }],
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }))

    expect(response.status).toBe(404)
    expect(await response.text()).toContain("does not expose a Chat App Route")
  })

  it("generates app chat routes from Chat App Exposure", async () => {
    const root = await createTempRoot("vitehub-agent-chat-app-route-")
    const buildDir = ".nitro"
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await writeFile(join(root, "server", "agents", "support.ts"), [
      "import { defineAgent } from '@vite-hub/agent'",
      "import { chat } from '@vite-hub/agent/capabilities'",
      "export default defineAgent({",
      "  capabilities: [chat({ app: true })],",
      "  run: () => 'ok',",
      "})",
    ].join("\n"), "utf8")

    const module = (await import("../src/nitro/module.ts")).default
    const handlers: TestNitroHandler[] = []
    const nitro = {
      hooks: {
        hook: vi.fn(),
      },
      options: {
        agent: {},
        alias: {},
        buildDir,
        handlers,
        imports: {},
        rootDir: root,
        runtimeConfig: {},
        scanDirs: [join(root, "server")],
      },
    }

    await module.setup(nitro as never)

    const route = nitro.options.handlers.find(handler => handler.route === "/api/_vitehub/agents/:agent/chat")
    expect(route).toMatchObject({ method: "POST" })
    await expect(readFile(route!.handler, "utf8")).resolves.toContain("defineAgentChatRegistryHandler(agentRegistry)")
    expect(nitro.options.handlers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        handler: route!.handler,
        method: "POST",
        route: "/api/_vitehub/agents/:agent/chat",
      }),
    ]))
    expect(nitro.options.handlers).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        route: "/api/chat",
      }),
    ]))
  })

  it("does not source-scan custom app chat route paths", async () => {
    const root = await createTempRoot("vitehub-agent-chat-app-custom-route-")
    const buildDir = ".nitro"
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await writeFile(join(root, "server", "agents", "support.ts"), [
      "import { defineAgent } from '@vite-hub/agent'",
      "import { chat } from '@vite-hub/agent/capabilities'",
      "export default defineAgent({",
      "  capabilities: [chat({ app: { route: '/api/support-chat' } })],",
      "  run: () => 'ok',",
      "})",
    ].join("\n"), "utf8")

    const module = (await import("../src/nitro/module.ts")).default
    const handlers: TestNitroHandler[] = []
    const nitro = {
      hooks: {
        hook: vi.fn(),
      },
      options: {
        agent: {},
        alias: {},
        buildDir,
        handlers,
        imports: {},
        rootDir: root,
        runtimeConfig: {},
        scanDirs: [join(root, "server")],
      },
    }

    await module.setup(nitro as never)

    expect(nitro.options.handlers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: "POST",
        route: "/api/_vitehub/agents/:agent/chat",
      }),
    ]))
    expect(nitro.options.handlers).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        route: "/api/support-chat",
      }),
    ]))
  })
})
