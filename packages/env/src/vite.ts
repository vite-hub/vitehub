import { resolve } from "node:path"

import { writeFileIfChanged } from "@vitehub/internal/definition-catalog"
import { loadEnv } from "vite"

import { formatDiagnostics } from "./core/diagnostics.ts"
import { env } from "./core/declarations.ts"
import { createSourceContext, resolveEnvEntries, validateEnvConfigShape } from "./core/resolve.ts"

import type { EnvIntegrationOptions, EnvViteConfigOptions, EnvViteUserConfig } from "./types.ts"
import type { Plugin, UserConfig } from "vite"

export const ENV_VITE_PLUGIN_NAME = "@vitehub/env/vite"
export const ENV_BUILD_VIRTUAL_ID = "virtual:@vitehub/env/build"

const RESOLVED_BUILD_VIRTUAL_ID = `\0${ENV_BUILD_VIRTUAL_ID}`

export { env }

export interface EnvVitePluginAPI {
  getBuildConfig: () => Record<string, unknown>
}

export type EnvVitePlugin = Plugin & { api: EnvVitePluginAPI }

export function envVite(options: EnvIntegrationOptions = {}): EnvVitePlugin {
  let buildPublicConfig: Record<string, unknown> = {}
  let diagnosticsText: string | undefined
  const getBuildConfig = () => buildPublicConfig

  return {
    name: ENV_VITE_PLUGIN_NAME,
    api: { getBuildConfig },
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
        createViteTypes(buildPublicConfig),
      )
    },
    load(id) {
      if (id === RESOLVED_BUILD_VIRTUAL_ID) {
        return [
          `const buildConfig = { public: ${JSON.stringify(buildPublicConfig, null, 2)} };`,
          "export function useSafeBuildConfig() { return buildConfig; }",
          "export { buildConfig };",
          "export default buildConfig;",
        ].join("\n")
      }
    },
    resolveId(id) {
      if (id === ENV_BUILD_VIRTUAL_ID) {
        return RESOLVED_BUILD_VIRTUAL_ID
      }
    },
  }
}

function createViteTypes(config: Record<string, unknown>): string {
  const fields = Object.entries(config).map(([key, value]) => `      ${JSON.stringify(key)}: ${typeof value}`)
  return [
    "declare module \"virtual:@vitehub/env/build\" {",
    "  export const buildConfig: {",
    "    public: {",
    ...fields,
    "    }",
    "  }",
    "  export function useSafeBuildConfig(): typeof buildConfig",
    "  export default buildConfig",
    "}",
    "export {}",
    "",
  ].join("\n")
}

declare module "vite" {
  interface UserConfig {
    env?: EnvViteConfigOptions
  }
}
