import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { vitehub } from "../src/index.ts";
import type { ViteHubOptions } from "../src/index.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function configure(
  options: ViteHubOptions,
  wrangler: Record<string, unknown> = {},
  projectWrangler?: Record<string, unknown> | string,
) {
  const root = await mkdtemp(join(tmpdir(), "vitehub-cf-observability-"));
  roots.push(root);
  if (projectWrangler) await writeFile(join(root, "wrangler.json"), typeof projectWrangler === "string" ? projectWrangler : JSON.stringify(projectWrangler));
  const plugin = vitehub(options).find(
    (candidate) =>
      candidate &&
      typeof candidate === "object" &&
      "name" in candidate &&
      candidate.name === "vite-hub/deployment-host",
  );
  if (
    !plugin ||
    typeof plugin !== "object" ||
    !("config" in plugin) ||
    !plugin.config
  )
    throw new Error("Missing deployment config hook");
  const handler = typeof plugin.config === "function" ? plugin.config : plugin.config.handler;
  const config = { root, nitro: { cloudflare: { wrangler } } };
  await Reflect.apply(handler, undefined, [config, { command: "build", mode: "production" }]);
  return config.nitro.cloudflare.wrangler;
}

describe("Cloudflare Workers observability", () => {
  it("enables native observability for every Cloudflare build", async () => {
    expect(await configure({ host: "cloudflare" })).toMatchObject({ observability: { enabled: true } });
    expect(await configure({ host: "cloudflare", observability: { logs: true } })).toMatchObject({
      observability: { enabled: true },
    });
  });
  it("preserves explicit disabled and exporter configurations", async () => {
    const disabled = { enabled: false };
    const configured = {
      enabled: true,
      head_sampling_rate: 0.25,
      logs: { enabled: false },
      traces: { enabled: true },
    };
    expect((await configure({ host: "cloudflare" }, { observability: disabled })).observability).toEqual(disabled);
    expect((await configure({ host: "cloudflare" }, { observability: configured })).observability).toEqual(
      configured,
    );
  });
  it("leaves the project wrangler file in charge when it sets observability", async () => {
    // Nitro merges this config over the project file, so a default here would turn `enabled: false` back on.
    expect(
      (await configure({ host: "cloudflare" }, {}, { observability: { enabled: false } })).observability,
    ).toBeUndefined();
    expect((await configure({ host: "cloudflare" }, {}, { name: "shop" })).observability).toEqual({ enabled: true });
  });
  it("accepts comments in project wrangler.json with and without an observability override", async () => {
    expect((await configure({ host: "cloudflare" }, {}, `{
      // Worker configuration
      "name": "shop"
    }`)).observability).toEqual({ enabled: true });
    expect((await configure({ host: "cloudflare" }, {}, `{
      /* Keep native collection disabled. */
      "observability": { "enabled": false }
    }`)).observability).toBeUndefined();
  });
  it("leaves other hosts unchanged", async () => {
    expect((await configure({ host: "node" })).observability).toBeUndefined();
  });
});
