import type { QueueModuleOptions } from "./types.ts"
import type { EnvironmentOptions, Plugin } from "vite"

const queuePackageName = "@vitehub/queue"
type QueueViteEnvironment = {
  config: Pick<EnvironmentOptions, "consumer">
  name: string
}

function mergeNoExternal(
  current: NonNullable<EnvironmentOptions["resolve"]>["noExternal"],
): NonNullable<EnvironmentOptions["resolve"]>["noExternal"] {
  if (current === true) return true
  if (!current) return [queuePackageName]
  const values = Array.isArray(current) ? current : [current]
  return values.some(value => value === queuePackageName)
    ? values
    : [...values, queuePackageName]
}

function isQueueServerEnvironment(
  name: string,
  config: Pick<EnvironmentOptions, "consumer">,
): boolean {
  return name === "nitro" || name === "ssr" || config.consumer === "server"
}

export type QueueVitePlugin = Plugin

export function hubQueue(): QueueVitePlugin {
  return {
    name: "@vitehub/queue/vite",
    applyToEnvironment(environment: QueueViteEnvironment) {
      return isQueueServerEnvironment(environment.name, environment.config)
    },
    configEnvironment(name, config) {
      if (!isQueueServerEnvironment(name, config)) return
      return {
        resolve: {
          noExternal: mergeNoExternal(config.resolve?.noExternal),
        },
      }
    },
  } satisfies QueueVitePlugin
}

declare module "vite" {
  interface UserConfig {
    queue?: QueueModuleOptions
  }
}
