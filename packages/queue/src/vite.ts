import { getViteMode } from "@vite-hub/internal/build/mode"
import { shouldSkipViteProviderBuild } from "@vite-hub/internal/build/deployment-output"
import { createNoExternalMerger, isServerEnvironment, resolveNitroVercelFunctionName } from "@vite-hub/internal/build/vite"

import { generateProviderOutputs, queuePackageName } from "./internal/vite-build.ts"
import { createQueueProvisionStep } from "./provision.ts"

import type { QueueModuleOptions } from "./types.ts"
import type { ViteHubCliContributor } from "@vite-hub/internal/cli"
import type { Plugin, ResolvedConfig } from "vite"

interface QueueProvisionContributingPlugin {
  vitehub?: { cli?: () => Promise<ViteHubCliContributor> }
}

export type QueueVitePlugin = Plugin & QueueProvisionContributingPlugin

export { createCloudflareQueueConfig, type CloudflareQueueConfig, type CloudflareQueueConfigOptions } from "./internal/vite-build.ts"

const mergeNoExternal = createNoExternalMerger(queuePackageName)

export function hubQueue(options?: QueueModuleOptions): QueueVitePlugin {
  let resolved: ResolvedConfig | undefined
  let queue: QueueModuleOptions | undefined = options

  return {
    name: "@vite-hub/queue/vite",
    vitehub: {
      cli: async () => {
        return { namespaces: [], provision: [createQueueProvisionStep(() => resolved?.root ?? process.cwd())] }
      },
    },
    config(config) {
      queue = config.queue ?? queue
    },
    configResolved(config) {
      resolved = config
      queue = config.queue ?? queue
    },
    configEnvironment(name, config) {
      if (!isServerEnvironment(name, config)) {
        return
      }
      return {
        resolve: { noExternal: mergeNoExternal(config.resolve?.noExternal) },
      }
    },
    async closeBundle() {
      if (!resolved || shouldSkipViteProviderBuild(resolved.command, getViteMode())) {
        return
      }
      await generateProviderOutputs({
        clientOutDir: resolved.build.outDir,
        queue,
        rootDir: resolved.root,
        serverFunctionName: resolveNitroVercelFunctionName(resolved.plugins, "queue", resolved.root),
      })
    },
  }
}

declare module "vite" {
  interface UserConfig {
    queue?: QueueModuleOptions
  }
}
