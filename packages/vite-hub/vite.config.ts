import { readdirSync } from "node:fs";
import { resolve } from "node:path";

import { defineConfig } from "vite-plus";
import * as v from "valibot";

import frameworkPackageManifest from "./package.json" with { type: "json" };

const manifestStringLeavesSchema: v.GenericSchema<unknown, string[]> = v.lazy(() =>
  v.union([
    v.pipe(
      v.string(),
      v.transform((value) => [value]),
    ),
    v.pipe(
      v.array(manifestStringLeavesSchema),
      v.transform((values) => values.flat()),
    ),
    v.pipe(
      v.record(v.string(), manifestStringLeavesSchema),
      v.transform((value) => Object.values(value).flat()),
    ),
  ]),
);

export function distributionEntriesFromManifest(value: unknown): string[] {
  return [
    ...new Set(
      v
        .parse(manifestStringLeavesSchema, value)
        .filter((target) => target.startsWith("./dist/") && target.endsWith(".js"))
        .map((target) => target.replace(/^\.\/dist\//, "src/").replace(/\.js$/, ".ts")),
    ),
  ].sort();
}

export const distributionBinEntries = Object.fromEntries(
  Object.entries(frameworkPackageManifest.bin).map(([name, target]) => {
    const [entry] = distributionEntriesFromManifest(target);
    if (!entry) throw new TypeError(`Unsupported ViteHub binary target: ${target}`);
    return [name, entry];
  }),
);

const distributionEntries = [
  ...distributionEntriesFromManifest([
    frameworkPackageManifest.exports,
    frameworkPackageManifest.bin,
  ]),
  "src/console/runtime/client/sections.ts",
].sort();

const consoleAssetRoot = resolve(import.meta.dirname, ".vitehub/console");

function consoleAsset(extension: ".css" | ".js"): string {
  const matches = readdirSync(consoleAssetRoot)
    .filter(file => file.startsWith("console-") && file.endsWith(extension));
  if (matches.length !== 1) {
    throw new TypeError(`Expected one hashed Console ${extension} asset, found ${matches.length}.`);
  }
  return matches[0]!;
}

export default defineConfig({
  pack: {
    tsconfig: "tsconfig.build.json",
    copy: [
      { from: "src/cloudflare-prerender.mjs", to: "dist" },
      { from: ".vitehub/console", to: "dist/console/runtime/public" },
      {
        from: "src/console/runtime/components/console-brand.vue",
        to: "dist/console/runtime/components",
      },
      {
        from: "src/console/runtime/components/console-app.vue",
        to: "dist/console/runtime/components",
      },
      {
        from: "src/console/runtime/components/console-session-bootstrap.ts",
        to: "dist/console/runtime/components",
      },
      {
        from: "src/console/runtime/components/console-blob.vue",
        to: "dist/console/runtime/components",
      },
      {
        from: "src/console/runtime/components/console-database-model.ts",
        to: "dist/console/runtime/components",
      },
      {
        from: "src/console/runtime/components/console-database.vue",
        to: "dist/console/runtime/components",
      },
      {
        from: "src/console/runtime/components/console-definitions.vue",
        to: "dist/console/runtime/components",
      },
      {
        from: "src/console/runtime/components/console-frame.vue",
        to: "dist/console/runtime/components",
      },
      {
        from: "src/console/runtime/components/console-health-model.ts",
        to: "dist/console/runtime/components",
      },
      {
        from: "src/console/runtime/components/console-health.vue",
        to: "dist/console/runtime/components",
      },
      {
        from: "src/console/runtime/components/console-home.vue",
        to: "dist/console/runtime/components",
      },
      {
        from: "src/console/runtime/components/console-kv.vue",
        to: "dist/console/runtime/components",
      },
      {
        from: "src/console/runtime/components/console-mark.vue",
        to: "dist/console/runtime/components",
      },
      {
        from: "src/console/runtime/components/console-provider.vue",
        to: "dist/console/runtime/components",
      },
      {
        from: "src/console/runtime/components/console-primitive-switcher.vue",
        to: "dist/console/runtime/components",
      },
      {
        from: "src/console/runtime/components/console-search.vue",
        to: "dist/console/runtime/components",
      },
      {
        from: "src/console/runtime/components/console-session-code-preview.vue",
        to: "dist/console/runtime/components",
      },
      {
        from: "src/console/runtime/components/console-session-inspector.vue",
        to: "dist/console/runtime/components",
      },
      {
        from: "src/console/runtime/components/console-session-loading.vue",
        to: "dist/console/runtime/components",
      },
      {
        from: "src/console/runtime/components/console-session-navbar.vue",
        to: "dist/console/runtime/components",
      },
      {
        from: "src/console/runtime/components/console-session-trace-model.ts",
        to: "dist/console/runtime/components",
      },
      {
        from: "src/console/runtime/components/console-session-trace.vue",
        to: "dist/console/runtime/components",
      },
      {
        from: "src/console/runtime/components/console-session.css",
        to: "dist/console/runtime/components",
      },
      {
        from: "src/console/runtime/components/console-usage.vue",
        to: "dist/console/runtime/components",
      },
      { from: "src/console/runtime/pages/agents.vue", to: "dist/console/runtime/pages" },
      { from: "src/console/runtime/pages/blob.vue", to: "dist/console/runtime/pages" },
      { from: "src/console/runtime/pages/databases.vue", to: "dist/console/runtime/pages" },
      { from: "src/console/runtime/pages/index.vue", to: "dist/console/runtime/pages" },
      { from: "src/console/runtime/pages/kv.vue", to: "dist/console/runtime/pages" },
      { from: "src/console/runtime/pages/queues.vue", to: "dist/console/runtime/pages" },
      { from: "src/console/runtime/pages/rate-limits.vue", to: "dist/console/runtime/pages" },
      { from: "src/console/runtime/pages/schedules.vue", to: "dist/console/runtime/pages" },
      { from: "src/console/runtime/pages/sandboxes.vue", to: "dist/console/runtime/pages" },
      { from: "src/console/runtime/pages/workflows.vue", to: "dist/console/runtime/pages" },
      { from: "src/console/runtime/pages/workspaces.vue", to: "dist/console/runtime/pages" },
      { from: "../ui/styles.css", to: "dist/ui" },
      { from: "templates/cloudflare-types.d.ts", to: "dist" },
    ],
    deps: {
      neverBundle: ["esbuild", "vite", /^@vite-hub\/(?!internal(?:\/|$))/],
      alwaysBundle: [/^@vite-hub\/internal/],
      onlyBundle: false,
    },
    plugins: [
      {
        name: "vite-hub-console-assets",
        generateBundle(_options, bundle) {
          const page = Object.values(bundle).find(output =>
            output.type === "chunk"
            && output.facadeModuleId?.replaceAll("\\", "/").endsWith("/src/console/runtime/server/page.get.ts")
          );
          if (!page || page.type !== "chunk") {
            throw new TypeError("Expected the standalone Console page in the package bundle.");
          }
          page.code = page.code
            .replaceAll("__VITEHUB_CONSOLE_STYLE_ASSET__", consoleAsset(".css"))
            .replaceAll("__VITEHUB_CONSOLE_SCRIPT_ASSET__", consoleAsset(".js"));
        },
      },
      {
        name: "vite-hub-env-config-declarations",
        generateBundle(_options, bundle) {
          for (const file of ["index.d.ts", "env.d.ts"]) {
            const chunk = bundle[file];
            if (chunk?.type === "chunk") chunk.code = `import "@vite-hub/env/vite";\n${chunk.code}`;
          }
        },
      },
    ],
    entry: [
      ...distributionEntries,
      "src/console/runtime/console-route.ts",
      "src/console/runtime/client/request.ts",
      "src/console/runtime/client/time.ts",
      "src/console/runtime/definitions.ts",
      "src/console/runtime/sections.ts",
      "src/console/runtime/server/agents.get.ts",
      "src/console/runtime/server/blob.get.ts",
      "src/console/runtime/server/database.get.ts",
      "src/console/runtime/server/definitions.get.ts",
      "src/console/runtime/server/invocation.get.ts",
      "src/console/runtime/server/invocations.get.ts",
      "src/console/runtime/server/kv.get.ts",
      "src/console/runtime/server/page.get.ts",
      "src/console/runtime/server/search.get.ts",
      "src/console/runtime/server/sections.get.ts",
      "src/console/runtime/server/usage.get.ts",
    ],
    exports: {
      exclude: ["bin"],
      bin: distributionBinEntries,
      customExports(exports) {
        delete exports["./console/runtime/console-route"];
        delete exports["./console/runtime/client/sections"];
        delete exports["./console/runtime/client/request"];
        delete exports["./console/runtime/client/time"];
        delete exports["./console/runtime/definitions"];
        delete exports["./console/runtime/sections"];
        delete exports["./console/runtime/server/agents.get"];
        delete exports["./console/runtime/server/blob"];
        delete exports["./console/runtime/server/blob.get"];
        delete exports["./console/runtime/server/database"];
        delete exports["./console/runtime/server/database.get"];
        delete exports["./console/runtime/server/definitions"];
        delete exports["./console/runtime/server/definitions.get"];
        delete exports["./console/runtime/server/invocation.get"];
        delete exports["./console/runtime/server/invocations.get"];
        delete exports["./console/runtime/server/kv.get"];
        delete exports["./console/runtime/server/kv"];
        delete exports["./console/runtime/server/page.get"];
        delete exports["./console/runtime/server/search.get"];
        delete exports["./console/runtime/server/sections.get"];
        delete exports["./console/runtime/server/sections"];
        delete exports["./console/runtime/server/usage.get"];
        return {
          ...exports,
          "./console/blob": "./dist/console/runtime/server/blob.js",
          "./console/database": "./dist/console/runtime/server/database.js",
          "./console/definitions": "./dist/console/runtime/server/definitions.js",
          "./console/kv": "./dist/console/runtime/server/kv.js",
          "./console/sections": "./dist/console/runtime/server/sections.js",
          "./ui/styles.css": "./dist/ui/styles.css",
          "./tsconfig": "./tsconfig.json",
        };
      },
      inlinedDependencies: false,
    },
    outExtensions: () => ({
      dts: ".d.ts",
      js: ".js",
    }),
    publint: true,
  },
});
