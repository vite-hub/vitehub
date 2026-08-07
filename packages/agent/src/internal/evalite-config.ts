import { rm } from "node:fs/promises"
import { join } from "node:path"

import { createGeneratedDefinitionPath, writeFileIfChanged } from "@vite-hub/internal/definition-catalog"

import type { AgentEvalOptions } from "../types.ts"

export type ResolvedAgentEvalOptions = AgentEvalOptions & {
  forceRerunTriggers: string[]
}

const defaultForceRerunTriggers = [
  "server/agents/**",
  "src/**/*.agent.*",
  "src/**/*.eval.*",
]

export function resolveAgentEvalOptions(options: AgentEvalOptions | undefined): ResolvedAgentEvalOptions {
  return {
    ...options,
    forceRerunTriggers: options?.forceRerunTriggers ?? defaultForceRerunTriggers,
  }
}

export function createAgentEvaliteConfigPath(rootDir: string, generatedRoot?: string): string {
  if (generatedRoot) return join(generatedRoot, "agent", "evalite.config.ts")
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

export async function writeAgentEvaliteConfig(rootDir: string, options: ResolvedAgentEvalOptions, generatedRoot?: string): Promise<string> {
  const file = createAgentEvaliteConfigPath(rootDir, generatedRoot)
  await writeFileIfChanged(file, renderAgentEvaliteConfig(options))
  return file
}

export async function removeAgentEvaliteConfig(rootDir: string, generatedRoot?: string): Promise<void> {
  await rm(createAgentEvaliteConfigPath(rootDir, generatedRoot), { force: true })
}
