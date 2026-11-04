import { afterEach, expect, it, vi } from "vitest"
import { chatgpt } from "@vite-hub/gateways"

const codex = vi.hoisted(() => ({ executable: "/fake/codex" as string | undefined }))
vi.mock("#vitehub/agent/registry", () => ({ default: {} }))
vi.mock("../src/internal/provider-runtime-packages.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/internal/provider-runtime-packages.ts")>(),
  resolveInstalledProviderExecutable: () => codex.executable,
}))

import { codexDriver, defineAgent, defineCapability, runAgent } from "../src/index.ts"

afterEach(() => {
  codex.executable = "/fake/codex"
})

function setup(connection: { status: string, plan: "enabled" | "disabled" }) {
  const prepare = vi.fn()
  const useChatGPTCredential = vi.fn()
  const agent = defineAgent({
    name: "docs", runtime: false,
    // A Capability with a prepare hook makes the Invocation check provider readiness first.
    capabilities: [defineCapability({ id: "setup", prepare })],
    driver: codexDriver({ gateway: chatgpt() }),
  })
  const host = {
    runtime: "vite" as const, memo: <T>(_key: string, create: () => T) => create(), waitUntil: () => undefined,
    capabilities: {
      connections: {
        runtime: () => ({ inspect: async () => ({ status: connection.status, chatgpt: { hostId: "urn:uuid:host", plan: connection.plan } }) }),
        useChatGPTCredential,
      },
    },
  }
  return { prepare, useChatGPTCredential, run: () => runAgent(agent, host, { prompt: "How do I install it?" }) }
}

it("asks for a ChatGPT sign-in before the Invocation prepares Capabilities", async () => {
  const test = setup({ status: "disconnected", plan: "disabled" })
  await expect(test.run()).rejects.toMatchObject({
    code: "AGENT_R1016",
    message: "The ChatGPT Connection cannot provide plan access (sign-in).",
    fix: expect.stringContaining("vitehub connections connect chatgpt"),
  })
  expect(test.prepare).not.toHaveBeenCalled()
})

it("asks for plan scopes when the grant cannot use the plan", async () => {
  await expect(setup({ status: "connected", plan: "disabled" }).run()).rejects.toMatchObject({
    code: "AGENT_R1016",
    message: "The ChatGPT Connection cannot provide plan access (scopes).",
  })
})

it("asks to install Codex when the app cannot resolve @openai/codex", async () => {
  codex.executable = undefined
  const test = setup({ status: "connected", plan: "enabled" })
  await expect(test.run()).rejects.toMatchObject({
    code: "AGENT_R1026",
    fix: expect.stringContaining("@openai/codex"),
  })
  expect(test.prepare).not.toHaveBeenCalled()
  expect(test.useChatGPTCredential).not.toHaveBeenCalled()
})

it("asks to install Codex when Codex is gone at launch", async () => {
  const agent = defineAgent({ name: "docs", runtime: false, driver: codexDriver({ gateway: chatgpt() }) })
  const host = {
    runtime: "vite" as const, memo: <T>(_key: string, create: () => T) => create(), waitUntil: () => undefined,
    capabilities: {
      connections: {
        runtime: () => ({ inspect: async () => ({ status: "connected", chatgpt: { hostId: "urn:uuid:host", plan: "enabled" } }) }),
        // Readiness found Codex. It is removed before the Driver resolves the executable that it launches.
        useChatGPTCredential: async (_name: string, _options: unknown, use: (credential: unknown) => Promise<unknown>) => {
          codex.executable = undefined
          return await use({ accessToken: "token" })
        },
      },
    },
  }
  await expect(runAgent(agent, host, { prompt: "How do I install it?" })).rejects.toMatchObject({
    code: "AGENT_R1026",
    fix: expect.stringContaining("@openai/codex"),
  })
})
