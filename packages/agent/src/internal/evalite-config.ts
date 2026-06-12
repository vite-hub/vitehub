import { relative } from "node:path"

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

export function createAgentEvalSetupFilePath(rootDir: string): string {
  return createGeneratedDefinitionPath(rootDir, {
    fileName: "eval-setup.mjs",
    productName: "agent",
  })
}

function normalizeSetupFilePath(rootDir: string, file: string): string {
  return relative(rootDir, file).replace(/\\/g, "/")
}

export function withAgentEvalSetupFile(rootDir: string, options: ResolvedAgentEvalOptions): ResolvedAgentEvalOptions {
  const setupFile = normalizeSetupFilePath(rootDir, createAgentEvalSetupFilePath(rootDir))
  return {
    ...options,
    setupFiles: [
      setupFile,
      ...(options.setupFiles || []).filter(file => file !== setupFile),
    ],
  }
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

export function renderAgentEvalSetupFile(): string {
  return [
    `import { existsSync } from "node:fs"`,
    `import { resolve } from "node:path"`,
    `import { pathToFileURL } from "node:url"`,
    "",
    `const rootDir = process.env.VITEHUB_AGENT_EVAL_ROOT || process.cwd()`,
    `const envRegistryPath = resolve(rootDir, ".vitehub/nitro-runtime/env/registry.mjs")`,
    "",
    `async function optionalImport(id) {`,
    `  try {`,
    `    return await import(id)`,
    `  }`,
    `  catch (error) {`,
    `    if (error?.code === "ERR_MODULE_NOT_FOUND" || error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED") {`,
    `      return undefined`,
    `    }`,
    `    throw error`,
    `  }`,
    `}`,
    "",
    `if (existsSync(envRegistryPath)) {`,
    `  const envRuntime = await optionalImport("@vite-hub/env/runtime/server")`,
    `  if (typeof envRuntime?.setEnvRegistry === "function") {`,
    `    const registry = await import(pathToFileURL(envRegistryPath).href)`,
    `    envRuntime.setEnvRegistry(registry.default || {})`,
    `  }`,
    `}`,
    "",
  ].join("\n")
}

export async function writeAgentEvaliteConfig(rootDir: string, options: ResolvedAgentEvalOptions): Promise<string> {
  const file = createAgentEvaliteConfigPath(rootDir)
  await Promise.all([
    writeFileIfChanged(createAgentEvalSetupFilePath(rootDir), renderAgentEvalSetupFile()),
    writeFileIfChanged(file, renderAgentEvaliteConfig(withAgentEvalSetupFile(rootDir, options))),
  ])
  return file
}
