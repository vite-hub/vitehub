import { existsSync, globSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { KnipConfiguration, WorkspaceProjectConfig } from "knip";
import * as v from "valibot";

// Knip prints a configuration hint for an entry pattern that matches no file and for an ignore that it does not
// need. This config adds only the patterns that match, so a new hint means that the config is out of date.

const root = import.meta.dirname;

function readText(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

function matching(dir: string, patterns: string[]): string[] {
  return [...new Set(patterns)]
    .filter(pattern => globSync(pattern, { cwd: join(root, dir), exclude: path => /(?:^|\/)(?:node_modules|dist)(?:\/|$)/.test(path) }).length > 0)
    .sort();
}

// Every string leaf of a package.json `exports`, `imports` or `bin` value.
function manifestTargets(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(manifestTargets);
  if (value && typeof value === "object") return Object.values(value).flatMap(manifestTargets);
  return [];
}

// Packages build `src/<path>.ts` to `./dist/<path>.js` and copy `src/<path>.css` to `./dist/<path>.css`. Knip maps dist
// to src only from a tsconfig `outDir`, which these packages do not set, so map the manifest targets back here.
// A browser script such as `./dist/page/pill.iife.js` has its own entry in the package config.
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

// `#vitehub/<package>/...` package imports point at `dist`. Resolve them to the source the same way.
function importPaths(dir: string): Record<string, string[]> {
  return Object.fromEntries(Object.entries(packageManifest(dir).imports ?? {}).flatMap(([specifier, target]) => {
    const sources = [...new Set(manifestTargets(target).flatMap(path => toSource(path) ?? []))];
    return sources.length ? [[specifier, sources]] : [];
  }));
}

// `vp pack` entries and the per-mode server entries of an app live in `vite.config.ts` and the extra
// `*.vite.config.ts` builds. The Knip vite-plus plugin reads only `run.tasks`, so take every source path that
// these configs name, plus the extra configs: `vp build --config <file>` is not a script that Knip reads.
function viteConfigEntries(dir: string): string[] {
  const configs = readdirSync(join(root, dir)).filter(name => name === "vite.config.ts" || name.endsWith(".vite.config.ts"));
  return configs.flatMap(name => [
    ...name === "vite.config.ts" ? [] : [name],
    ...[...readText(join(dir, name)).matchAll(/["'`]((?:src|runtime)\/[^"'`\s${}]+\.(?:ts|mts|tsx|vue|js|mjs))["'`]/g)]
      .flatMap(match => match[1]!.endsWith(".d.ts") ? [] : [match[1]!]),
  ]);
}

// A ViteHub app: the framework loads `server/` files by convention, and the `*.<kind>.ts` files that each
// Server Primitive discovers (see the `*SuffixPattern` constants of each package's discovery).
const viteHubAppEntries = [
  "server/**/*.{ts,mts,js,mjs}",
  "src/**/*.{agent,browser,channel,connection,database,queue,sandbox-task,schedule,workflow,workspace}.{ts,mts,js,mjs}",
];

const packageEntries = [
  // Vitest runs these through `typecheck.include`, which the Knip Vitest plugin does not read, or the package tsconfig checks them.
  "test/**/*.test-d.ts",
  // Browser checks that people run by hand with `node --test` against a running app.
  "test/**/*.browser.mjs",
];

// Packages bundle `@vite-hub/internal` (`alwaysBundle`), so the imports of the internal modules that they use become
// theirs, and each one declares them. `@valibot/to-json-schema` stays external through the `neverBundle` of internal.
const bundledInternal: Record<string, string[]> = {
  agent: ["@sqlite.org/sqlite-wasm", "@valibot/to-json-schema", "@vercel/nft"],
  blob: ["@valibot/to-json-schema"],
  cli: ["@babel/parser"],
  codemods: ["@babel/parser"],
  comments: ["@valibot/to-json-schema"],
  content: ["@valibot/to-json-schema"],
  database: ["@sqlite.org/sqlite-wasm"],
  email: ["@valibot/to-json-schema"],
  kv: ["@valibot/to-json-schema"],
  "rate-limit": ["@valibot/to-json-schema"],
  schedule: ["@valibot/to-json-schema"],
  "vite-hub": ["@valibot/to-json-schema", "semver"],
  workflow: ["@valibot/to-json-schema", "h3", "semver"],
  workspace: ["@valibot/to-json-schema", "@vercel/nft"],
};

// `vp pack` runs publint because their config sets `publint`. Knip does not see that use in these packages.
const packsWithPublint = ["forge", "gateways", "presets", "runtime", "shell"];

// Settings that no manifest, config or script states.
const packageOverrides: Record<string, WorkspaceProjectConfig> = {
  agent: {
    // `run-node-tests.mjs` runs this file outside Vitest.
    entry: ["test/browser-smoke-cleanup.test.mjs"],
  },
  // The tsconfig lists `node` in `types` and the tests import `node:` modules, but Knip does not count it here.
  auth: { ignoreDependencies: ["@types/node"] },
  // A script that people run by hand on real projects.
  codemods: { entry: ["test/real-world/run.mjs"] },
  // The overlay build aliases `@vite-hub/ui` to its source (`overlay.aliases.ts`) and bundles it.
  comments: { ignoreDependencies: ["@vite-hub/ui"] },
  // A ViteHub app. Its config imports `vite-hub` from the build output, which Knip cannot load before a build.
  console: {
    entry: viteHubAppEntries,
    vite: false,
  },
  docs: {
    // The Nuxt module adds `runtime/app` as a layer and its server handlers by path.
    entry: ["runtime/**/*.{ts,vue,css}"],
    ignoreDependencies: [
      // The module installs these Nuxt modules by name from `moduleDependencies`.
      "nuxt-agent-discovery",
      "nuxt-llms",
      "nuxt-og-image",
      "nuxt-site-config",
      // nuxt-og-image renders the `*.takumi.vue` share images with it.
      "@takumi-rs/core",
    ],
  },
  // The CLI loads `nuxt/kit` from the app with `createRequire`, so the app owns that dependency.
  env: { ignoreDependencies: ["nuxt"] },
  // The test resolves the `diglot` binary with `createRequire().resolve()`.
  i18n: { ignoreDependencies: ["@diglot/cli"] },
  internal: {
    ignoreDependencies: [
      // Root consumer tests resolve `sharp` from this package with `createRequire`.
      "sharp",
      // remove when #3795 merges: nothing imports it, and #3795 removes it with the Effect process driver of Schedules
      "effect",
    ],
  },
  // The tests mock it with `vi.mock()`. The code under test imports it through `@vite-hub/agent`.
  presets: { ignoreDependencies: ["@t3tools/provider-runtime"] },
  // The bundled `@tiptap/y-tiptap` imports it, and `neverBundle` keeps it external.
  realtime: { ignoreDependencies: ["prosemirror-transform"] },
  // The generated Durable Object imports it, and the tests build that output.
  sandbox: { ignoreDependencies: ["@cloudflare/sandbox"] },
  ui: {
    ignoreDependencies: [
      // The bundled `@pierre/diffs` imports these, and `neverBundle` keeps `vega-loader` external for the bundled Vega code.
      "@shikijs/langs",
      "@shikijs/themes",
      "@pierre/theme",
      "vega-loader",
    ],
  },
  "vite-hub": {
    // `console.vite.config.ts` aliases `shiki/wasm` to this file by path.
    entry: ["src/console/runtime/client/shiki-wasm.ts"],
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
      ...existsSync(join(root, dir, "vite.config.ts")) ? viteConfigEntries(dir) : [],
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
  // `dependencies` also checks devDependencies. Off: `optionalPeerDependencies`, because packages import their optional
  // peers on purpose when an app uses that feature; and `exports`, `types` and `duplicates`, which report the public API
  // of every package.
  include: ["files", "dependencies", "unlisted", "unresolved", "binaries", "catalog"],
  exclude: ["optionalPeerDependencies"],
  // Test fixtures are sample apps and inputs. `playground/chatgpt` is not a pnpm workspace, so its dependencies are not installed.
  ignore: ["fixtures/**", "test/fixtures/**", "packages/*/fixtures/**", "packages/*/test/fixtures/**", "playground/chatgpt/**"],
  // CSS reaches packages through `@import` and `url()`, such as the Console fonts.
  compilers: {
    css: (text: string) => [...text.matchAll(/(?:@import\s+|url\(\s*)["']([^"'./][^"':]*)["']/g)].map(match => `import "${match[1]}";`).join("\n"),
  },
  // Runtime modules of Cloudflare Workers, such as `cloudflare:workers`. Knip reads them as the npm package `cloudflare`.
  ignoreDependencies: ["cloudflare"],
  // Virtual modules: Vite plugins of each Server Primitive serve `#vitehub/*`, and the docs Nuxt module serves `#docs/*`.
  ignoreUnresolved: [/^#vitehub\//, /^#docs\//, "#agent-discovery", "#app"],
  // A CLI that people install on their own machine. The Sandbox runs it when they choose the Crabbox provider.
  ignoreBinaries: ["crabbox"],
  ignoreIssues: {
    // remove when #3775 or #3780 merges: both delete these two files
    "packages/ui/src/components/agent-chat-{message,prompt}.ts": ["files"],
  },
  workspaces: {
    ".": {
      entry: [
        "scripts/*.mjs",
        // Root tasks come from `test/tasks.ts`, which the vite-plus plugin cannot read.
        "test/package-metadata.mjs",
        "test/local/*.mjs",
        // The dev playground is part of the root package.
        ...matching("playground/vite", ["vite.config.ts", ...viteConfigEntries("playground/vite"), ...viteHubAppEntries])
          .map(pattern => `playground/vite/${pattern}`),
      ],
      ignoreDependencies: [
        // The lint task runs it with `vp exec`, which Knip does not read.
        "oxlint",
        // The Vercel output of the playground imports it, and the consumer tests run that output.
        "@vercel/blob",
        // Consumer tests resolve it from `packages/internal` with `createRequire`.
        "sharp",
        // Nothing imports it, but without it Knip reports `chat` as unlisted once `vite-hub` is built: the build copies
        // chat's types into its `.d.ts`, and Knip reads their `jsxImportSource: "chat"` example as an import.
        "chat",
      ],
      vitest: { config: ["vitest.config.ts", "test/consumer/vitest.config.ts", "test/output/vitest.config.ts"] },
    },
    ...packageWorkspaces,
    // Workflows run these binaries by path: `./.github/ci-tools/node_modules/.bin/<name>`.
    ".github/ci-tools": { ignoreDependencies: ["pkg-pr-new", "wrangler"] },
    docs: {
      entry: [
        // Markdown pages render these components by name.
        "app/components/content/**/*.vue",
        "app/examples/**/*.vue",
        "scripts/**/*.mjs",
        "test/**/*.test.ts",
        "test/browser/*.browser.mjs",
        // `modules/tutorials/snapshots.ts` runs it as a child process.
        "modules/tutorials/snapshot-worker.mjs",
      ],
      ignoreDependencies: [
        // Nuxt Icon loads icon sets by the prefix of an icon name, such as `i-lucide-x`.
        /^@iconify-json\//,
        // Code blocks of the docs import it, and `scripts/check-snippets.mjs` typechecks them.
        "@chat-adapter/slack",
        // nuxt-og-image of `@vite-hub/docs` renders the `*.takumi.vue` share images with it.
        "@takumi-rs/core",
        // Nuxt UI installs `@nuxt/icon` by name, and Nuxt resolves it from the app first, so this pins the copy that loads.
        "@nuxt/icon",
        // On Cloudflare, the MCP endpoint of `@nuxtjs/mcp-toolkit` imports `agents/mcp`.
        "agents",
      ],
      vitest: { config: ["vitest.config.ts", "vitest.artifact.config.ts"] },
    },
    // A type contract that `tsc` checks. Nothing imports it.
    "packages/env/examples/schema-lab": { entry: ["src/type-contract.ts"] },
    // These app configs import `vite-hub` from its build output, which Knip cannot load before a build.
    "playground/content": {
      entry: matching("playground/content", viteHubAppEntries),
      vite: false,
    },
    "playground/docs": {
      entry: matching("playground/docs", viteHubAppEntries),
      ignoreDependencies: [
        // Nuxt Icon loads icon sets by the prefix of an icon name, such as `i-lucide-x`.
        /^@iconify-json\//,
        // remove when #3644 and #3653 merge: they move this app to Nuxt 5 and rewrite these lines
        "@ai-sdk/vue",
        "@vite-hub/env",
        "@vite-hub/runtime",
        "@vite-hub/source",
        "h3",
        "vue-tsc",
      ],
    },
    "playground/logs": { entry: matching("playground/logs", viteHubAppEntries), vite: false },
  },
  ignoreWorkspaces: [
    // Consumer apps that tests copy and install on their own.
    "fixtures/tutorials/chat-app",
    "packages/codemods/examples/*",
  ],
};

export default config;
