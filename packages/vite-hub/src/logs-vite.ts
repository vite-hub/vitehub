import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isProductionBuild, resolveViteHubProjectRoot, VITEHUB_PROJECT_ROOT } from "@vite-hub/internal/build/vite";
import { writeFileIfChanged } from "@vite-hub/internal/definition-catalog";
import { createNitroServerKit } from "@vite-hub/internal/nitro-kit";
import type { Plugin } from "vite";
import type { ObservabilityLogsOptions } from "./observability-vite.ts";

export function renderLogsPlugin(
  projectRoot: string,
  source: string | undefined,
  options: { maxEntries?: number; maxEntryBytes?: number } = {},
): string {
  return [
    'import { installLogSource } from "vite-hub/logs/host"',
    ...(source
      ? [`import source from ${JSON.stringify(pathToFileURL(source).href)}`]
      : ['import { createLogBuffer } from "vite-hub/logs/memory"']),
    "export default (app) => {",
    ...(source
      ? []
      : [
          `  const buffer = createLogBuffer(${JSON.stringify(options)})`,
          '  app.hooks.hook("evlog:drain", buffer.drain)',
          "  const source = buffer.source",
        ]),
    `  installLogSource(${JSON.stringify(projectRoot)}, source)`,
    "}",
    "",
  ].join("\n");
}

/** Installs the log source of `observability.logs`. The observability plugin registers Evlog. */
export function logsVitePlugin(options: ObservabilityLogsOptions): Plugin {
  return {
    name: "vite-hub/logs",
    async config(config, environment) {
      const rootValue: unknown = Reflect.get(config, VITEHUB_PROJECT_ROOT);
      const root =
        typeof rootValue === "string"
          ? resolve(rootValue)
          : resolveViteHubProjectRoot(config.root ?? process.cwd());
      const source = "source" in options ? resolve(root, options.source) : undefined;
      if (!source && isProductionBuild(config, environment)) {
        throw new Error(
          '[vitehub] Production Logs needs an existing source. Set observability: { logs: { source: "./server/logs.ts" } }. The local buffer is per process and has no durable history.',
        );
      }
      const nitroValue: unknown = Reflect.get(config, "nitro");
      const kit = createNitroServerKit(
        nitroValue instanceof Object ? Object.fromEntries(Object.entries(nitroValue)) : undefined,
      );
      const file = resolve(root, ".vitehub/nitro/logs/plugin.mjs");
      // A `vitehub` command loads this config while the dev server runs. A rewrite of the same bytes reloads the
      // dev server's Nitro worker, and the reloaded plugin starts a new, empty log buffer.
      await writeFileIfChanged(
        file,
        renderLogsPlugin(
          root,
          source,
          "source" in options
            ? {}
            : { maxEntries: options.maxEntries, maxEntryBytes: options.maxEntryBytes },
        ),
      );
      kit.addPlugin(file);
      Object.assign(config, { nitro: kit.config });
    },
  };
}
