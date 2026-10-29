import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveViteHubProjectRoot, VITEHUB_PROJECT_ROOT } from "@vite-hub/internal/build/vite";
import { createNitroServerKit } from "@vite-hub/internal/nitro-kit";
import type { Plugin } from "vite";
import type { ObservabilityEvlogOptions } from "./observability-vite.ts";

export type LogsEvlogOptions = ObservabilityEvlogOptions;
export type LogsOptions =
  | { source: string }
  | { evlog?: LogsEvlogOptions; maxEntries?: number; maxEntryBytes?: number };

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

export function logsVitePlugin(input: true | LogsOptions): Plugin {
  const options = input === true ? {} : input;
  return {
    name: "vite-hub/logs",
    async config(config, environment) {
      const rootValue: unknown = Reflect.get(config, VITEHUB_PROJECT_ROOT);
      const root =
        typeof rootValue === "string"
          ? resolve(rootValue)
          : resolveViteHubProjectRoot(config.root ?? process.cwd());
      const source = "source" in options ? resolve(root, options.source) : undefined;
      if (!source && environment.command === "build") {
        throw new Error(
          '[vitehub] Production Logs needs an existing source. Set logs: { source: "./server/logs.ts" }. The local buffer is per process and has no durable history.',
        );
      }
      const nitroValue: unknown = Reflect.get(config, "nitro");
      const kit = createNitroServerKit(
        nitroValue instanceof Object ? Object.fromEntries(Object.entries(nitroValue)) : undefined,
      );
      if (!source) {
        const { default: evlogModule } = await import("evlog/nitro/v3");
        const modules = Array.isArray(kit.config.modules) ? kit.config.modules : [];
        if (
          !modules.some(
            (module) => module instanceof Object && "name" in module && module.name === "evlog",
          )
        ) {
          kit.config.modules = [
            ...modules,
            evlogModule("evlog" in options ? options.evlog : undefined),
          ];
        }
      }
      const file = resolve(root, ".vitehub/nitro/logs/plugin.mjs");
      await mkdir(dirname(file), { recursive: true });
      await writeFile(
        file,
        renderLogsPlugin(
          root,
          source,
          "source" in options
            ? {}
            : { maxEntries: options.maxEntries, maxEntryBytes: options.maxEntryBytes },
        ),
        "utf8",
      );
      kit.addPlugin(file);
      Object.assign(config, { nitro: kit.config });
    },
  };
}
