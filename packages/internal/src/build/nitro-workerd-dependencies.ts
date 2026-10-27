import type { Plugin } from "vite"

/**
 * Nitro's workerd dev runner, the default of its Cloudflare presets, sets `resolve.noExternal: true` and runs every
 * dependency through Vite's module runner as source. Vite pre-bundles dependencies only for the client by default, so
 * a CommonJS dependency, such as `promise-limit` under `@libsql/client` or the OpenTelemetry constants under Better
 * Auth, reaches workerd unconverted and fails with "module is not defined" or "exports is not defined".
 *
 * This plugin lets Vite find and pre-bundle the dependencies of those environments, as `@cloudflare/vite-plugin` does
 * for its Workers. Nitro stays out of the pre-bundle, because its app module must keep the routes of the app. An app
 * that sets `optimizeDeps.noDiscovery` for the environment keeps its own setting.
 */
export function nitroWorkerdDependencies(): Plugin {
  return {
    name: "vite-hub/nitro-workerd-dependencies",
    apply: "serve",
    // Nitro adds its environments in its `config` hook and auto-detected services in `configEnvironment`.
    enforce: "post",
    configEnvironment(_name, config) {
      if (config.consumer === "client" || config.resolve?.noExternal !== true) return
      if (config.optimizeDeps?.noDiscovery !== undefined) return
      return { optimizeDeps: { noDiscovery: false, exclude: ["nitro"] } }
    },
  }
}
