import { ownModule } from "@vite-hub/internal/build/paths"
import { collectDurabilityContributions } from "@vite-hub/internal/durability"
import { readInstanceCount } from "@vite-hub/runtime/durability"

import { generatedNitroPlugin } from "../generated-nitro-plugin.ts"

import type { DurabilityContribution } from "@vite-hub/internal/durability"
import type { OperationContributionEntry } from "@vite-hub/internal/operations"
import type { Plugin } from "vite"

export const durabilityReportersId = "#vitehub/durability/reporters"
const resolvedDurabilityReportersId = `\0${durabilityReportersId}`

export interface DurabilityPluginOptions {
  instances?: number
}

/**
 * The module that the boot plugin imports. It calls each primitive's reporter with the resolved configuration of the
 * primitive and the server environment, so a driver that the environment selects at boot reports correctly.
 */
export function renderDurabilityReporters(contributions: readonly DurabilityContribution[], options: { dev: boolean, instances?: number }): string {
  return [
    "import { collectDurability } from 'vite-hub/runtime/durability'",
    ...contributions.map((contribution, index) => `import { ${contribution.export} as reporter${index} } from ${JSON.stringify(contribution.module)}`),
    "",
    "export function durabilityReports(env) {",
    "  return collectDurability([",
    ...contributions.map((contribution, index) => `    { primitive: ${JSON.stringify(contribution.primitive)}, report: context => reporter${index}(${JSON.stringify(contribution.input)}, context) },`),
    "  ], env)",
    "}",
    "",
    // The dev server only records the report, for `vitehub durability list`.
    `export const durabilityOptions = ${JSON.stringify({ enforce: !options.dev, instances: options.instances, ...(options.dev ? { log: false } : {}) })}`,
    "",
  ].join("\n")
}

const bootPlugin = [
  "import { definePlugin } from 'nitro'",
  "import { checkDurability } from 'vite-hub/runtime/durability'",
  `import { durabilityOptions, durabilityReports } from ${JSON.stringify(durabilityReportersId)}`,
  "",
  "// Prints one line per primitive, and fails at boot when several instances would split state.",
  "export default definePlugin(() => {",
  "  checkDurability(durabilityReports(process.env), durabilityOptions)",
  "})",
  "",
].join("\n")

/**
 * Reports where each primitive of a Node server keeps its state. The primitives contribute reporters through
 * `vitehub.durability`. The server prints them at boot and `vitehub durability list` reads them.
 */
export function viteHubDurabilityPlugin(options: DurabilityPluginOptions = {}): [Plugin, Plugin & { vitehub: { operations: readonly OperationContributionEntry[] } }] {
  // A wrong `node.instances` fails the build, not the first boot.
  readInstanceCount({}, options.instances)
  let plugins: readonly Plugin[] = []
  let dev = false
  const operations: readonly OperationContributionEntry[] = [{
    export: "durabilityOperations",
    load: async () => (await import(/* @vite-ignore */ import.meta.url.endsWith(".ts") ? "./operations.ts" : "./operations.js")).durabilityOperations,
    module: ownModule(import.meta.url, "durability/operations"),
  }]
  return [
    generatedNitroPlugin("vite-hub/durability/nitro", "durability/plugin.mjs", () => bootPlugin),
    {
      name: "vite-hub/durability",
      // Claim the virtual id before Vite treats `#vitehub/*` as package imports.
      enforce: "pre",
      nitro: {
        name: "vite-hub/durability",
        setup(nitro) {
          // Prerender uses a separate builder and is not a deployment instance.
          nitro.hooks.hook("prerender:config", (config) => {
            config.plugins = config.plugins?.filter(plugin => !plugin.replace(/\\/g, "/").endsWith("/.vitehub/nitro/durability/plugin.mjs"))
          })
        },
      },
      config(_config, env) {
        dev = env.command !== "build"
      },
      // The Nuxt adapter replays this hook with its own plugin list.
      configResolved(config) {
        plugins = config.plugins
      },
      resolveId(id) {
        if (id === durabilityReportersId) return resolvedDurabilityReportersId
      },
      // Vite runs `configResolved` hooks in parallel and some primitives resolve their config there, so the reporters
      // render when Nitro loads the module.
      load(id) {
        if (id === resolvedDurabilityReportersId) return renderDurabilityReporters(collectDurabilityContributions(plugins), { dev, instances: options.instances })
      },
      vitehub: { operations },
    },
  ]
}
