import { relativeDefinitionFile } from "@vite-hub/internal/inspect"

import { discoverRateLimitDeclarations } from "./discovery.ts"

import type { ViteHubConsoleSectionContribution } from "@vite-hub/internal/console"
import type { ViteHubDefinitionSummary } from "@vite-hub/internal/inspect"
import type { RateLimitDeclaration } from "./types.ts"

export interface RateLimitInspectionOptions {
  projectRoot: string
  rootDir: string
  scanDirs?: string[]
}

function summarizeRateLimitDeclaration(projectRoot: string, declaration: RateLimitDeclaration): ViteHubDefinitionSummary {
  return {
    fields: [
      { label: "Limit", value: String(declaration.policy.limit) },
      { label: "Window", value: declaration.policy.window },
      { label: "Enforcement", value: declaration.policy.enforcement === "strict" ? "Strict" : "Best effort" },
      { label: "Provider failure", value: declaration.policy.failure === "allow" ? "Allow" : "Deny" },
      { label: "Source location", value: `${declaration.source.line}:${declaration.source.column}` },
    ],
    file: relativeDefinitionFile(projectRoot, declaration.source.file),
    name: declaration.name,
    source: "require-rate-limit",
  }
}

/** Lists `requireRateLimit()` declarations as serializable inspection summaries. */
export function inspectRateLimitDefinitions(options: RateLimitInspectionOptions): ViteHubDefinitionSummary[] {
  return discoverRateLimitDeclarations({ rootDir: options.rootDir, scanDirs: options.scanDirs })
    .map(declaration => summarizeRateLimitDeclaration(options.projectRoot, declaration))
}

/** Console section that lists discovered Rate Limit Definitions. `vitehub inspect definitions` reads the same data. */
export const rateLimitConsoleSection: ViteHubConsoleSectionContribution<RateLimitInspectionOptions> = {
  description: "Inspect discovered Rate Limit policies and their source locations.",
  icon: "i-lucide-gauge",
  id: "rate-limits",
  label: "Rate Limits",
  read: inspectRateLimitDefinitions,
  view: {
    kind: "definition-catalog",
    notice: "The page lists the policies. Enter a key to read its live counter or to reset it. Counters depend on the provider: a Cloudflare binding cannot be read or reset, and a memory counter exists only in this server process.",
  },
}
