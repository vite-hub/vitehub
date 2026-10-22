import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import type { Plugin } from "vite";

/** Install a process host exported from an application module into Nitro. */
export function processAgentHost(options: { entry: string; exportName?: string; drainRoute?: string }): Plugin {
  return {
    name: "vitehub:process-agent-host",
    async config(config) {
      const root = resolve(config.root ?? process.cwd());
      const directory = resolve(root, ".vitehub/process-host");
      const entry = resolve(root, options.entry);
      const exportName = options.exportName ?? "default";
      if (!/^[$_\p{ID_Start}][$‌‍\p{ID_Continue}]*$/u.test(exportName))
        throw new Error("Process host exportName must be a JavaScript identifier.");
      const hostImport = exportName !== "default"
        ? `import { ${exportName} as host } from ${JSON.stringify(entry)}`
        : `import host from ${JSON.stringify(entry)}`;
      const drainRoute = options.drainRoute ?? "/api/drain";
      if (!drainRoute.startsWith("/") || /[?#*]/.test(drainRoute))
        throw new Error(
          "Process host drainRoute must be an absolute route without query, hash, or wildcard.",
        );
      // SAFETY: Nitro adds an optional handlers configuration to Vite UserConfig.
      const nitro = (config as typeof config & { nitro?: { handlers?: { route?: string }[] } })
        .nitro;
      if (nitro?.handlers?.some((handler) => handler.route === drainRoute))
        throw new Error(`Process host route already registered: ${drainRoute}`);
      await mkdir(directory, { recursive: true });
      const plugin = resolve(directory, "plugin.ts");
      const drain = resolve(directory, "drain.ts");
      // The generated file lives in the application, which may not resolve ViteHub packages.
      const shutdown = createRequire(import.meta.url).resolve("@vite-hub/runtime/shutdown");
      // On a stop signal, ViteHub stops admission with `host.close()` while HTTP stays up, so
      // webhooks still reach durable queues. Then the server closes HTTP and the process exits.
      await writeFile(
        plugin,
        [
          hostImport,
          `import { onShutdown } from ${JSON.stringify(shutdown)}`,
          "export default function(app) {",
          "  host.start()",
          "  onShutdown(app, 'agent.process-host', () => host.close())",
          "}",
          "",
        ].join("\n"),
      );
      await writeFile(
        drain,
        `${hostImport}\nexport default () => ({ status: host.status() })\n`,
      );
      const result: import("vite").UserConfig & { nitro: { plugins: string[], handlers: { route: string, handler: string }[] } } = { nitro: { plugins: [plugin], handlers: [{ route: drainRoute, handler: drain }] } };
      return result
    },
  };
}
