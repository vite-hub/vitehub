import { resolve } from "node:path"

import { writeFileIfChanged } from "@vitehub/internal/definition-catalog"
import { loadEnv } from "vite"

import { formatDiagnostics } from "./core/diagnostics.ts"
import { rc } from "./core/declarations.ts"
import { resolveBuildEntries, validateRuntimeConfigShape } from "./core/resolve.ts"

import type { RuntimeConfigIntegrationOptions, RuntimeConfigOptions, ViteHubRuntimeConfigUserConfig } from "./types.ts"
import type { Plugin, UserConfig } from "vite"

export const RUNTIME_CONFIG_VITE_PLUGIN_NAME = "@vitehub/runtime-config/vite"
export const RUNTIME_CONFIG_BUILD_VIRTUAL_ID = "virtual:vitehub/runtime-config/build"
export const RUNTIME_CONFIG_PUBLIC_RUNTIME_VIRTUAL_ID = "virtual:vitehub/runtime-config/public-runtime"

const RESOLVED_BUILD_VIRTUAL_ID = `\0${RUNTIME_CONFIG_BUILD_VIRTUAL_ID}`
const RESOLVED_PUBLIC_RUNTIME_VIRTUAL_ID = `\0${RUNTIME_CONFIG_PUBLIC_RUNTIME_VIRTUAL_ID}`

export { rc }

export interface RuntimeConfigVitePluginAPI {
  getBuildConfig: () => Record<string, unknown>
}

export type RuntimeConfigVitePlugin = Plugin & { api: RuntimeConfigVitePluginAPI }

export function runtimeConfigVite(options: RuntimeConfigIntegrationOptions = {}): RuntimeConfigVitePlugin {
  let buildConfig: Record<string, unknown> = {}
  let diagnosticsText: string | undefined
  const getBuildConfig = () => buildConfig

  return {
    name: RUNTIME_CONFIG_VITE_PLUGIN_NAME,
    api: { getBuildConfig },
    config(config, env) {
      const runtimeConfig = resolveRuntimeConfigBlock(config)
      validateRuntimeConfigShape(runtimeConfig, "vite")
      if (!runtimeConfig?.build) {
        return
      }

      const root = resolve(config.root || process.cwd())
      const loadedEnv = loadEnv(env.mode, root, "")
      const mergedEnv = { ...loadedEnv, ...process.env }
      const publicResult = resolveBuildEntries(runtimeConfig.build.public, {
        env: mergedEnv,
        packageRoot: root,
        section: "build.public",
      })
      const defineResult = resolveBuildEntries(runtimeConfig.build.define, {
        env: mergedEnv,
        packageRoot: root,
        section: "build.define",
      })

      buildConfig = Object.fromEntries(publicResult.entries.map(entry => [entry.key, entry.value]))
      diagnosticsText = formatDiagnostics([...publicResult.diagnostics, ...defineResult.diagnostics], options.diagnostics)

      return {
        define: {
          ...Object.fromEntries(defineResult.entries.map(entry => [entry.key, entry.value])),
          ...config.define,
        },
      }
    },
    async configResolved(config) {
      if (diagnosticsText) {
        config.logger.info(diagnosticsText)
      }
      await writeFileIfChanged(
        resolve(config.root, ".vitehub/runtime-config/vite.d.ts"),
        createViteTypes(buildConfig),
      )
    },
    load(id) {
      if (id === RESOLVED_BUILD_VIRTUAL_ID) {
        return [
          `export const buildConfig = ${JSON.stringify(buildConfig, null, 2)};`,
          "export default buildConfig;",
        ].join("\n")
      }
      if (id === RESOLVED_PUBLIC_RUNTIME_VIRTUAL_ID) {
        return [
          "export async function getPublicRuntimeConfig(endpoint = '/_vitehub/runtime-config') {",
          "  const response = await fetch(endpoint, { headers: { accept: 'application/json' } });",
          "  if (!response.ok) throw new Error(`[vitehub] Failed to load public runtime config from ${endpoint}: ${response.status}`);",
          "  return await response.json();",
          "}",
        ].join("\n")
      }
    },
    resolveId(id) {
      if (id === RUNTIME_CONFIG_BUILD_VIRTUAL_ID) {
        return RESOLVED_BUILD_VIRTUAL_ID
      }
      if (id === RUNTIME_CONFIG_PUBLIC_RUNTIME_VIRTUAL_ID) {
        return RESOLVED_PUBLIC_RUNTIME_VIRTUAL_ID
      }
    },
  }
}

function resolveRuntimeConfigBlock(config: UserConfig): RuntimeConfigOptions | undefined {
  return (config.vitehub as ViteHubRuntimeConfigUserConfig | undefined)?.runtimeConfig
}

function createViteTypes(config: Record<string, unknown>): string {
  const fields = Object.entries(config).map(([key, value]) => `    ${JSON.stringify(key)}: ${typeof value}`)
  return [
    "declare module \"virtual:vitehub/runtime-config/build\" {",
    "  export const buildConfig: {",
    ...fields,
    "  }",
    "  export default buildConfig",
    "}",
    "",
    "declare module \"virtual:vitehub/runtime-config/public-runtime\" {",
    "  export function getPublicRuntimeConfig(endpoint?: string): Promise<Record<string, unknown>>",
    "}",
    "",
    "export {}",
    "",
  ].join("\n")
}

declare module "vite" {
  interface UserConfig {
    vitehub?: ViteHubRuntimeConfigUserConfig
  }
}
