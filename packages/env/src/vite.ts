import { resolve } from "node:path"

import { writeFileIfChanged } from "@vite-hub/internal/definition-catalog"
import { loadEnv } from "vite"

import { formatDiagnostics } from "./core/diagnostics.ts"
import { env } from "./core/declarations.ts"
import { createRuntimeRegistry, createSourceContext, resolveEnvEntries, validateEnvConfigShape } from "./core/resolve.ts"

import type { EnvIntegrationOptions, EnvViteConfigOptions, EnvViteUserConfig } from "./types.ts"
import type { Plugin, UserConfig } from "vite"

export const ENV_VITE_PLUGIN_NAME = "@vite-hub/env/vite"
export const ENV_PUBLIC_ID = "#vitehub/env/public"
export const ENV_SERVER_ID = "#vitehub/env/server"

const RESOLVED_PUBLIC_ID = `\0${ENV_PUBLIC_ID}`
const RESOLVED_SERVER_ID = `\0${ENV_SERVER_ID}`

export { env }

export interface EnvVitePluginAPI {
  getPublicEnv: () => Record<string, unknown>
}

export type EnvVitePlugin = Plugin & { api: EnvVitePluginAPI }

export function hubEnv(options: EnvIntegrationOptions = {}): EnvVitePlugin {
  let buildPublicConfig: Record<string, unknown> = {}
  let serverRegistry: Record<string, unknown> = {}
  let diagnosticsText: string | undefined
  const getPublicEnv = () => buildPublicConfig

  return {
    name: ENV_VITE_PLUGIN_NAME,
    api: { getPublicEnv },
    async config(config, env) {
      const envConfig = (config as UserConfig & EnvViteUserConfig).env
      validateEnvConfigShape(envConfig, "vite")
      if (!envConfig) {
        return
      }

      const root = resolve(config.root || process.cwd())
      const loadedEnv = loadEnv(env.mode, root, "")
      const context = createSourceContext({
        env: { ...loadedEnv, ...process.env },
        mode: "build",
        rootDir: root,
      })

      const publicResult = await resolveEnvEntries(envConfig.public, {
        context,
        exposure: "build public",
        prefix: options.prefix,
        section: "env.public",
        timing: "Vite config/dev/build",
      })
      const defineResult = await resolveEnvEntries(envConfig.define, {
        context,
        exposure: "compile-time replacement",
        prefix: options.prefix,
        section: "env.define",
        timing: "Vite transform/build",
      })

      buildPublicConfig = Object.fromEntries(publicResult.entries.map(entry => [entry.key, entry.value]))
      serverRegistry = createRuntimeRegistry(envConfig.server, {
        prefix: options.prefix,
      })
      diagnosticsText = formatDiagnostics([...publicResult.diagnostics, ...defineResult.diagnostics], options.diagnostics)

      return {
        define: {
          ...Object.fromEntries(defineResult.entries.map(entry => [entry.key, JSON.stringify(entry.value)])),
          ...config.define,
        },
      }
    },
    async configResolved(config) {
      if (diagnosticsText) {
        config.logger.info(diagnosticsText)
      }
      await writeFileIfChanged(
        resolve(config.root, ".vitehub/env/vite.d.ts"),
        createViteTypes(buildPublicConfig, serverRegistry),
      )
    },
    load(id) {
      if (id === RESOLVED_PUBLIC_ID) {
        return [
          `const publicEnv = ${JSON.stringify(buildPublicConfig, null, 2)};`,
          "export function usePublicEnv() { return publicEnv; }",
          "export { publicEnv };",
        ].join("\n")
      }
      if (id === RESOLVED_SERVER_ID) {
        return [
          "import { resolveServerEnv } from '@vite-hub/env/server';",
          `const serverEnvRegistry = ${JSON.stringify(serverRegistry, null, 2)};`,
          "export function useServerEnv(event) { return resolveServerEnv(serverEnvRegistry, event); }",
        ].join("\n")
      }
    },
    resolveId(id) {
      if (id === ENV_PUBLIC_ID) {
        return RESOLVED_PUBLIC_ID
      }
      if (id === ENV_SERVER_ID) {
        return RESOLVED_SERVER_ID
      }
    },
  }
}

function createViteTypes(publicConfig: Record<string, unknown>, serverRegistry: Record<string, unknown>): string {
  const publicFields = Object.entries(publicConfig).map(([key, value]) => `    ${JSON.stringify(key)}: ${typeof value}`)
  const serverFields = Object.entries(serverRegistry).map(([key, value]) => `    ${JSON.stringify(key)}: ${serverEnvType(value)}`)
  return [
    "declare module \"#vitehub/env/public\" {",
    "  export interface PublicEnv {",
    ...publicFields,
    "  }",
    "  export const publicEnv: PublicEnv",
    "  export function usePublicEnv(): PublicEnv",
    "}",
    "declare module \"#vitehub/env/server\" {",
    "  export interface ServerEnv {",
    ...serverFields,
    "  }",
    "  export function useServerEnv(event?: unknown): ServerEnv",
    "}",
    "export {}",
    "",
  ].join("\n")
}

function serverEnvType(value: unknown): string {
  if (isRecord(value) && value.kind === "literal") {
    return literalType(value.value)
  }
  if (isRecord(value) && isRecord(value.source) && typeof value.required === "boolean") {
    const base = value.secret ? "import(\"@vite-hub/env/secret\").SecretEnv<string>" : "string"
    return value.required || typeof value.default !== "undefined" ? base : `${base} | undefined`
  }
  if (isRecord(value)) {
    const fields = Object.entries(value).map(([key, child]) => `${JSON.stringify(key)}: ${serverEnvType(child)}`)
    return `{ ${fields.join("; ")} }`
  }
  return "unknown"
}

function literalType(value: unknown): string {
  if (value === null) return "null"
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (Array.isArray(value)) return `[${value.map(literalType).join(", ")}]`
  return "unknown"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

declare module "vite" {
  interface UserConfig {
    env?: EnvViteConfigOptions
  }
}
