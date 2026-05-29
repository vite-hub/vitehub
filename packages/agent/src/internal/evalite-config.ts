import { createGeneratedDefinitionPath, writeFileIfChanged } from "@vitehub/internal/definition-catalog"

import type { AgentEvalOptions } from "../types.ts"

export type ResolvedAgentEvalOptions = AgentEvalOptions & {
  forceRerunTriggers: string[]
}

const defaultForceRerunTriggers = [
  "server/agents/**",
  "src/**/*.agent.*",
  "src/**/*.eval.*",
]

export function resolveAgentEvalOptions(options: false | AgentEvalOptions | undefined): ResolvedAgentEvalOptions | false {
  if (options === false) return false
  return {
    ...options,
    forceRerunTriggers: options?.forceRerunTriggers ?? defaultForceRerunTriggers,
  }
}

export function createAgentEvaliteConfigPath(rootDir: string): string {
  return createGeneratedDefinitionPath(rootDir, {
    fileName: "evalite.config.ts",
    productName: "agent",
  })
}

function withoutUndefined(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => withoutUndefined(item))
  }
  if (!value || typeof value !== "object") {
    return value
  }

  const entries = Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .map(([key, item]) => [key, withoutUndefined(item)] as const)
    .filter(([, item]) => !(item && typeof item === "object" && !Array.isArray(item) && !Object.keys(item).length))

  return Object.fromEntries(entries)
}

export function renderAgentEvaliteConfig(options: ResolvedAgentEvalOptions): string {
  return [
    `import { defineConfig } from "evalite/config"`,
    "",
    `export default defineConfig(${JSON.stringify(withoutUndefined(options), null, 2)})`,
    "",
  ].join("\n")
}

export async function writeAgentEvaliteConfig(rootDir: string, options: ResolvedAgentEvalOptions): Promise<string> {
  const file = createAgentEvaliteConfigPath(rootDir)
  await writeFileIfChanged(file, renderAgentEvaliteConfig(options))
  return file
}
