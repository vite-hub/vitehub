import { resolve } from "node:path"

import { env } from "@vite-hub/env/vite"
import { VITEHUB_ENV_SERVER, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { forgeEnv } from "@vite-hub/internal/forge"

import { assertFeaturePackages, requireOptionalOwner } from "./internal/optional-owners.ts"
import { ownerModules } from "./internal/owner-modules.ts"

import type { EnvRuntimeConfigOptions } from "@vite-hub/env"
import type { Plugin } from "vite"

/**
 * Declare the Server Env of built-in Channels and gateway presets used by discovered Agents, before
 * hubEnv() builds the registry. hubEnv() applies the application's declarations over them field by field.
 * A github(), gitlab(), or forgejo() Channel, or the forge() Capability, needs the optional `@vite-hub/forge`, so the
 * build fails with the install command when the app did not install it.
 * Run after ordinary config hooks so discovery uses the application's root.
 */
export function agentChannelEnvPlugin(): Plugin {
  return {
    name: "vite-hub/agent-channel-env",
    enforce: "pre",
    config: {
      order: "post",
      handler(config) {
        const discovery = {
          rootDir: resolve(config.root || process.cwd()),
          // SAFETY: ViteHub framework integrations set this private server-directory key.
          serverDirs: (config as typeof config & { [VITEHUB_SERVER_DIRS]?: string[] })[VITEHUB_SERVER_DIRS],
        }
        const { discoverAgentChannelEnv, discoverAgentGatewayEnv } = requireOptionalOwner(ownerModules.agentVite, "agent")
        const channelEnv = { ...discoverAgentGatewayEnv(discovery), ...discoverAgentChannelEnv(discovery) }
        if (!Object.keys(channelEnv).length) return
        if (Object.keys(forgeEnv).some(forge => Object.hasOwn(channelEnv, forge))) assertFeaturePackages(["forge"])
        const server: EnvRuntimeConfigOptions = {}
        for (const [channel, fields] of Object.entries(channelEnv)) {
          const group: EnvRuntimeConfigOptions = {}
          for (const [field, { names, required, secret }] of Object.entries(fields)) {
            group[field] = env({ optional: !required, secret, source: env.source(names) })
          }
          server[channel] = group
        }
        // SAFETY: hubEnv() reads this private key and applies the application's declarations over it.
        const contributed = (config as typeof config & { [VITEHUB_ENV_SERVER]?: EnvRuntimeConfigOptions })[VITEHUB_ENV_SERVER]
        Reflect.set(config, VITEHUB_ENV_SERVER, { ...contributed, ...server })
      },
    },
  }
}
