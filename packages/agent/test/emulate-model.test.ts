import { createOpenAI } from "@ai-sdk/openai"
import { ask, chatgpt, defineAiGateway } from "@vite-hub/gateways"
import { languageModel } from "@vite-hub/gateways/ai-sdk"
import { createEmulator } from "emulate"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

import { env } from "../../env/src/core/declarations.ts"
import { createRuntimeRegistry } from "../../env/src/core/resolve.ts"
import { resolveServerEnv } from "../../env/src/server.ts"

import { title } from "../src/capabilities.ts"
import { defineAgent, defineCapability, runAgent, streamAgent } from "../src/index.ts"
import { materializeAgentModel } from "../src/internal/agent-model.ts"
import { runAgentWithContext } from "../src/internal/agent-run.ts"
import { createAgentInspectionMetadata } from "../src/workspace-agent.ts"

import type { AiFormat, AiSeedConfig } from "@emulators/ai"
import type { Emulator } from "emulate"
import type { AgentTelemetry } from "../src/index.ts"

type Rule = NonNullable<AiSeedConfig["rules"]>[number]

// Server Env as hubEnv() generates it, with a required provider key that the app has not set.
const serverEnv = vi.hoisted(() => ({ registry: undefined as object | undefined }))
vi.mock("#vitehub/env/server", () => ({
  useServerEnv: () => serverEnv.registry ? resolveServerEnv(serverEnv.registry as never) : {},
}))

const formats: Record<"chat" | "messages" | "responses", AiFormat> = { chat: "openai-chat", messages: "anthropic-messages", responses: "openai-responses" }
const rules: Rule[] = [
  { id: "title", match: { textContains: "Generate a title" }, reply: [{ type: "text", text: "Emulated title" }] },
  ...Object.entries(formats).map(([api, format]): Rule => ({ id: `${api}-hello`, match: { format, textContains: "Hello" }, reply: [{ type: "text", text: `Hello from ${api}.` }] })),
]

// A credential read fails the test: an emulated run must not read a key or a ChatGPT grant.
const secretNames = /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN)$/
const credentialRead = (what: string) => new Error(`An emulated run read the credential ${what}.`)
const originalEnv = process.env
let emulator: Emulator

beforeAll(async () => {
  emulator = await createEmulator({ service: "ai", port: 0, seed: { ai: { strict: true, rules } } })
})

afterAll(async () => {
  await emulator?.close()
})

beforeEach(async () => {
  const env = Object.fromEntries(Object.entries(originalEnv).filter(([name]) => !secretNames.test(name)))
  process.env = new Proxy(env, {
    get(target, name) {
      if (typeof name === "string" && secretNames.test(name)) throw credentialRead(name)
      return Reflect.get(target, name)
    },
  })
  vi.stubEnv("VITEHUB_MODELS", "emulate")
  vi.stubEnv("VITEHUB_EMULATE_URL", emulator.url)
  await fetch(`${emulator.url}/_ai/calls`, { method: "DELETE" })
})

afterEach(() => {
  vi.unstubAllEnvs()
  process.env = originalEnv
  serverEnv.registry = undefined
})

interface Call { format: string, model: string, matched: { id?: string } | null }

async function calls(): Promise<Call[]> {
  return await (await fetch(`${emulator.url}/_ai/calls`)).json() as Call[]
}

async function matchedRules(): Promise<unknown[]> {
  return (await calls()).map(call => call.matched?.id ?? call.matched)
}

/** The diagnostic codes of an error and its causes. */
function codes(error: unknown): string[] {
  const found: string[] = []
  for (let current: unknown = error; typeof current === "object" && current !== null; current = Reflect.get(current, "cause")) {
    const code: unknown = Reflect.get(current, "code")
    if (typeof code === "string") found.push(code)
  }
  return found
}

const sealedKey = { unseal: () => { throw credentialRead("model apiKey") } }
const realGateway = defineAiGateway({
  name: "real",
  apiKey: () => { throw credentialRead("gateway apiKey") },
  baseURL: { "claude-code": "https://real.invalid", "openai-compatible": "https://real.invalid/v1" },
})
// The ChatGPT plan reads its grant through Connections. Reading the host capability fails the test.
const host = {
  runtime: "vite" as const,
  memo: <T>(_key: string, create: () => T) => create(),
  waitUntil: () => undefined,
  capabilities: { get connections(): never { throw credentialRead("ChatGPT Connection") } },
}

describe("VITEHUB_MODELS=emulate", () => {
  it("routes model IDs by prefix and reads no key", async () => {
    const models = ["openai/gpt-5.1", "anthropic/claude-sonnet-4.5", "google/gemini-3-flash", { id: "openai/gpt-5.1", apiKey: sealedKey }] as const
    for (const model of models) {
      const [error, result] = await runAgent(defineAgent({ runtime: false, driver: { instructions: "Answer briefly.", model } }), { prompt: "Hello" })
      expect(error).toBeUndefined()
      expect(result?.text).toMatch(/^Hello from (?:chat|messages|responses)\.$/)
    }
    expect(await calls()).toMatchObject([
      { format: "openai-responses", model: "openai/gpt-5.1", matched: { id: "responses-hello" } },
      { format: "anthropic-messages", model: "anthropic/claude-sonnet-4.5", matched: { id: "messages-hello" } },
      { format: "openai-chat", model: "google/gemini-3-flash", matched: { id: "chat-hello" } },
      { format: "openai-responses", model: "openai/gpt-5.1", matched: { id: "responses-hello" } },
    ])
  })

  it("sends languageModel() models to the emulator with the same model API", async () => {
    for (const api of ["chat", "responses", "messages"] as const) {
      const model = languageModel(realGateway, "real-model", { api })
      const [error, result] = await runAgent(defineAgent({ runtime: false, driver: { instructions: "Answer briefly.", model } }), { prompt: "Hello" })
      expect(error).toBeUndefined()
      expect(result?.text).toBe(`Hello from ${api}.`)
    }
    expect(await matchedRules()).toEqual(["chat-hello", "responses-hello", "messages-hello"])
  })

  it("sends chatgpt() models to the emulator without a ChatGPT grant", async () => {
    const agent = defineAgent({ name: "assistant", runtime: false, driver: { model: "gpt-6.1-sol", gateway: chatgpt(), instructions: "Answer briefly." } })
    await expect(runAgentWithContext(agent, host, { prompt: "Hello" })).resolves.toMatchObject({ text: "Hello from responses." })
    expect(await calls()).toMatchObject([{ format: "openai-responses", model: "gpt-6.1-sol", matched: { id: "responses-hello" } }])
  })

  it.each([
    { name: "a model ID", driver: { model: "openai/gpt-5.1" } },
    { name: "a ChatGPT model", driver: { model: "gpt-6.1-sol", gateway: chatgpt() } },
  ])("sends the title() model that a Capability inherits from $name to the emulator", async ({ driver }) => {
    const agent = defineAgent({ runtime: false, capabilities: [title()], driver: { ...driver, instructions: "Answer briefly." } })
    const [error, response] = await streamAgent(agent, { messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "Hello" }] }] }, { output: "ui-message-stream" })
    expect(error).toBeUndefined()
    expect(await response?.text()).toContain("Emulated title")
    await vi.waitFor(async () => expect(await matchedRules()).toEqual(expect.arrayContaining(["title", "responses-hello"])))
  })

  it("sends a model that a Capability resolves to the emulator", async () => {
    const resolved: string[] = []
    const capability = defineCapability({
      id: "resolver",
      async prepare(context) {
        const model = await context.model.resolve(languageModel(realGateway, "capability-model", { api: "chat" }))
        resolved.push(`${String(Reflect.get(model as object, "provider"))}/${String(Reflect.get(model as object, "modelId"))}`)
      },
    })
    const [error] = await runAgent(defineAgent({ runtime: false, capabilities: [capability], driver: { instructions: "Answer briefly.", model: "openai/gpt-5.1" } }), { prompt: "Hello" })
    expect(error).toBeUndefined()
    expect(resolved).toEqual(["emulate.chat/capability-model"])
  })

  it("shows gateway: \"emulate\" in inspection and Invocation metadata", async () => {
    const telemetry = vi.fn<AgentTelemetry>()
    const agent = defineAgent({
      name: "support",
      capabilities: [defineCapability({ id: "test-telemetry", telemetry: { exporter: telemetry } })],
      driver: { instructions: "Answer briefly.", model: "openai/gpt-5.1" },
    })
    expect(createAgentInspectionMetadata(agent).config?.driver.model).toEqual({ gateway: "emulate", id: "openai/gpt-5.1", provider: "emulate.responses" })
    expect(createAgentInspectionMetadata(defineAgent({ driver: { model: "gpt-6.1-sol", gateway: chatgpt() } })).config?.driver.model)
      .toEqual({ gateway: "emulate", id: "gpt-6.1-sol", provider: "emulate.responses" })
    expect(createAgentInspectionMetadata(defineAgent({ driver: { model: languageModel(realGateway, "real-model", { api: "messages" }) } })).config?.driver.model)
      .toEqual({ gateway: "emulate", id: "real-model", provider: "emulate.messages" })

    const tasks: Promise<unknown>[] = []
    await runAgentWithContext(agent, { memo: <T>(_key: string, create: () => T) => create(), runtime: "unknown", waitUntil(task) { tasks.push(Promise.resolve(task)) } }, { prompt: "Hello" })
    await Promise.all(tasks)
    const exported = telemetry.mock.calls[0]![0]
    const spans = "spans" in exported ? exported.spans : []
    const configured = spans[0]?.events?.find(event => event.name === "vitehub.agent.configured")
    expect(configured?.attributes?.["vitehub.agent.configuration"]).toMatchObject({ driver: { kind: "model", model: { gateway: "emulate", id: "openai/gpt-5.1", provider: "emulate.responses" } } })
  })

  it("reads the emulator URL without resolving unrelated Server Env", async () => {
    serverEnv.registry = createRuntimeRegistry({
      emulate: { url: env({ source: env.source("VITEHUB_EMULATE_URL"), optional: true }) },
      openai: { token: env({ source: env.source("VITEHUB_TEST_PROVIDER_TOKEN"), secret: true }) },
    }, { path: "env.server" })
    const [error, result] = await runAgent(defineAgent({ runtime: false, driver: { instructions: "Answer briefly.", model: "openai/gpt-5.1" } }), { prompt: "Hello" })
    expect(error).toBeUndefined()
    expect(result?.text).toBe("Hello from responses.")
  })

  it("sends the output schema on Chat Completions to an unseeded emulator", async () => {
    const unseeded = await createEmulator({ service: "ai", port: 0 })
    try {
      vi.stubEnv("VITEHUB_EMULATE_URL", unseeded.url)
      // Strict: the emulator, like OpenAI, rejects a strict JSON schema without `additionalProperties: false`.
      const schema = z.strictObject({ city: z.string() })
      const agent = defineAgent({ runtime: false, driver: { instructions: "Answer briefly.", model: "google/gemini-3-flash", output: { schema } } })
      const [error, result] = await runAgent(agent, { prompt: "Where?" })
      expect(error).toBeUndefined()
      expect(result?.output).toEqual({ city: expect.any(String) })
      expect(await (await fetch(`${unseeded.url}/_ai/calls`)).json()).toMatchObject([{ format: "openai-chat", outputSchema: "response", matched: { default: "json_schema" } }])
    }
    finally {
      await unseeded.close()
    }
  })

  describe("a model that replaces the Driver model", () => {
    const emulatorNamedGateway = defineAiGateway({
      name: "emulate",
      apiKey: () => { throw credentialRead("gateway apiKey") },
      baseURL: { "openai-compatible": "https://real.invalid/v1" },
    })
    const rawModel = () => {
      const fetch = vi.fn<typeof globalThis.fetch>()
      return { fetch, model: createOpenAI({ apiKey: "real", baseURL: "https://real.invalid/v1", fetch }).responses("gpt-5.1") }
    }
    const overrides = {
      prepareCall: (model: unknown) => ({ callSettings: { prepareCall: (input: object) => ({ ...input, model }) } }),
      prepareStep: (model: unknown) => ({ callSettings: { prepareStep: () => ({ model }) } }),
      instrumentation: (model: unknown) => ({ instrumentation: { model: () => model } }),
    }

    it.each(Object.keys(overrides) as (keyof typeof overrides)[])("from %s goes to the emulator", async (name) => {
      const execution = overrides[name](languageModel(emulatorNamedGateway, "override-model", { api: "chat" }))
      const [error, result] = await runAgent(defineAgent({ runtime: false, driver: { instructions: "Answer briefly.", model: "anthropic/claude-sonnet-4.5", execution } as never }), { prompt: "Hello" })
      expect(error).toBeUndefined()
      expect(result?.text).toBe("Hello from chat.")
      expect(await calls()).toMatchObject([{ format: "openai-chat", model: "override-model" }])
    })

    it.each(Object.keys(overrides) as (keyof typeof overrides)[])("from %s fails before provider I/O when it cannot go to the emulator", async (name) => {
      const { fetch, model } = rawModel()
      const [error] = await runAgent(defineAgent({ runtime: false, driver: { instructions: "Answer briefly.", model: "openai/gpt-5.1", execution: overrides[name](model) } as never }), { prompt: "Hello" })
      expect(codes(error)).toContain("AGENT_MODELS_EMULATE_MODEL_UNSUPPORTED")
      expect(fetch).not.toHaveBeenCalled()
    })
  })

  it("fails in production with a coded diagnostic", async () => {
    vi.stubEnv("NODE_ENV", "production")
    await expect(materializeAgentModel("openai/gpt-5.1", {})).rejects.toMatchObject({ code: "AGENT_MODELS_EMULATE_IN_PRODUCTION" })
    const [error] = await runAgent(defineAgent({ runtime: false, driver: { instructions: "Answer briefly.", model: "openai/gpt-5.1" } }), { prompt: "Hello" })
    expect(codes(error)).toContain("AGENT_MODELS_EMULATE_IN_PRODUCTION")
    expect(await calls()).toEqual([])
  })

  it("fails on an unknown switch value instead of calling the real provider", async () => {
    vi.stubEnv("VITEHUB_MODELS", "emulator")
    await expect(materializeAgentModel("openai/gpt-5.1", {})).rejects.toMatchObject({ code: "AGENT_MODELS_INVALID" })
  })

  it("fails for a model object that it cannot send to the emulator", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    const model = createOpenAI({ apiKey: "real", baseURL: "https://real.invalid/v1", fetch }).responses("gpt-5.1")
    const [error] = await runAgent(defineAgent({ runtime: false, driver: { instructions: "Answer briefly.", model } }), { prompt: "Hello" })
    expect(codes(error)).toContain("AGENT_MODELS_EMULATE_MODEL_UNSUPPORTED")
    expect(fetch).not.toHaveBeenCalled()
    expect(await calls()).toEqual([])
  })

  it("fails for Jev questions", async () => {
    const agent = defineAgent({ runtime: false, driver: { ask: { label: ask.choice("Pick one", ["a", "b"]) } } })
    const [error] = await runAgent(agent, { prompt: "Hello" })
    expect(codes(error)).toContain("AGENT_MODELS_EMULATE_ASK_UNSUPPORTED")
  })
})
