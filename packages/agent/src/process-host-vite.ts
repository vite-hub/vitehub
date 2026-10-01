import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Plugin } from "vite";

type ProcessHostStopSignal = "SIGINT" | "SIGTERM";

/** The part of `process` that the generated stop handler uses. Tests pass a replacement. */
export interface ProcessHostStopRuntime {
  exit(code: number): void;
  listeners(signal: ProcessHostStopSignal): unknown[];
  off(signal: ProcessHostStopSignal, listener: (signal: ProcessHostStopSignal) => void): unknown;
  on(signal: ProcessHostStopSignal, listener: (signal: ProcessHostStopSignal) => void): unknown;
}

/**
 * Starts the host in the generated Nitro plugin and installs its stop order.
 *
 * SIGTERM and SIGINT first stop admission with `host.close()`, which waits for the
 * invocations that the host tracks. HTTP stays up, so webhooks still reach durable
 * queues. Then the server's own signal listeners close HTTP, and the process exits.
 * A second signal does not start more work.
 *
 * The Nitro Node server calls srvx `serve()` after it runs plugins, and srvx adds its
 * graceful shutdown listeners there. Nitro does not expose an option that disables
 * them or orders them after a plugin. This function records the existing listeners,
 * then detaches the listeners that were added during startup on the next check phase
 * and calls them after the drain.
 *
 * The plugin generator emits this function with `Function.prototype.toString()`,
 * so it must use only its parameters and JavaScript globals.
 */
export function installProcessHostStop(
  host: { close(): Promise<void>; start(): void },
  app: { hooks: { hook(name: "close", callback: () => Promise<void>): unknown } },
  runtime: ProcessHostStopRuntime = process,
): void {
  host.start();
  app.hooks.hook("close", () => host.close());
  const signals: ProcessHostStopSignal[] = ["SIGTERM", "SIGINT"];
  const existing = new Map(signals.map((signal) => [signal, new Set(runtime.listeners(signal))]));
  setImmediate(() => {
    const serverListeners: [ProcessHostStopSignal, (signal: ProcessHostStopSignal) => unknown][] = [];
    for (const signal of signals) {
      for (const listener of runtime.listeners(signal)) {
        // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Signal listeners come from the Node process and are untyped at this boundary.
        if (typeof listener !== "function" || existing.get(signal)?.has(listener)) continue;
        // SAFETY: the check above proves the listener is callable, and Node calls signal listeners with the signal name.
        const handler = listener as (signal: ProcessHostStopSignal) => void;
        runtime.off(signal, handler);
        serverListeners.push([signal, handler]);
      }
    }
    let stopping: Promise<void> | undefined;
    const stop = (signal: ProcessHostStopSignal) => {
      stopping ??= (async () => {
        console.info("[vitehub]", JSON.stringify({ event: "process.stop.draining", signal, timestamp: new Date().toISOString() }));
        try {
          await host.close();
        } catch (error) {
          console.error("[vitehub]", error);
        }
        const closeServer = Promise.all(
          serverListeners
            .filter(([name]) => name === signal)
            .map(([, listener]) => Promise.resolve().then(() => listener(signal))),
        );
        await Promise.race([
          closeServer.catch((error: unknown) => console.error("[vitehub]", error)),
          new Promise((resolve) => setTimeout(resolve, 10_000).unref()),
        ]);
        console.info("[vitehub]", JSON.stringify({ event: "process.stop.exited", signal, timestamp: new Date().toISOString() }));
        runtime.exit(0);
      })();
    };
    for (const signal of signals) runtime.on(signal, stop);
  });
}

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
      await writeFile(
        plugin,
        `${hostImport}\nconst installProcessHostStop = ${installProcessHostStop.toString()}\nexport default function(app) { installProcessHostStop(host, app) }\n`,
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
