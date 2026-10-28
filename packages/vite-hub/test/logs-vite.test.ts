import { mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { ConfigEnv, UserConfig } from "vite";
import { describe, expect, it } from "vitest";
import { vitehub } from "../src/index.ts";
import { logsVitePlugin } from "../src/logs-vite.ts";

async function configure(
  root: string,
  input: Parameters<typeof logsVitePlugin>[0],
  command: "serve" | "build",
  nitro?: object,
) {
  const hook = logsVitePlugin(input).config;
  if (typeof hook !== "function") throw new Error("Expected config hook");
  // SAFETY: This hook does not read the Vite hook context. Reflect.apply avoids a fictitious host implementation.
  return Reflect.apply(hook, undefined, [
    { root, nitro },
    { command, mode: command === "build" ? "production" : "development" } satisfies ConfigEnv,
  ]) as Promise<UserConfig & { nitro: { plugins: string[]; modules?: { name: string }[] } }>;
}

describe("Logs host integration", () => {
  it("has one owner for request error logging", () => {
    const names = (logs: NonNullable<Parameters<typeof vitehub>[0]>["logs"]) => vitehub({ preset: "node", logs }).flatMap(plugin => plugin && typeof plugin === "object" && "name" in plugin ? [plugin.name] : [])
    expect(names(true)).not.toContain("vite-hub/error-log")
    expect(names({ source: "./server/logs.ts" })).toContain("vite-hub/error-log")
    expect(names({ evlog: { enabled: false } })).toContain("vite-hub/error-log")
  })
  it("attaches a local drain and reuses the installed Evlog module", async () => {
    const root = await mkdtemp(resolve(".logs-vite-test-"));
    try {
      const config = await configure(root, { maxEntries: 32, evlog: { redact: true } }, "serve");
      expect(config.nitro.modules).toEqual([expect.objectContaining({ name: "evlog" })]);
      const replay = await configure(root, true, "serve", config.nitro);
      expect(replay.nitro.modules).toHaveLength(1);
      expect(replay.nitro.plugins).toHaveLength(1);
      const plugin = await readFile(config.nitro.plugins[0]!, "utf8");
      expect(plugin).toContain('app.hooks.hook("evlog:drain", buffer.drain)');
      expect(plugin).not.toContain("initLogger");
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
      await expect(configure(root, true, "build")).rejects.toThrow(
        "Production Logs needs an existing source",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
