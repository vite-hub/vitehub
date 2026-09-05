import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Plugin } from "vite";

/** Install a process host exported as default from an application module into Nitro. */
export function processAgentHost(options: { entry: string; drainRoute?: string }): Plugin {
  return {
    name: "vitehub:process-agent-host",
    async config(config) {
      const root = resolve(config.root ?? process.cwd());
      const directory = resolve(root, ".vitehub/process-host");
      const entry = resolve(root, options.entry);
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
      await writeFile(
        plugin,
        `import host from ${JSON.stringify(entry)}\nexport default function(app) { host.start(); app.hooks.hook('close', () => host.close()) }\n`,
      );
      await writeFile(
        drain,
        `import host from ${JSON.stringify(entry)}\nexport default () => ({ status: host.status() })\n`,
      );
      const result: import("vite").UserConfig & { nitro: { plugins: string[], handlers: { route: string, handler: string }[] } } = { nitro: { plugins: [plugin], handlers: [{ route: drainRoute, handler: drain }] } };
      return result
    },
  };
}
