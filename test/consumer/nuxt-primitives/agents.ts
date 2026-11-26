import { once } from "node:events"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"

import { afterAll } from "vitest"

import { startAiEmulator, type AiEmulator } from "../../../packages/agent/src/internal/ai-emulator.ts"
import { expectJson, type PrimitiveRow } from "./row.ts"

const emulatorPackages = { "@emulators/ai": "0.14.0", "@emulators/core": "0.14.0" }
const greeting = "Hello from the AI emulator."

async function startEchoServer() {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ authorization: request.headers.authorization ?? null, path: request.url }))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  server.unref()
  afterAll(() => { server.close() })
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const echoOrigin = process.env.VITEHUB_CONSUMER_CONTRACT === "1" ? await startEchoServer() : "http://127.0.0.1:9"

let emulator: Promise<AiEmulator> | undefined
function testEmulator() {
  emulator ??= startAiEmulator({ rules: [{ id: "primitives", match: { textContains: "ping" }, reply: [{ type: "text", text: "pong from the emulator" }] }], strict: true })
  return emulator
}
afterAll(async () => {
  await (await emulator)?.close()
})

async function poll(read: () => Promise<Response>, expected: unknown) {
  const deadline = Date.now() + 30_000
  while (true) {
    const response = await read()
    try {
      return await expectJson(response, expected)
    }
    catch (error) {
      if (Date.now() > deadline) throw error
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  }
}

function postJson(body: unknown): RequestInit {
  return { body: JSON.stringify(body), headers: { "content-type": "application/json" }, method: "POST" }
}

export const agents: PrimitiveRow[] = [
  {
    id: "agent",
    packages: ["@vite-hub/agent"],
    dependencies: { "@ai-sdk/openai": "4.0.122", ai: "7.0.179", ...emulatorPackages },
    vitehub: target => ({
      agent: {
        models: { emulate: { rules: [{ id: "greet", match: { textContains: "hello" }, reply: [{ type: "text", text: greeting }] }] } },
        ...(target === "node" ? { providers: { state: { driver: "libsql", url: "file:.vitehub/data/agent-state.sqlite" } } } : {}),
      },
    }),
    files: {
      "server/agents/greeting.ts": `
        import { defineAgent } from "vite-hub/agent"

        export default defineAgent({
          runtime: false,
          driver: { run: ({ prompt }) => ({ text: \`Hello, \${String(prompt)}.\` }) },
        })
      `,
      "server/agents/greeter.ts": `
        import { defineAgent } from "vite-hub/agent"

        export default defineAgent({
          runtime: false,
          driver: { model: "openai/gpt-5.1" },
        })
      `,
      "server/api/primitives/agent.ts": `
        import { defineEventHandler, getQuery, readBody } from "nitro/h3"
        import { runAgent } from "vite-hub/agent"
        import greeter from "../../agents/greeter"
        import greeting from "../../agents/greeting"

        export default defineEventHandler(async (event) => {
          const { prompt } = await readBody<{ prompt: string }>(event)
          const [error, result] = await runAgent(getQuery(event).agent === "greeter" ? greeter : greeting, { prompt })
          if (error) throw error
          return { text: result.text }
        })
      `,
    },
    async probe({ fetch, mode }) {
      await expectJson(await fetch("/api/primitives/agent", postJson({ prompt: mode })), { text: `Hello, ${mode}.` })
      const emulatorRuns = mode.endsWith("-dev")
      if (emulatorRuns) await expectJson(await fetch("/api/primitives/agent?agent=greeter", postJson({ prompt: "hello there" })), { text: greeting })
    },
  },
  {
    id: "channels",
    packages: ["@vite-hub/agent", "@vite-hub/channels"],
    files: {
      "server/utils/primitive-inbox.ts": `
        const store = globalThis as typeof globalThis & { primitiveInbox?: string[] }
        export const primitiveInbox = store.primitiveInbox ??= []
      `,
      "server/channels/alerts.ts": `
        import { defineChannel } from "vite-hub/channels"

        export default defineChannel({
          adapter: {
            kind: "log",
            send: (text: string, { label }: { label: string }) => ({ id: \`\${label}:\${text}\` }),
          },
        })
      `,
      "server/channels/tickets.ts": `
        import { defineChannel, defineChannelTrigger } from "vite-hub/channels"
        import { webhook } from "vite-hub/channels/adapters"

        export default defineChannel({
          adapter: webhook({ secret: false }),
          on: {
            webhook: defineChannelTrigger({
              invoke: (_context, { payload }: { payload: { text: string } }) => ({ input: { prompt: payload.text } }),
            }),
          },
        })
      `,
      "server/agents/ticketing.ts": `
        import { defineAgent } from "vite-hub/agent"
        import { primitiveInbox } from "../utils/primitive-inbox"

        export default defineAgent({
          channels: ["tickets"],
          runtime: false,
          driver: {
            run: ({ prompt }) => {
              primitiveInbox.push(String(prompt))
              return { text: "received" }
            },
          },
        })
      `,
      "server/api/primitives/channels.ts": `
        import { defineEventHandler, getQuery, readBody } from "nitro/h3"
        import { useChannel } from "vite-hub/channels/server"
        import { primitiveInbox } from "../../utils/primitive-inbox"

        export default defineEventHandler(async (event) => {
          if (event.req.method === "GET") return { received: primitiveInbox.includes(String(getQuery(event).text)) }
          const { text } = await readBody<{ text: string }>(event)
          const [error, receipt] = await useChannel("alerts").send(text, { label: "primitives" })
          if (error) throw error
          return { channel: receipt.channel, id: receipt.id }
        })
      `,
    },
    async probe({ fetch, mode }) {
      await expectJson(await fetch("/api/primitives/channels", postJson({ text: mode })), { channel: "alerts", id: `primitives:${mode}` })
      const text = `${mode}-${crypto.randomUUID()}`
      const webhook = await fetch("/_vitehub/channels/tickets", postJson({ text }))
      if (!webhook.ok) throw new Error(`/_vitehub/channels/tickets answered ${webhook.status}: ${(await webhook.text()).slice(0, 2000)}`)
      await webhook.body?.cancel()
      await poll(() => fetch(`/api/primitives/channels?text=${text}`), { received: true })
    },
  },
  {
    id: "connections",
    packages: ["@vite-hub/connections"],
    files: {
      "server/connections/echo.ts": `
        import { apiKey, defineConnection } from "vite-hub/connections"

        export default defineConnection({
          provider: apiKey({ id: "echo", origins: [${JSON.stringify(echoOrigin)}], fallback: () => "primitives-key" }),
          access: { primitives: { read: true } },
        })
      `,
      "server/api/primitives/connections.ts": `
        import { defineEventHandler } from "nitro/h3"
        import { useConnection } from "vite-hub/connections/server"

        export default defineEventHandler(async () => {
          const [error, response] = await useConnection("echo", { actor: "primitives" }).fetch(${JSON.stringify(`${echoOrigin}/primitives`)})
          if (error) throw error
          return await response.json()
        })
      `,
    },
    async probe({ fetch }) {
      await expectJson(await fetch("/api/primitives/connections"), { authorization: "Bearer primitives-key", path: "/primitives" })
    },
  },
  {
    id: "gateways",
    packages: ["@vite-hub/gateways"],
    dependencies: { "@ai-sdk/openai-compatible": "3.0.94", ai: "7.0.179" },
    files: {
      "server/api/primitives/gateways.ts": `
        import { generateText } from "ai"
        import { defineEventHandler, readBody } from "nitro/h3"
        import { emulate } from "vite-hub/gateways"
        import { languageModel } from "vite-hub/gateways/ai-sdk"

        export default defineEventHandler(async (event) => {
          const { prompt, url } = await readBody<{ prompt: string, url: string }>(event)
          const { text } = await generateText({ model: languageModel(emulate({ url }), "primitives-model", { api: "chat" }), prompt })
          return { text }
        })
      `,
    },
    async probe({ fetch }) {
      const { url } = await testEmulator()
      await expectJson(await fetch("/api/primitives/gateways", postJson({ prompt: "ping", url })), { text: "pong from the emulator" })
    },
  },
  {
    id: "mcp",
    packages: ["@vite-hub/mcp"],
    dependencies: { zod: "4.6.7" },
    vitehub: () => ({ mcp: { auth: false } }),
    files: {
      "server/mcp/tools/add.ts": `
        import { defineMcpTool } from "vite-hub/mcp"
        import { z } from "zod"

        export default defineMcpTool({
          description: "Add two numbers.",
          input: z.object({ a: z.number(), b: z.number() }),
          handler: ({ a, b }) => ({ sum: a + b }),
        })
      `,
    },
    async probe({ fetch }) {
      const response = await fetch("/mcp", {
        body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/call", params: { arguments: { a: 2, b: 3 }, name: "add" } }),
        headers: { accept: "application/json, text/event-stream", "content-type": "application/json", "mcp-protocol-version": "2025-11-25" },
        method: "POST",
      })
      const body = await response.text()
      if (!response.ok) throw new Error(`/mcp answered ${response.status}: ${body.slice(0, 2000)}`)
      const { result } = JSON.parse(body) as { result?: { isError?: boolean, structuredContent?: unknown } }
      if (result?.isError || JSON.stringify(result?.structuredContent) !== JSON.stringify({ sum: 5 })) throw new Error(`/mcp answered ${body}, expected the structured content {"sum":5}`)
    },
  },
  {
    id: "choices",
    packages: ["@vite-hub/choices"],
    files: {
      "server/api/primitives/choices.ts": `
        import { defineEventHandler, getQuery } from "nitro/h3"
        import { defineChoices } from "vite-hub/choices"
        import { wordGateway } from "vite-hub/choices/testing"

        const suppliers = defineChoices({
          name: "suppliers",
          gateway: wordGateway(),
          groups: { supplier: { label: "Supplier", options: [{ value: "nord", label: "Nord" }, { value: "vak", label: "Vak" }] } },
        })

        export default defineEventHandler(async (event) => {
          const [error, selection] = await suppliers.resolve(String(getQuery(event).text))
          if (error) throw error
          return selection
        })
      `,
    },
    async probe({ fetch }) {
      await expectJson(await fetch("/api/primitives/choices?text=nord parts except vak supply"), { supplier: { exclude: ["vak"], include: ["nord"] } })
    },
  },
]
