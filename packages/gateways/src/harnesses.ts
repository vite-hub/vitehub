import { aiGatewaySupports } from "./definition.ts"

import type { AiGatewayDefinition } from "./types.ts"

/** The routes that each coding agent CLI calls, in order of preference. */
export interface AiGatewayHarnessRoutes {
  "claude-code": readonly ["claude-code"]
  "codex": readonly ["codex"]
  "gemini": readonly ["gemini"]
  "kimi": readonly ["openai-compatible"]
  "opencode": readonly ["openai-compatible"]
  "pi": readonly ["openai-compatible"]
}

/** A coding agent CLI that sends model requests through a gateway: Claude Code, Codex, the Gemini CLI, Kimi CLI, OpenCode, or Pi. */
export type AiGatewayHarness = keyof AiGatewayHarnessRoutes

/** The routes that a harness calls. `AiGateway<{ routes: AiGatewayHarnessRoute<"gemini"> }>` accepts the gateways that serve the Gemini CLI. */
export type AiGatewayHarnessRoute<THarness extends AiGatewayHarness = AiGatewayHarness> = AiGatewayHarnessRoutes[THarness][number]

/** The routes that each coding agent CLI calls, in order of preference. */
export const aiGatewayHarnessRoutes: Readonly<AiGatewayHarnessRoutes> = {
  "claude-code": ["claude-code"],
  "codex": ["codex"],
  "gemini": ["gemini"],
  "kimi": ["openai-compatible"],
  "opencode": ["openai-compatible"],
  "pi": ["openai-compatible"],
}

/** The first route of `harness` that `gateway` serves, or `undefined` when the gateway cannot serve the harness. */
export function aiGatewayHarnessRoute<THarness extends AiGatewayHarness>(gateway: AiGatewayDefinition, harness: THarness): AiGatewayHarnessRoute<THarness> | undefined {
  if (!Object.hasOwn(aiGatewayHarnessRoutes, harness)) return undefined
  const routes: readonly AiGatewayHarnessRoute<THarness>[] = aiGatewayHarnessRoutes[harness]
  return routes.find(route => aiGatewaySupports(gateway, route))
}
