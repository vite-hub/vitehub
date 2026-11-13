import { mkdtemp, readFile, rm, stat, utimes } from "node:fs/promises";
import { resolve } from "node:path";
import { mergeConfig, resolveConfig } from "vite";
import type { ConfigEnv, InlineConfig } from "vite";
import { describe, expect, it, vi } from "vitest";
import evlog from "evlog/nitro/v3";
import { VITEHUB_PROJECT_ROOT } from "@vite-hub/internal/build/vite";
import { vitehub } from "../src/index.ts";
import { logsVitePlugin } from "../src/logs-vite.ts";
import { observabilityVitePlugin } from "../src/observability-vite.ts";

vi.mock("evlog/nitro/v3", async (importOriginal) => {
  const module = await importOriginal<typeof import("evlog/nitro/v3")>();
  return { ...module, default: vi.fn(module.default) };
});

type LogsConfig = InlineConfig & {
  [VITEHUB_PROJECT_ROOT]: string;
  nitro: { plugins: string[]; modules?: { name: string }[] };
};

async function configure(
  root: string,
  input: Parameters<typeof logsVitePlugin>[0],
  command: "serve" | "build",
  nitro?: object,
) {
  const hook = logsVitePlugin(input).config;
  if (typeof hook !== "function") throw new Error("Expected config hook");
  const config = { root, nitro, [VITEHUB_PROJECT_ROOT]: root };
  // SAFETY: This hook does not read the Vite hook context. Reflect.apply avoids a fictitious host implementation.
  const result = await Reflect.apply(hook, undefined, [
    config,
    { command, mode: command === "build" ? "production" : "development" } satisfies ConfigEnv,
  ]);
  // SAFETY: The hook installs these Nitro keys; Vite merges any returned config into the mutated input.
  return mergeConfig(config, result ?? {}) as LogsConfig;
}

describe("Logs host integration", () => {
  it("has one owner for request error logging", () => {
    const names = (observability: NonNullable<Parameters<typeof vitehub>[0]>["observability"]) =>
      vitehub({ host: "node", observability }).flatMap((plugin) =>
        plugin && typeof plugin === "object" && "name" in plugin ? [plugin.name] : [],
      );
    expect(names({ logs: true })).not.toContain("vite-hub/error-log");
    expect(names(true)).not.toContain("vite-hub/error-log");
    expect(names({ logs: { source: "./server/logs.ts" } })).toContain("vite-hub/error-log");
    expect(names({ logs: true, evlog: { enabled: false } })).toContain("vite-hub/error-log");
  });
  it("starts no logger for a source without a service", () => {
    const names = (observability: NonNullable<Parameters<typeof vitehub>[0]>["observability"]) =>
      vitehub({ host: "node", observability }).flatMap((plugin) =>
        plugin && typeof plugin === "object" && "name" in plugin ? [plugin.name] : [],
      );
    expect(names({ logs: { source: "./server/logs.ts" } })).not.toContain("vite-hub/observability");
    expect(names({ logs: { source: "./server/logs.ts" } })).toContain("vite-hub/logs");
    expect(names({ logs: true })).toEqual(expect.arrayContaining(["vite-hub/observability", "vite-hub/logs"]));
  });
  it("attaches a local drain once", async () => {
    const root = await mkdtemp(resolve(".logs-vite-test-"));
    try {
      const config = await configure(root, { maxEntries: 32 }, "serve");
      expect(config.nitro.modules ?? []).toHaveLength(0);
      const plugin = await readFile(config.nitro.plugins[0]!, "utf8");
      const replay = await configure(root, { maxEntries: 32 }, "serve", config.nitro);
      expect(replay.nitro.plugins).toHaveLength(1);
      expect(plugin).toContain('app.hooks.hook("evlog:drain", buffer.drain)');
      expect(plugin).toContain('"maxEntries":32');
      expect(plugin).not.toContain("initLogger");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("keeps the plugin file untouched when a CLI command loads the same config", async () => {
    const root = await mkdtemp(resolve(".logs-vite-test-"));
    try {
      // The dev server writes the plugin first. A `vitehub` command then loads the same project while the server watches it.
      const config = await configure(root, {}, "serve");
      const plugin = config.nitro.plugins[0]!;
      const written = new Date("2020-01-01T00:00:00Z");
      await utimes(plugin, written, written);
      await configure(root, {}, "serve");
      expect((await stat(plugin)).mtime).toEqual(written);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("preserves existing Nitro entries through Vite config resolution", async () => {
    const root = await mkdtemp(resolve(".logs-vite-test-"));
    try {
      const existing = { name: "existing", setup() {} };
      const input: LogsConfig = {
        root,
        [VITEHUB_PROJECT_ROOT]: root,
        configFile: false,
        plugins: [observabilityVitePlugin({}), logsVitePlugin({})],
        nitro: { modules: [existing], plugins: ["existing-plugin"] },
      };
      const config = await resolveConfig(input, "serve");
      expect(Reflect.get(config, "nitro")).toMatchObject({
        modules: [existing, expect.objectContaining({ name: "evlog" })],
        plugins: ["existing-plugin", resolve(root, ".vitehub/nitro/logs/plugin.mjs")],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("registers Evlog with its options for local Logs without a service", async () => {
    const root = await mkdtemp(resolve(".logs-vite-test-"));
    try {
      const plugins = vitehub({
        host: "node",
        observability: { logs: true, evlog: { redact: true } },
      }).flatMap((plugin) => plugin && typeof plugin === "object" && "name" in plugin ? [plugin] : []);
      const input: LogsConfig = {
        root,
        [VITEHUB_PROJECT_ROOT]: root,
        configFile: false,
        plugins: plugins.filter(plugin => ["vite-hub/observability", "vite-hub/logs"].includes(plugin.name)),
        nitro: { plugins: [] },
      };
      const config = await resolveConfig(input, "serve");
      expect(Reflect.get(config, "nitro")).toMatchObject({
        modules: [expect.objectContaining({ name: "evlog" })],
        // No service: only the Logs plugin, and no `useObservability()` plugin.
        plugins: [resolve(root, ".vitehub/nitro/logs/plugin.mjs")],
      });
      expect(evlog).toHaveBeenLastCalledWith({ redact: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("connects a production reader without adding Evlog or a second buffer", async () => {
    const root = await mkdtemp(resolve(".logs-vite-test-"));
    try {
      const config = await configure(root, { source: "./server/logs.ts" }, "build");
      expect(config.nitro.modules ?? []).toHaveLength(0);
      const plugin = await readFile(config.nitro.plugins[0]!, "utf8");
      expect(plugin).toContain("server/logs.ts");
      expect(plugin).not.toContain("createLogBuffer");
      expect(plugin).not.toContain("evlog:drain");
      await expect(configure(root, {}, "build")).rejects.toThrow(
        "Production Logs needs an existing source",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
