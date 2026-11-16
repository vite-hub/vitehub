import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { features } from "@vite-hub/internal/features";
import type { FeatureId } from "@vite-hub/internal/features";
import { describe, expect, it } from "vitest";

import { hostConfigs } from "../app/data/host-configs";
import { changedLines, configHost, pickerHosts, rewriteHostConfig } from "../app/utils/host-config";
import type { HostConfigs } from "../app/utils/host-config";
import { frameworks } from "../app/utils/framework";

const docsRoot = resolve(import.meta.dirname, "../content/docs");

/** The landings whose hero opts in to the host picker, with the code blocks of their files panel. */
const landings = readdirSync(docsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(resolve(docsRoot, entry.name, "index.md")))
  .flatMap((entry) => {
    const source = readFileSync(resolve(docsRoot, entry.name, "index.md"), "utf8");
    const match = source.match(/^::code-tree\{feature="(\w+)"\}\n([\s\S]*?)^::$/m);
    if (!match) return [];
    return frameworks.map((framework) => {
      const view = match[2]!.replace(/^:::framework\{name="([^"]+)"\}\n([\s\S]*?)^:::$/gm,
        (_, name: string, content: string) => name === framework ? content : "");
      const blocks = [...view.matchAll(/^```\w+ \[(.+)\]\n([\s\S]*?)^```$/gm)].map((block) => ({
        code: block[2]!.trimEnd(),
        path: block[1]!,
      }));
      return { blocks, feature: match[1] as FeatureId, framework, slug: entry.name };
    });
  });

describe("host configs of the primitive heroes", () => {
  it("finds the heroes that opt in", () => {
    expect([...new Set(landings.map((landing) => landing.slug))].sort()).toEqual(
      ["blob", "database", "email", "kv", "queue", "rate-limit", "realtime", "sandbox", "schedule"],
    );
    expect(Object.keys(hostConfigs).sort()).toEqual([...new Set(landings.map((landing) => landing.feature))].sort());
  });

  describe.each(landings)("$slug ($framework)", ({ blocks, feature }) => {
    const configs = hostConfigs[feature]!;
    const config = blocks.find((block) => configHost(block.code));
    const authored = configHost(config?.code ?? "")!;

    it("has one config file written for a picker host", () => {
      expect(blocks.filter((block) => configHost(block.code))).toHaveLength(1);
      expect(pickerHosts).toContain(authored);
    });

    it("gives the authored host its authored code back", () => {
      expect(rewriteHostConfig(config!.code, configs, authored)).toBe(config!.code);
    });

    it.each(pickerHosts)("rewrites the config for %s as the catalog says", (host) => {
      const support = features[feature].hosts[host];
      const code = rewriteHostConfig(config!.code, configs, host);
      if (support.level === "unsupported") {
        expect(code).toBeUndefined();
        return;
      }
      expect(code).toContain(`host: '${host}'`);
      // A config that declares Env values imports `env`.
      expect(code!.includes("env(")).toBe(/^import \{ env \} from /m.test(code!));
      // The hero panel is narrow. A rewrite is never wider than the files of its hero.
      const width = (text: string) => Math.max(...text.split("\n").map((line) => line.length));
      expect(width(code!)).toBeLessThanOrEqual(Math.max(...blocks.map((block) => width(block.code))));
      if (support.level === "explicit") {
        const [option, key] = support.option.split(".");
        expect(configs[host]!.options[option!]?.value).toContain(`${key}: `);
      }
    });
  });
});

describe("rewriteHostConfig", () => {
  const code = [
    "import { vitehub } from 'vite-hub'",
    "import { env } from 'vite-hub/env'",
    "",
    "vitehub({",
    "  host: 'node',",
    "  // Two lines",
    "  // of comment",
    "  kv: {",
    "    driver: 'fs-lite', // a { in a comment",
    "    base: '}',",
    "  },",
    "  queue: true,",
    "})",
  ].join("\n");
  const configs: HostConfigs = {
    cloudflare: { options: { kv: { comment: "Workers KV", value: "true" } } },
    netlify: { imports: ["import { env } from 'vite-hub/env'"], options: { kv: { value: "{\n  driver: 'upstash',\n}" } } },
    node: { imports: ["import { env } from 'vite-hub/env'"], options: {} },
    vercel: { options: { queue: { value: "true" } }, remove: ["kv"] },
  };

  it("sets the host, replaces the option and its comment, and drops imports only other hosts use", () => {
    expect(rewriteHostConfig(code, configs, "cloudflare")).toBe([
      "import { vitehub } from 'vite-hub'",
      "",
      "vitehub({",
      "  host: 'cloudflare',",
      "  // Workers KV",
      "  kv: true,",
      "  queue: true,",
      "})",
    ].join("\n"));
  });

  it("keeps the comment when the host gives none, and indents a value of several lines", () => {
    expect(rewriteHostConfig(code, configs, "netlify")).toBe([
      "import { vitehub } from 'vite-hub'",
      "import { env } from 'vite-hub/env'",
      "",
      "vitehub({",
      "  host: 'netlify',",
      "  // Two lines",
      "  // of comment",
      "  kv: {",
      "    driver: 'upstash',",
      "  },",
      "  queue: true,",
      "})",
    ].join("\n"));
  });

  it("removes an option that the host does not need, with its comment lines", () => {
    expect(rewriteHostConfig(code, configs, "vercel")).toBe([
      "import { vitehub } from 'vite-hub'",
      "",
      "vitehub({",
      "  host: 'vercel',",
      "  queue: true,",
      "})",
    ].join("\n"));
  });

  it("adds a missing import after the last one", () => {
    const withoutEnv = code.replace("import { env } from 'vite-hub/env'\n", "");
    expect(rewriteHostConfig(withoutEnv, configs, "netlify")?.split("\n").slice(0, 3)).toEqual([
      "import { vitehub } from 'vite-hub'",
      "import { env } from 'vite-hub/env'",
      "",
    ]);
  });

  it("returns nothing for a host without a config, and fails on a config without the option", () => {
    expect(rewriteHostConfig(code, configs, "deno")).toBeUndefined();
    expect(() => rewriteHostConfig(code.replace("  kv: {", "  store: {"), configs, "cloudflare")).toThrow("`kv`");
  });
});

describe("changedLines", () => {
  it("marks the lines that the rewrite added or changed", () => {
    expect([...changedLines("a\nb\nc\nd", "a\nB\nc\nx\nd")]).toEqual([1, 3]);
    expect([...changedLines("a\nb", "a\nb")]).toEqual([]);
  });
});
