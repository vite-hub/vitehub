import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { afterEach, expect, it } from "vitest"
import * as v from "valibot"
import { chatgpt as chatgptGateway } from "@vite-hub/gateways"
import { chatgpt } from "../../connections/src/chatgpt.ts"
import { defineConnection } from "../../connections/src/definition.ts"
import { useChatGPTCredential } from "../../connections/src/internal/agent-credential.ts"
import { createConnectionsRuntime } from "../../connections/src/runtime.ts"
import { createChatGPTFake } from "../../connections/test/chatgpt-fake.ts"
import { createStore } from "../../connections/test/helpers.ts"
import { defineAgent, defineCapability, runAgent } from "../src/index.ts"
import type { AgentRunInput } from "../src/types.ts"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const realCodex = it.runIf(Boolean(process.env.VITEHUB_TEST_REAL_CODEX))

async function fixture(options: { expiresIn?: number } = {}) {
  const fake = await createChatGPTFake()
  cleanup.push(fake.close)
  if (options.expiresIn) fake.state.expiresIn = options.expiresIn
  await mkdir(".vitest-tmp", { recursive: true })
  const root = await mkdtemp(resolve(".vitest-tmp", "siwc-codex-"))
  cleanup.push(() => rm(root, { force: true, recursive: true }))
  const home = join(root, "codex-home")
  await mkdir(home, { mode: 0o700 })
  const probe = join(root, "untrusted-probe.cjs")
  const marker = join(root, "untrusted-config-ran")
  await writeFile(probe, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, process.env.VITEHUB_CHATGPT_ACCESS_TOKEN || "ran")`)
  const untrustedConfig = `[mcp_servers.inherited]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(probe)}]\nenv_vars = ["VITEHUB_CHATGPT_ACCESS_TOKEN"]\n[features]\napps = true\nplugins = true\nhooks = true\ncodex_hooks = true\n[projects.${JSON.stringify(root)}]\ntrust_level = "trusted"\n`
  await writeFile(join(home, "config.toml"), untrustedConfig)
  await mkdir(join(root, ".codex"))
  await writeFile(join(root, ".codex", "config.toml"), untrustedConfig)
  const hooks = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: `${JSON.stringify(process.execPath)} ${JSON.stringify(probe)}` }] }] } })
  await writeFile(join(home, "hooks.json"), hooks)
  await writeFile(join(root, ".codex", "hooks.json"), hooks)
  const store = createStore()
  const runtime = createConnectionsRuntime({
    definitions: { chatgpt: defineConnection({ provider: { ...chatgpt({ appName: "My SIWC app", appVersion: "1.0.0" }), api: `${fake.origin}/v1` }, access: { "agent:assistant": { read: true } } }) },
    store, fetch: fake.fetch,
  })
  const authorization = await runtime.authorize({ name: "chatgpt", redirectUri: "http://127.0.0.1:1455/callback" })
  const callback = await fake.callback(authorization.url)
  await runtime.complete({ state: callback.searchParams.get("state")!, code: callback.searchParams.get("code")!, clientId: callback.searchParams.get("client_id")! })
  const calls: string[] = []
  const agent = defineAgent({
    name: "assistant", runtime: false,
    capabilities: [defineCapability({ id: "siwc-test", tools: { siwc_echo: { name: "siwc_echo", description: "Echo a value.", inputSchema: v.object({ text: v.string() }), execute: async ({ text }) => { calls.push(text); return text } } } })],
    driver: { kind: "codex", gateway: chatgptGateway(), model: "gpt-6.1-sol", cwd: root,
      permissions: "allow-edits-unattended",
      env: { CODEX_HOME: home, HOME: root, XDG_CONFIG_HOME: root },
      instructions: "Reply with a short greeting.",
    },
  })
  const host = {
    runtime: "vite" as const, memo: <T>(_key: string, create: () => T) => create(), waitUntil: () => undefined,
    capabilities: { connections: { runtime: () => runtime, useChatGPTCredential: useChatGPTCredential(runtime) } },
  }
  return { agent, calls, fake, root, runtime, store, run: (messages?: AgentRunInput["messages"]) => runAgent(agent, host, { messages, prompt: messages ? undefined : "Hello", context: { "chat.sessionId": "siwc-session" }, timeout: 30_000 }) }
}

realCodex("runs a Capability and shell through real Codex without exposing the access token", async () => {
  const test = await fixture()
  test.fake.state.onResponse = () => test.fake.state.requests.length === 1 ? {
    type: "custom_tool_call", call_id: "call_siwc_tools", name: "exec", namespace: "functions", status: "completed", id: "ctc_siwc_tools",
    input: 'text(await tools.mcp__t3_code__siwc_echo({text:"SIWC_CAPABILITY_OK"})); text(await tools.exec_command({cmd:"env",max_output_tokens:3000}))',
  } : undefined
  const result = await test.run()
  expect(result).toMatchObject({ text: expect.stringContaining("Hello from the local ChatGPT fake.") })
  expect(test.calls).toEqual(["SIWC_CAPABILITY_OK"])
  expect(test.fake.state.requests).toHaveLength(2)
  await expect(readFile(join(test.root, "untrusted-config-ran"))).rejects.toMatchObject({ code: "ENOENT" })
  expect(test.fake.state.originators.every(value => value === "My SIWC app")).toBe(true)
  for (const request of test.fake.state.requests) {
    expect(request).toMatchObject({ store: false, stream: true, model: "gpt-6.1-sol", input: expect.any(Array) })
    for (const key of ["temperature", "top_p", "max_output_tokens", "max_tool_calls", "background", "conversation", "metadata", "previous_response_id", "moderation", "multi_agent", "prompt", "prompt_cache_retention", "safety_identifier", "top_logprobs", "truncation", "user"]) expect(key in request).toBe(false)
    expect(JSON.stringify(request)).not.toMatch(/"type":"(?:tool_search|mcp|image_generation|computer_use|code_interpreter|file_search)"/)
    expect(JSON.stringify(request)).not.toContain('"role":"system"')
  }
  const transcript = JSON.stringify(test.fake.state.requests[1]?.input)
  expect(transcript).toContain("SIWC_CAPABILITY_OK")
  const isolatedHome = /CODEX_HOME=([^\\\s]+)/.exec(transcript)?.[1]
  expect(isolatedHome).toContain("vitehub-provider-launch-")
  expect(isolatedHome).not.toBe(join(test.root, "codex-home"))
  await expect(readdir(isolatedHome!)).rejects.toMatchObject({ code: "ENOENT" })
  // The native shell gets an empty variable, not a redacted leaked value.
  expect(/VITEHUB_CHATGPT_ACCESS_TOKEN=(?:\\)+n/.test(transcript)).toBe(true)
  expect(transcript).not.toMatch(/test-access-|test-refresh-/)
  expect(JSON.stringify(result)).not.toMatch(/test-access-|test-refresh-/)
  for (const entry of await readdir(test.root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const content = await readFile(join(entry.parentPath, entry.name))
    expect(content.includes("test-access-"), entry.name).toBe(false)
    expect(content.includes("test-refresh-"), entry.name).toBe(false)
  }
}, 45_000)

realCodex("continues a conversation by replaying history into the next isolated home", async () => {
  const test = await fixture()
  const first = v.parse(v.object({ text: v.string() }), await test.run([{ id: "message-1", role: "user", parts: [{ type: "text", text: "Remember the word aubergine." }] }]))
  await test.run([
    { id: "message-1", role: "user", parts: [{ type: "text", text: "Remember the word aubergine." }] },
    { id: "message-2", role: "assistant", parts: [{ type: "text", text: first.text }] },
    { id: "message-3", role: "user", parts: [{ type: "text", text: "What word did I ask you to remember?" }] },
  ])
  expect(test.fake.state.requests).toHaveLength(2)
  const second = JSON.stringify(test.fake.state.requests[1]?.input)
  expect(second).toContain("Remember the word aubergine.")
  expect(second).toContain(first.text)
  expect(second).toContain("What word did I ask you to remember?")
}, 45_000)

realCodex.each([
  [429, "subscription_sharing_usage_limit_exceeded", "AGENT_R1017"],
  [403, "subscription_sharing_user_not_eligible", "AGENT_R1022"],
  [400, "subscription_sharing_unsupported_capability", "AGENT_R1019"],
  [401, "subscription_sharing_invalid_user", "AGENT_R1016"],
  [503, "subscription_sharing_usage_unavailable", "AGENT_R1020"],
  [503, "subscription_sharing_user_unavailable", "AGENT_R1020"],
  [403, "chatpass_v2_configuration", "AGENT_R1022"],
])("maps HTTP %s %s through real Codex", async (status, code, diagnostic) => {
  const test = await fixture()
  test.fake.state.responseError = { status, code }
  const failure: unknown = await test.run().catch((error: unknown) => error)
  expect(failure).toMatchObject({ code: diagnostic })
  expect(JSON.stringify(failure)).not.toMatch(/test-access-|test-refresh-|test-secret-do-not-echo/)
  expect(test.fake.state.requests.length).toBeGreaterThan(0)
  expect(test.fake.state.requests.length).toBeLessThanOrEqual(3)
  expect((await test.runtime.inspect("chatgpt")).status).toBe("connected")
}, 45_000)

realCodex("stops an Invocation at token expiry and resolves a fresh token for the next Invocation", async () => {
  const test = await fixture({ expiresIn: 3 })
  test.fake.state.stallResponses = true
  await expect(test.run()).rejects.toMatchObject({ code: "AGENT_R1024" })
  test.fake.state.stallResponses = false
  test.fake.state.expiresIn = 3600
  expect(await test.run()).toMatchObject({ text: expect.stringContaining("Hello from the local ChatGPT fake.") })
  expect(test.fake.state.refreshes).toBeGreaterThanOrEqual(2)
}, 45_000)

realCodex("reports invalid_client as configuration failure without attempting inference", async () => {
  const test = await fixture({ expiresIn: 3 })
  test.fake.state.tokenError = "invalid_client"
  await expect(test.run()).rejects.toMatchObject({ code: "AGENT_R1021" })
  expect(test.fake.state.requests).toHaveLength(0)
  expect((await test.runtime.inspect("chatgpt")).status).toBe("connected")
})

realCodex.each([
  "subscription_sharing_usage_limit_exceeded",
  "subscription_sharing_usage_unavailable",
])("reports a failed SSE response when Codex discards %s", async (code) => {
  const test = await fixture()
  test.fake.state.streamError = code
  const failure: unknown = await test.run().catch((error: unknown) => error)
  expect(failure).toMatchObject({ code: "AGENT_R1023" })
  expect(JSON.stringify(failure)).not.toMatch(/test-access-|test-refresh-|test-secret-do-not-echo/)
  expect(test.fake.state.requests).toHaveLength(1)
}, 45_000)
