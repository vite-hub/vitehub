import { aiGatewaySdkOnly, aiGatewaySupports } from "./definition.ts"

import type { AiGatewayDefinition } from "./types.ts"

/**
 * Route keys for the configurations below. Kimi Code, OpenCode, and Pi are in Chat Completions mode.
 * A harness with no route signs in to its own service, so no gateway serves it.
 */
export interface AiGatewayHarnessRoutes {
  "acp": readonly []
  "antigravity": readonly []
  "claude-code": readonly ["claude-code"]
  "codex": readonly ["codex"]
  "cursor": readonly []
  "fx": readonly []
  "gemini": readonly ["gemini"]
  "grok": readonly []
  "kimi": readonly ["openai-compatible"]
  "kiro": readonly []
  "muse": readonly []
  "opencode": readonly ["openai-compatible"]
  "pi": readonly ["openai-compatible"]
}

/** A harness configuration in the route map. */
export type AiGatewayHarness = keyof AiGatewayHarnessRoutes

/** Route keys for a harness configuration, not a CLI compatibility check. */
export type AiGatewayHarnessRoute<THarness extends AiGatewayHarness = AiGatewayHarness> = AiGatewayHarnessRoutes[THarness][number]

/** Route keys for the supported configurations, in order of preference. */
export const aiGatewayHarnessRoutes: Readonly<AiGatewayHarnessRoutes> = {
  "acp": [],
  "antigravity": [],
  "claude-code": ["claude-code"],
  "codex": ["codex"],
  "cursor": [],
  "fx": [],
  "gemini": ["gemini"],
  "grok": [],
  "kimi": ["openai-compatible"],
  "kiro": [],
  "muse": [],
  "opencode": ["openai-compatible"],
  "pi": ["openai-compatible"],
}

/** Finds the configured route key, skipping SDK-only presets. It neither checks other protocols nor verifies CLI compatibility. */
export function aiGatewayHarnessRoute<THarness extends AiGatewayHarness>(gateway: AiGatewayDefinition, harness: THarness): AiGatewayHarnessRoute<THarness> | undefined {
  if (!Object.hasOwn(aiGatewayHarnessRoutes, harness) || Reflect.get(gateway, aiGatewaySdkOnly) === true) return undefined
  const routes: readonly AiGatewayHarnessRoute<THarness>[] = aiGatewayHarnessRoutes[harness]
  return routes.find(route => aiGatewaySupports(gateway, route))
}
