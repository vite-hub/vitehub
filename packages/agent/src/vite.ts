import { createNoExternalMerger, isServerEnvironment, mergeGeneratedViteHubWatchIgnored } from "@vitehub/internal/build/vite"

import { chatDevTools } from "./chat/devtools.ts"
import { agentNitro } from "./nitro/module.ts"

import type { NitroModule } from "nitro/types"
import type { Plugin } from "vite"
import type { AgentModuleOptions } from "./types.ts"

interface AgentCliContributingPlugin {
  vitehub?: {
    cli?: unknown
  }
}

export type AgentVitePlugin = Plugin & AgentCliContributingPlugin & { nitro: NitroModule }

const agentPackageName = "@vitehub/agent"
const mergeNoExternal = createNoExternalMerger(agentPackageName)

function agentDevtoolsEnabled(agent: AgentModuleOptions | false | undefined): boolean {
  return agent !== false && agent?.devtools !== false
}

function configuredNitroAgent(nitro: unknown): AgentModuleOptions | false | undefined {
  return (nitro as { options?: { agent?: AgentModuleOptions | false } }).options?.agent
}

export function hubAgent(options?: AgentModuleOptions): AgentVitePlugin {
  let agent: AgentModuleOptions | false | undefined = options
  const chatDevtoolsPlugin = chatDevTools()

  return {
    name: "@vitehub/agent/vite",
    nitro: {
      name: "@vitehub/agent/vite",
      async setup(nitro) {
        const configured = configuredNitroAgent(nitro) ?? agent
        await agentNitro(configured).setup(nitro)
        if (agentDevtoolsEnabled(configured)) {
          await chatDevtoolsPlugin.nitro.setup(nitro)
        }
      },
    },
    devtools: {
      setup(ctx) {
        if (agentDevtoolsEnabled(agent)) {
          return chatDevtoolsPlugin.devtools?.setup?.(ctx)
        }
      },
    },
    vitehub: {
      cli: async () => {
        const { createAgentCliContributor } = await import(/* @vite-ignore */ "./cli.js")
        return createAgentCliContributor(agent === false ? false : agent?.cli)
      },
    },
    config(config) {
      agent = config.agent ?? agent
      return {
        ...(typeof agent !== "undefined" ? { agent } : {}),
        server: {
          watch: {
            ignored: mergeGeneratedViteHubWatchIgnored(config.server?.watch?.ignored),
          },
        },
      }
    },
    configResolved(config) {
      agent = config.agent ?? agent
    },
    configEnvironment(name, config) {
      if (!isServerEnvironment(name, config)) {
        return
      }

      return {
        resolve: {
          noExternal: mergeNoExternal(config.resolve?.noExternal),
        },
      }
    },
  }
}

declare module "vite" {
  interface UserConfig {
    agent?: false | AgentModuleOptions
  }
}
