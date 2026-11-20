import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { emulate } from "@vite-hub/gateways"
import { resolveAiGatewayRoute } from "@vite-hub/gateways/internal"

import { agentDiagnostics } from "../agent-diagnostics.ts"
import { isModelEmulationRequested, resolveModelEmulation } from "./agent-emulation.ts"
import { codexGateway } from "./agent-gateway.ts"
import { readHostEnv } from "./builtin-env.ts"
import { codexConfigArg } from "./codex-launch-args.ts"
import { withProviderStatusError } from "./provider-status-error.ts"

import type { AgentProviderCredentialContext, AgentProviderStatus } from "../types.ts"
import type { ResolvedAgentDriverGateway } from "./agent-gateway.ts"

/**
 * Codex features that the emulator rejects or that reach a service other than the emulator. `multi_agent` and
 * `multi_agent_v2` send their tools in a `namespace` tool, which the emulator rejects. `goals` adds goal tools to every
 * request, so the call record shows only the tools of the run. `apps` and `plugins` connect to OpenAI services.
 */
const disabledCodexFeatures = ["apps", "plugins", "multi_agent", "multi_agent_v2", "goals"] as const

/**
 * A Codex model catalog with one hidden placeholder model. The catalog of Codex gives OpenAI models, such as `gpt-5.5`,
 * a freeform `apply_patch` tool (`"type": "custom"`), which the emulator rejects. With this catalog, every model ID uses
 * the generic model settings of Codex, which send only function tools, and the request keeps the model ID. Codex has
 * no config key that turns off the freeform tool, and it rejects an empty catalog.
 */
const emulatedCodexModelCatalog = JSON.stringify({
  models: [{
    slug: "vitehub-emulator",
    display_name: "ViteHub AI emulator",
    base_instructions: "",
    experimental_supported_tools: [],
    priority: 0,
    shell_type: "default",
    support_verbosity: false,
    supported_in_api: true,
    supported_reasoning_levels: [],
    truncation_policy: { mode: "tokens", limit: 10_000 },
    visibility: "hide",
  }],
})

/** What a provider Driver sends to Codex or Claude Code, for the emulation checks. */
export interface ProviderEmulationTarget {
  provider: "claude-code" | "codex"
  sandbox: boolean
  tools: number
}

/**
 * The provider status while `VITEHUB_MODELS=emulate` is set, or undefined when the switch is off. Inspection and the
 * readiness check of an Invocation call it first, so they never probe the real provider, read a credential, or ask a
 * ChatGPT Connection. Claude Code and a switch that cannot be used, such as one in production, report the diagnostic
 * that the run throws.
 */
export function emulatedProviderStatus(
  provider: ProviderEmulationTarget["provider"],
  context: AgentProviderCredentialContext,
): AgentProviderStatus | undefined {
  if (!isModelEmulationRequested(context)) return
  const status = { agent: context.agentIdentity?.name ?? "agent", provider, checkedAt: new Date().toISOString(), stale: false }
  try {
    resolveModelEmulation(context)
    if (provider === "claude-code") throw agentDiagnostics.AGENT_MODELS_EMULATE_CLAUDE_CODE_UNSUPPORTED()
  }
  catch (error) {
    if (!(error instanceof Error)) throw error
    return withProviderStatusError({ ...status, readiness: "unavailable", reason: error.message }, error)
  }
  return { ...status, readiness: "unknown", reason: "VITEHUB_MODELS=emulate is set. Codex sends model requests to the AI emulator, so ViteHub does not check the provider sign-in." }
}

/**
 * Fail before a provider Driver reads a credential when `VITEHUB_MODELS=emulate` cannot keep its requests on the emulator.
 * Call it only when the switch is on.
 */
export function assertProviderEmulationSupported({ provider, sandbox, tools }: ProviderEmulationTarget): void {
  if (provider === "claude-code") throw agentDiagnostics.AGENT_MODELS_EMULATE_CLAUDE_CODE_UNSUPPORTED()
  if (tools > 0) throw agentDiagnostics.AGENT_MODELS_EMULATE_CODEX_TOOLS_UNSUPPORTED({ tools })
  if (sandbox) throw agentDiagnostics.AGENT_MODELS_EMULATE_SANDBOX_UNSUPPORTED()
}

/**
 * The Codex options that keep a Codex run on the emulator. They come after the launch arguments of the caller, and they
 * win: Codex applies the last `-c` override of a key, and `--disable` wins over `--enable` and over
 * `-c features.<name>=true` in any order. So compatible caller options, such as a reasoning effort, still apply.
 */
export function emulatedCodexLaunchArgs(options: { catalogPath: string, cwd: string }): string {
  return [
    codexConfigArg("web_search", '"disabled"'),
    ...disabledCodexFeatures.map(feature => `--disable ${feature}`),
    codexConfigArg("model_catalog_json", JSON.stringify(options.catalogPath)),
    // Codex reads no MCP server and no project config, because either one can select another model provider.
    codexConfigArg("mcp_servers", "{}"),
    codexConfigArg("projects", `{${JSON.stringify(options.cwd)}={trust_level="untrusted"}}`),
  ].join(" ")
}

/**
 * The emulator gateway for a Codex run, with the overrides that keep Codex on the emulator. `root` is a private folder
 * of the run: it gets the model catalog file. The URL comes only from the `VITEHUB_EMULATE_URL` host variable, like
 * `VITEHUB_MODELS`, so an unset Server Env value of a real provider cannot stop a local run.
 *
 * `emulate()` has no Codex route, so `codexDriver({ gateway: emulate() })` stays a type error: without these overrides,
 * Codex sends tools that the emulator rejects. The emulator serves OpenAI Responses under the same `/v1` base as Chat
 * Completions, so Codex uses the `openai-compatible` route.
 */
export async function emulatedCodexGateway(
  context: AgentProviderCredentialContext,
  options: { cwd: string, root: string },
): Promise<ResolvedAgentDriverGateway> {
  const catalogPath = join(options.root, "codex-model-catalog.json")
  const url = readHostEnv(["VITEHUB_EMULATE_URL"], context)
  const gateway = emulate(typeof url === "string" ? { url } : {})
  const [route] = await Promise.all([
    // The emulator reads no credential, so the route reads no other Server Env value.
    resolveAiGatewayRoute(gateway, "openai-compatible", { ...context, env: async () => undefined }),
    writeFile(catalogPath, emulatedCodexModelCatalog, { mode: 0o600 }),
  ])
  const resolved = codexGateway(gateway, route)
  return { ...resolved, launchArgs: [resolved.launchArgs, emulatedCodexLaunchArgs({ catalogPath, cwd: options.cwd })].join(" ") }
}
