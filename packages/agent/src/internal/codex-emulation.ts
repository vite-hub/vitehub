import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { emulate } from "@vite-hub/gateways"
import { resolveAiGatewayRoute } from "@vite-hub/gateways/internal"

import { agentDiagnostics } from "../agent-diagnostics.ts"
import { codexGateway } from "./agent-gateway.ts"
import { codexConfigArg } from "./codex-launch-args.ts"
import { gatewayEnvValue } from "./gateway-env.ts"

import type { AgentProviderCredentialContext } from "../types.ts"
import type { ResolvedAgentDriverGateway } from "./agent-gateway.ts"

/**
 * Codex features that the emulator rejects or that reach a service other than the emulator. `multi_agent` sends its
 * tools in a `namespace` tool, which the emulator rejects. `goals` adds goal tools to every request, so the call record
 * shows only the tools of the run. `apps` and `plugins` connect to OpenAI services.
 */
const disabledCodexFeatures = ["apps", "plugins", "multi_agent", "goals"] as const

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
 * Fail before a provider Driver reads a credential when `VITEHUB_MODELS=emulate` cannot keep its requests on the emulator.
 * Call it only when the switch is on.
 */
export function assertProviderEmulationSupported({ provider, sandbox, tools }: ProviderEmulationTarget): void {
  if (provider === "claude-code") throw agentDiagnostics.AGENT_MODELS_EMULATE_CLAUDE_CODE_UNSUPPORTED()
  if (tools > 0) throw agentDiagnostics.AGENT_MODELS_EMULATE_CODEX_TOOLS_UNSUPPORTED({ tools })
  if (sandbox) throw agentDiagnostics.AGENT_MODELS_EMULATE_SANDBOX_UNSUPPORTED()
}

/** The Codex `-c` overrides that keep a Codex run on the emulator, after the provider settings of the gateway. */
export function emulatedCodexLaunchArgs(options: { catalogPath: string, cwd: string }): string {
  return [
    codexConfigArg("web_search", '"disabled"'),
    ...disabledCodexFeatures.map(feature => codexConfigArg(`features.${feature}`, "false")),
    codexConfigArg("model_catalog_json", JSON.stringify(options.catalogPath)),
    // Codex reads no MCP server and no project config, because either one can select another model provider.
    codexConfigArg("mcp_servers", "{}"),
    codexConfigArg("projects", `{${JSON.stringify(options.cwd)}={trust_level="untrusted"}}`),
  ].join(" ")
}

/**
 * The emulator gateway for a Codex run, with the overrides that keep Codex on the emulator. `root` is a private folder
 * of the run: it gets the model catalog file. The URL comes from `VITEHUB_EMULATE_URL` in Server Env.
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
  const gateway = emulate()
  const [route] = await Promise.all([
    resolveAiGatewayRoute(gateway, "openai-compatible", { ...context, env: async (preset, field) => await gatewayEnvValue(preset, field, context) }),
    writeFile(catalogPath, emulatedCodexModelCatalog, { mode: 0o600 }),
  ])
  const resolved = codexGateway(gateway, route)
  return { ...resolved, launchArgs: [resolved.launchArgs, emulatedCodexLaunchArgs({ catalogPath, cwd: options.cwd })].join(" ") }
}
