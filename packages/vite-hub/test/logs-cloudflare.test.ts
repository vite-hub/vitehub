import { describe, expect, it } from "vitest";
import { vitehub } from "../src/index.ts";

async function configure(
  logs: boolean,
  wrangler: Record<string, unknown> = {},
  preset: "cloudflare" | "node" = "cloudflare",
) {
  const plugin = vitehub({ preset, logs }).find(
    (candidate) =>
      candidate &&
      typeof candidate === "object" &&
      "name" in candidate &&
      candidate.name === "vite-hub/deployment-preset",
  );
  if (
    !plugin ||
    typeof plugin !== "object" ||
    !("config" in plugin) ||
    typeof plugin.config !== "function"
  )
    throw new Error("Missing deployment config hook");
  const config = { nitro: { cloudflare: { wrangler } } };
  await Reflect.apply(plugin.config, undefined, [config, { command: "build", mode: "production" }]);
  return config.nitro.cloudflare.wrangler;
}

describe("Cloudflare Logs collection", () => {
  it("enables native observability when Logs is enabled", async () => {
    expect(await configure(true)).toMatchObject({ observability: { enabled: true } });
  });
  it("preserves explicit disabled and exporter configurations", async () => {
    const disabled = { enabled: false };
    const configured = {
      enabled: true,
      head_sampling_rate: 0.25,
      logs: { enabled: false },
      traces: { enabled: true },
    };
    expect((await configure(true, { observability: disabled })).observability).toEqual(disabled);
    expect((await configure(true, { observability: configured })).observability).toEqual(
      configured,
    );
  });
  it("leaves collection unchanged when Logs is disabled or the host is not Cloudflare", async () => {
    expect((await configure(false)).observability).toBeUndefined();
    expect((await configure(true, {}, "node")).observability).toBeUndefined();
  });
});
