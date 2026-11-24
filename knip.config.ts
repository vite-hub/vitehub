import { existsSync, globSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { KnipConfiguration, WorkspaceProjectConfig } from "knip";
import * as v from "valibot";

const root = import.meta.dirname;

function readText(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

function matching(dir: string, patterns: string[]): string[] {
  return [...new Set(patterns)]
    .filter(pattern => globSync(pattern, { cwd: join(root, dir), exclude: path => /(?:^|\/)(?:node_modules|dist)(?:\/|$)/.test(path) }).length > 0)
    .sort();
}

function manifestTargets(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(manifestTargets);
  if (value && typeof value === "object") return Object.values(value).flatMap(manifestTargets);
  return [];
}

function toSource(target: string): string | undefined {
  if (!target.startsWith("./dist/") || target.endsWith(".iife.js")) return;
  const path = target.replace(/^\.\/dist\//, "src/");
  if (/\.m?js$/.test(path)) return path.replace(/\.m?js$/, ".{ts,mts,tsx,js,mjs}");
  if (path.endsWith(".css")) return path;
}

const manifestSchema = v.object({
  bin: v.optional(v.unknown()),
  exports: v.optional(v.unknown()),
  imports: v.optional(v.record(v.string(), v.unknown())),
});

function packageManifest(dir: string) {
  return v.parse(manifestSchema, JSON.parse(readText(join(dir, "package.json"))));
}

function manifestEntries(dir: string): string[] {
  const manifest = packageManifest(dir);
  return manifestTargets([manifest.exports, manifest.imports, manifest.bin]).flatMap(target => toSource(target) ?? []);
}

function importPaths(dir: string): Record<string, string[]> {
  return Object.fromEntries(Object.entries(packageManifest(dir).imports ?? {}).flatMap(([specifier, target]) => {
    const sources = [...new Set(manifestTargets(target).flatMap(path => toSource(path) ?? []))];
    return sources.length ? [[specifier, sources]] : [];
  }));
}

function viteConfigEntries(dir: string): string[] {
  const configs = readdirSync(join(root, dir)).filter(name => name === "vite.config.ts" || name.endsWith(".vite.config.ts"));
  return configs.flatMap(name => [
    ...name === "vite.config.ts" ? [] : [name],
    ...[...readText(join(dir, name)).matchAll(/["'`]((?:\.\/)?(?:src|runtime|server)\/[^"'`\s${}]+\.(?:ts|mts|tsx|vue|js|mjs))["'`]/g)]
      .flatMap(match => match[1]!.endsWith(".d.ts") ? [] : [match[1]!]),
  ]);
}

const viteHubAppEntries = [
  "server/{api,routes,middleware,plugins,tasks}/**/*.{ts,mts,js,mjs}",
  "server/modules/*.{ts,mts,js,mjs}",
  "server/modules/*/index.{ts,mts,js,mjs}",
  "server/{agents,browsers,channels,connections,queues,realtime,schedules,workflows,workspaces}/**/*.{ts,mts,js,mjs}",
  "server/databases/*.{ts,mts,js,mjs}",
  "server/databases/**/index.{ts,mts,js,mjs}",
  "server/sandbox-tasks/**/index.{ts,mts,js,mjs}",
  "server/{auth,comments,content}.{ts,mts,js,mjs}",
  "server.auth.{ts,mts,js,mjs}",
  "src/database.ts",
  "src/**/*.{agent,browser,channel,connection,database,queue,sandbox-task,schedule,workflow,workspace}.{ts,mts,js,mjs}",
];

function appEntries(dir: string): string[] {
  return matching(dir, [...viteHubAppEntries, ...viteConfigEntries(dir)]);
}

const packageEntries = [
  "test/**/*.test-d.ts",
  "test/**/*.browser.mjs",
];

const bundledInternal: Record<string, string[]> = {
  agent: ["@sqlite.org/sqlite-wasm", "@valibot/to-json-schema", "@vercel/nft", "birpc"],
  blob: ["@valibot/to-json-schema", "birpc"],
  bundle: ["@valibot/to-json-schema"],
  cli: ["@babel/parser", "birpc"],
  comments: ["@valibot/to-json-schema", "birpc"],
  content: ["@valibot/to-json-schema", "birpc"],
  database: ["@sqlite.org/sqlite-wasm"],
  email: ["@valibot/to-json-schema", "birpc"],
  forms: ["birpc"],
  kv: ["@valibot/to-json-schema", "birpc"],
  "rate-limit": ["@valibot/to-json-schema", "birpc"],
  runtime: ["@valibot/to-json-schema", "valibot"],
  schedule: ["@valibot/to-json-schema"],
  sync: ["birpc"],
  "vite-hub": ["@valibot/to-json-schema", "birpc"],
  workflow: ["@valibot/to-json-schema", "h3", "semver"],
  workspace: ["@valibot/to-json-schema", "@vercel/nft", "birpc"],
};

const packsWithPublint = ["forge", "gateways", "presets", "runtime", "shell"];

const packageOverrides: Record<string, WorkspaceProjectConfig> = {
  agent: {
    entry: ["test/browser-smoke-cleanup.test.mjs"],
    ignoreDependencies: ["unstorage"],
  },
  auth: { ignoreDependencies: ["@types/node"] },
  codemods: {
    entry: [
      "test/real-world/run.mjs",
      "test/nuxthub-runtime.d.mts",
    ],
  },
  comments: { ignoreDependencies: ["@vite-hub/ui"] },
  console: {
    entry: viteHubAppEntries,
    vite: false,
  },
  docs: {
    entry: ["runtime/**/*.{ts,vue,css}"],
    ignoreDependencies: [
      "@nuxt/fonts",
      "nuxt-agent-discovery",
      "nuxt-og-image",
      "nuxt-site-config",
      "@takumi-rs/core",
    ],
  },
  email: { ignoreDependencies: ["@vitejs/plugin-vue"] },
  env: { ignoreDependencies: ["nuxt"] },
  i18n: { ignoreDependencies: ["@diglot/cli"] },
  internal: {
    ignoreDependencies: [
      "sharp",
    ],
  },
  presets: { ignoreDependencies: ["@t3tools/provider-runtime"] },
  realtime: { ignoreDependencies: ["prosemirror-transform"] },
  sandbox: { ignoreDependencies: ["@cloudflare/sandbox"] },
  schedule: { ignoreBinaries: ["systemd-analyze"] },
  ui: {
    ignoreBinaries: ["ffmpeg", "ffprobe"],
    ignoreUnresolved: ["/@uploads-today"],
    ignoreDependencies: [
      "nuxt-nightly",
      "@shikijs/langs",
      "@shikijs/themes",
      "vega-loader",
    ],
  },
  "vite-hub": {
    entry: ["src/console/runtime/client/shiki-wasm.ts"],
    ignoreDependencies: ["pnp-peer"],
  },
};

function packageWorkspace(name: string): WorkspaceProjectConfig {
  const dir = `packages/${name}`;
  const override = packageOverrides[name] ?? {};
  const ignoreDependencies = [
    ...bundledInternal[name] ?? [],
    ...packsWithPublint.includes(name) ? ["publint"] : [],
    ...override.ignoreDependencies ?? [],
  ];
  return {
    ...override,
    entry: matching(dir, [
      ...manifestEntries(dir),
      ...existsSync(join(root, dir, "vite.config.ts")) ? viteConfigEntries(dir).filter(entry =>
        name !== "vite-hub" || !["src/internal/test-loader.ts", "src/internal/test-server.ts"].includes(entry)) : [],
      ...packageEntries,
      ...[override.entry ?? []].flat(),
    ]),
    ...ignoreDependencies.length ? { ignoreDependencies: [...new Set(ignoreDependencies)] } : {},
    paths: importPaths(dir),
    vitest: { config: ["vitest.config.ts", "vitest.*.config.ts"] },
  };
}

const packageWorkspaces = Object.fromEntries(
  readdirSync(join(root, "packages"), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(root, "packages", entry.name, "package.json")))
    .map(entry => [`packages/${entry.name}`, packageWorkspace(entry.name)]),
);

const config: KnipConfiguration = {
  include: ["files", "dependencies", "unlisted", "unresolved", "binaries", "catalog"],
  exclude: ["optionalPeerDependencies"],
  ignore: ["fixtures/**", "test/fixtures/**", "test/multi-instance/app/**", "packages/*/fixtures/**", "packages/*/test/fixtures/**", "playground/chatgpt/**", "packages/docs/playground/examples/**", "packages/docs/playground/fixtures/**", "scripts/console-weight/fixture/**"],
  compilers: {
    css: (text: string) => [...text.matchAll(/(?:@import\s+|url\(\s*)["']([^"']+)["']/g)]
      .filter(match => !/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(match[1]!))
      .map(match => `import ${JSON.stringify(match[1])};`).join("\n"),
  },
  ignoreUnresolved: [/^#vitehub\//, /^#docs\//, "#app", "#console-assets", "#console-outbound-fetch", "#console-page"],
  ignoreBinaries: ["crabbox"],
  workspaces: {
    ".": {
      entry: [
        "scripts/*.mjs",
        "scripts/bench-vercel-runtime-packages/*.mjs",
        "scripts/lint/delete-comments.mjs",
        "scripts/lint/update-comment-baseline.mjs",
        ".github/scripts/claim-npm-packages.mjs",
        "test/local/vercel-bridge-server.mjs",
        ...matching("playground/vite", ["vite.config.ts", ...viteConfigEntries("playground/vite"), ...viteHubAppEntries])
          .map(pattern => `playground/vite/${pattern}`),
      ],
      ignoreDependencies: [
        "oxlint",
        "@vercel/blob",
        "sharp",
      ],
      vitest: { config: ["vitest.config.ts", "test/consumer/vitest.config.ts", "test/output/vitest.config.ts"] },
    },
    ...packageWorkspaces,
    docs: {
      entry: [
        ...matching("docs", viteHubAppEntries),
        "app/components/content/**/*.vue",
        "app/examples/**/*.vue",
        "scripts/**/*.mjs",
        "test/**/*.test.ts",
        "test/browser/*.browser.mjs",
      ],
      ignoreDependencies: [
        /^@iconify-json\//,
        "@better-auth/cimd",
        "@chat-adapter/slack",
        "@nuxt/icon",
        "agents",
      ],
      vitest: { config: ["vitest.config.ts", "vitest.artifact.config.ts"] },
    },
    "packages/env/examples/schema-lab": { entry: ["src/type-contract.ts"] },
    "playground/console": { entry: ["icons.ts"] },
    "playground/content": {
      entry: appEntries("playground/content"),
      vite: false,
    },
    "playground/docs": {
      entry: appEntries("playground/docs"),
      ignoreDependencies: [
        /^@iconify-json\//,
      ],
    },
    "packages/docs/playground": {
      entry: [
        ...appEntries("packages/docs/playground"),
        "app/components/**/*.vue",
        "app/utils/*.ts",
        "app/playground/*.ts",
        "scripts/*.mjs",
        "illustrations/*.mjs",
        ".claude/skills/illustration-isometric-mono/scripts/*.mjs",
      ],
      ignoreDependencies: [
        /^@iconify-json\//,
        "agents",
        "h3",
        "wrangler",
      ],
    },
    "playground/logs": { entry: appEntries("playground/logs"), vite: false },
  },
  ignoreWorkspaces: [
    "fixtures/tutorials/chat-app",
    "packages/codemods/examples/*",
  ],
};

export default config;
