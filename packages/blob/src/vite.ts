import type { BlobModuleOptions } from "./types.ts"
import type { EnvironmentOptions, Plugin } from "vite"

const blobPackageName = "@vitehub/blob"

type BlobViteEnvironment = {
  config: Pick<EnvironmentOptions, "consumer">
  name: string
}

function mergeNoExternal(
  current: NonNullable<EnvironmentOptions["resolve"]>["noExternal"],
): NonNullable<EnvironmentOptions["resolve"]>["noExternal"] {
  if (current === true) return true
  if (!current) return [blobPackageName]

  const values = Array.isArray(current) ? current : [current]
  return values.some(value => value === blobPackageName)
    ? values
    : [...values, blobPackageName]
}

function isBlobServerEnvironment(name: string, config: Pick<EnvironmentOptions, "consumer">): boolean {
  return name === "nitro" || name === "ssr" || config.consumer === "server"
}

export type BlobVitePlugin = Plugin

export function hubBlob(): BlobVitePlugin {
  return {
    name: "@vitehub/blob/vite",
    applyToEnvironment(environment: BlobViteEnvironment) {
      return isBlobServerEnvironment(environment.name, environment.config)
    },
    configEnvironment(name, config) {
      if (!isBlobServerEnvironment(name, config)) return
      return {
        resolve: {
          noExternal: mergeNoExternal(config.resolve?.noExternal),
        },
      }
    },
  } satisfies BlobVitePlugin
}

declare module "vite" {
  interface UserConfig {
    blob?: BlobModuleOptions
  }
}
