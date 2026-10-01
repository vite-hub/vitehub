import { resolve } from "node:path"

import { discoverAgentChannelEnv } from "@vite-hub/agent/vite"
import { env } from "@vite-hub/env/vite"
import { VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"

import type { EnvRuntimeConfigOptions, EnvViteUserConfig } from "@vite-hub/env"
import type { Plugin } from "vite"

// A nested group is a plain object that is not an env() declaration.
function isDeclarationGroup(value: unknown): value is EnvRuntimeConfigOptions {
  return Object.prototype.toString.call(value) === "[object Object]"
    && Reflect.get(Object(value), "kind") !== "env-variable"
}

/**
 * Declare the Server Env of built-in Channels used by discovered Agents, before
 * hubEnv() builds the registry. Application declarations win field by field.
 * Run after ordinary config hooks so discovery uses the application's root.
 */
export function agentChannelEnvPlugin(): Plugin {
  return {
    name: "vite-hub/agent-channel-env",
    enforce: "pre",
    config: {
      order: "post",
      handler(config) {
        const channelEnv = discoverAgentChannelEnv({
          rootDir: resolve(config.root || process.cwd()),
          // SAFETY: ViteHub framework integrations set this private server-directory key.
          serverDirs: (config as typeof config & { [VITEHUB_SERVER_DIRS]?: string[] })[VITEHUB_SERVER_DIRS],
        })
        // SAFETY: hubEnv() owns the `env` Vite config extension read and written here.
        const envConfig = config as typeof config & EnvViteUserConfig
        const server: EnvRuntimeConfigOptions = { ...envConfig.env?.server }
        let changed = false
        for (const [channel, fields] of Object.entries(channelEnv)) {
          const existing = server[channel]
          if (existing !== undefined && !isDeclarationGroup(existing)) continue
          const group: EnvRuntimeConfigOptions = { ...existing }
          for (const [field, { names, required, secret }] of Object.entries(fields)) {
            if (group[field] !== undefined) continue
            group[field] = env({ optional: !required, secret, source: env.source(names, { skipEmpty: true }) })
            changed = true
          }
          server[channel] = group
        }
        if (changed) envConfig.env = { ...envConfig.env, server }
      },
    },
  }
}
