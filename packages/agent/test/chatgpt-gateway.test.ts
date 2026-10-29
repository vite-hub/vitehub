import { describe, expect, it } from "vitest"
import { chatgpt } from "@vite-hub/gateways"
import { defineAgent } from "../src/index.ts"
import { chatgptCodexGateway, chatgptCodexLaunchArgs, chatgptProviderError } from "../src/internal/chatgpt-gateway.ts"
import { normalizeAgentDriver } from "../src/internal/agent-driver.ts"
import { execFileSync } from "node:child_process"

it("describes a Connection without credentials and accepts only a local Codex Driver", () => {
  expect(chatgpt()).toEqual({ kind: "chatgpt", name: "chatgpt", connection: "chatgpt" })
  expect(normalizeAgentDriver({ driver: { kind: "codex", gateway: chatgpt() } })).toMatchObject({ gateway: chatgpt() })
  expect(() => defineAgent({ driver: { kind: "claude-code", gateway: chatgpt() } })).toThrow("does not serve")
  expect(() => defineAgent({ driver: { kind: "codex", gateway: chatgpt(), launch: { command: "custom" } } })).toThrow(expect.objectContaining({ code: "AGENT_R1015" }))
  expect(() => defineAgent({ driver: { kind: "codex", gateway: chatgpt(), providerSettings: { launchArgs: "--enable image_generation" } } })).toThrow(expect.objectContaining({ code: "AGENT_R1015" }))
  expect(() => defineAgent({ driver: { kind: "codex", gateway: chatgpt() }, sandbox: { runtime: {} } } as never)).toThrow(expect.objectContaining({ code: "AGENT_R1015" }))
})

it.each(["binaryPath", "homePath", "shadowHomePath"])("rejects caller-owned %s for ChatGPT", (setting) => {
  expect(() => defineAgent({ driver: { kind: "codex", gateway: chatgpt(), providerSettings: { [setting]: "/tmp/caller-owned" } } })).toThrow(expect.objectContaining({ code: "AGENT_R1015" }))
})

it("sets the exact Codex plan profile and keeps the token out of arguments", () => {
  const gateway = chatgptCodexGateway({ accessToken: "local-test-token", expiresAt: 123, api: "https://api.openai.com/v1", clientInfo: { name: "App", title: "App", version: "1" } })
  expect(gateway.environment).toEqual({ VITEHUB_CHATGPT_ACCESS_TOKEN: "" })
  expect(gateway.launchArgs).toBeUndefined()
  const launchArgs = chatgptCodexLaunchArgs("http://127.0.0.1:1234")
  const args: unknown = JSON.parse(execFileSync("sh", ["-c", `exec "$1" -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' -- ${launchArgs}`, "sh", process.execPath], { encoding: "utf8" }))
  expect(args).toEqual([
    "-c", 'model_provider="openai_chatgpt_plan"',
    "-c", 'model_providers.openai_chatgpt_plan={name="ChatGPT plan",base_url="http://127.0.0.1:1234",wire_api="responses",requires_openai_auth=false,supports_websockets=false,request_max_retries=2,stream_max_retries=0}',
    ...["apps", "plugins", "image_generation", "computer_use", "browser_use", "code_mode_tool_search", "code_mode", "multi_agent", "hooks", "codex_hooks"].flatMap(feature => ["-c", `features.${feature}=false`]),
    "-c", 'shell_environment_policy.set.VITEHUB_CHATGPT_ACCESS_TOKEN=""',
  ])
  expect(launchArgs).not.toContain("local-test-token")
})

describe("ChatGPT recovery diagnostics", () => {
  it.each([
    ["subscription_sharing_usage_limit_exceeded", "AGENT_R1017", "https://chatgpt.com/settings/usage"],
    ["subscription_sharing_user_not_eligible", "AGENT_R1018", "eligible"],
    ["subscription_sharing_unsupported_capability", "AGENT_R1019", "function tools"],
    ["subscription_sharing_invalid_user", "AGENT_R1016", "connect chatgpt"],
    ["subscription_sharing_usage_unavailable", "AGENT_R1020", "Retry later"],
    ["subscription_sharing_user_unavailable", "AGENT_R1020", "Retry later"],
    ["chatpass_v2_test", "AGENT_R1021", "client ID"],
    ["subscription_sharing_route_not_supported", "AGENT_R1021", "POST /v1/responses"],
  ])("maps %s without returning provider text", (code, diagnostic, recovery) => {
    const error = chatgptProviderError(`HTTP failed: ${code}; test-secret-do-not-echo`)
    expect(error).toMatchObject({ code: diagnostic })
    expect(JSON.stringify(error)).toContain(recovery)
    expect(JSON.stringify(error)).not.toContain("test-secret-do-not-echo")
  })
})
