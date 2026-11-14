import type { Plugin, UserConfig } from "vite"

/** The installed ViteHub packages, such as `node_modules/vite-hub/` and `node_modules/.pnpm/…/node_modules/@vite-hub/env/`. */
export const viteHubPackagePath: RegExp = /[\\/]node_modules[\\/](?:vite-hub|@vite-hub[\\/][^\\/]+)[\\/]/

type VitestConfig = UserConfig & { test?: { server?: { deps?: { inline?: unknown } } } }

/**
 * Vitest loads the packages in `node_modules` with Node, without Vite plugins. ViteHub roots such as `vite-hub/env`
 * import the modules that `vitehub()` generates, so Node would load their placeholders and `useServerEnv()` would fail
 * with `ENV_NOT_GENERATED`. This lets Vite transform the ViteHub packages in Vitest, as it does in `vite dev`.
 */
export function vitestInlinePlugin(): Plugin {
  return {
    name: "vite-hub:vitest-inline",
    config(config: VitestConfig) {
      // `inline: true` already transforms every package.
      if (!process.env.VITEST || config.test?.server?.deps?.inline === true) return
      const testConfig: VitestConfig = { test: { server: { deps: { inline: [viteHubPackagePath] } } } }
      return testConfig
    },
  }
}
