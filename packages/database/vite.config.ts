import { defineConfig } from "vite-plus";

import { normalizePackageExports, packDefaults } from "@vite-hub/internal/package-exports";

// Generated code imports these modules by path. They are not public API.
const privateEntries = new Set([
  "./internal/schema-worker",
  "./runtime/agent",
  "./runtime/chunk-parameters",
  "./runtime/d1",
  "./runtime/default-database",
  "./runtime/default-database-postgresql",
  "./runtime/hosted",
  "./runtime/libsql",
  "./runtime/libsql-disabled",
  "./runtime/migrate-on-start",
  "./runtime/pglite",
  "./runtime/postgres",
  "./runtime/relations",
  "./runtime/use-database",
  "./runtime/virtual-databases",
  "./runtime/virtual-migrations",
  "./runtime/virtual-schema",
]);

export default defineConfig({
  pack: {
    ...packDefaults,
    copy: [
      { from: "src/drizzle-subpath.d.ts", rename: "drizzle-subpath.d.ts", to: "dist" },
      { from: "src/virtual-module.d.ts", rename: "virtual-module.d.ts", to: "dist" },
    ],
    deps: {
      alwaysBundle: [/^@vite-hub\/internal/],
      neverBundle: ["vite", "postgres", "@electric-sql/pglite", "#vitehub/database/schema", "#vitehub/database/databases", "#vitehub/database/definition-defaults", "#vitehub/database/definition-runtime", "#vitehub/database/libsql", "#vitehub/database/migrations"],
      onlyBundle: false,
    },
    plugins: [{
      name: "database-virtual-declarations",
      generateBundle(_options, bundle) {
        const chunk = bundle["virtual.d.ts"]
        if (chunk?.type === "chunk") {
          chunk.code = `/// <reference path="./virtual-module.d.ts" />\n${chunk.code}`
        }
      },
    }],
    entry: [
      "src/durability.ts",
      "src/index.ts",
      "src/cli.ts",
      "src/config.ts",
      "src/drizzle.ts",
      "src/nuxt.ts",
      "src/virtual.ts",
      "src/vite.ts",
      "src/connect.ts",
      "src/connect/node.ts",
      "src/internal/schema-worker.ts",
      "src/runtime/agent.ts",
      "src/runtime/chunk-parameters.ts",
      "src/runtime/d1.ts",
      "src/runtime/default-database.ts",
      "src/runtime/default-database-postgresql.ts",
      "src/runtime/definition-defaults.ts",
      "src/runtime/definition-hosted.ts",
      "src/runtime/definition-local.ts",
      "src/runtime/hosted.ts",
      "src/runtime/libsql.ts",
      "src/runtime/libsql-disabled.ts",
      "src/runtime/libsql-drizzle.ts",
      "src/runtime/migrate-on-start.ts",
      "src/runtime/pglite.ts",
      "src/runtime/postgres.ts",
      "src/runtime/postgres-connection.ts",
      "src/runtime/relations.ts",
      "src/runtime/request-stats.ts",
      "src/runtime/state.ts",
      "src/runtime/use-database.ts",
      "src/runtime/virtual-databases.ts",
      "src/runtime/virtual-migrations.ts",
      "src/runtime/virtual-schema.ts",
    ],
    exports: {
      customExports(exports) {
        return normalizePackageExports({
          ...Object.fromEntries(
            Object.entries(exports).filter(([key]) => !key.startsWith("./runtime/definition-") && !privateEntries.has(key)),
          ),
          "./virtual": {
            types: "./dist/virtual.d.ts",
            import: "./dist/virtual.js",
          },
          "./runtime/cloudflare-env": "./dist/runtime/state.js",
        });
      },
      inlinedDependencies: false,
    },
  },
});
