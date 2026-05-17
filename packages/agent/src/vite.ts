import { createNoExternalMerger, isServerEnvironment } from "@vitehub/internal/build/vite"

import { chatDevTools } from "./chat/devtools.ts"
import agentNitroModule from "./nitro/module.ts"

import type { NitroModule } from "nitro/types"
import type { Plugin, UserConfig } from "vite"
import type { AgentModuleOptions } from "./types.ts"
import type { ChatDevToolsOptions, ChatDevToolsPlugin } from "./chat/devtools.ts"

export type AgentVitePlugin = Plugin & { nitro: NitroModule }

const agentPackageName = "@vitehub/agent"
const mergeNoExternal = createNoExternalMerger(agentPackageName)

export function hubChatDevtools(options?: ChatDevToolsOptions): ChatDevToolsPlugin {
  return chatDevTools(options)
}

export function hubAgent(options?: AgentModuleOptions): AgentVitePlugin {
  let agent: AgentModuleOptions | false | undefined = options

  return {
    name: "@vitehub/agent/vite",
    nitro: agentNitroModule,
    config(config) {
      agent = config.agent ?? agent
      if (typeof agent !== "undefined") {
        return { agent }
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
