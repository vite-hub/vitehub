import type { UserConfig } from 'vite'

export function mergeUserConfigs(base: UserConfig, extra?: UserConfig) {
  if (!extra)
    return base

  return {
    ...extra,
    ...base,
    define: {
      ...extra.define,
      ...base.define,
    },
    resolve: {
      ...extra.resolve,
      ...base.resolve,
      alias: {
        ...(typeof extra.resolve?.alias === 'object' && !Array.isArray(extra.resolve.alias) ? extra.resolve.alias : {}),
        ...(typeof base.resolve?.alias === 'object' && !Array.isArray(base.resolve.alias) ? base.resolve.alias : {}),
      },
    },
  } satisfies UserConfig
}
