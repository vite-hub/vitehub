import { defineConfig } from "vite-plus";

import { rootTestTasks } from "./test/tasks.ts";

export default defineConfig({
  run: {
    tasks: {
      "blob:e2e": {
        cache: false,
        command: "node packages/blob/test/e2e.mjs",
        dependsOn: ["@vite-hub/blob#build"],
      },
      "console:dev": {
        cache: false,
        command: "vp dev --config playground/console/vite.config.ts",
      },
      // Searches your own projects for the public API that this branch removes. Local only: CI has no consumer checkouts.
      "consumers:check": {
        cache: false,
        command: "node scripts/consumer-check.mjs",
      },
      // Builds packages in dependency order and caches each package build by
      // the files it reads. An outer --no-cache does not reach this nested run,
      // so release and preview publishing run the filter with --no-cache.
      build: {
        cache: false,
        command: 'vp run --cache --filter "./packages/*" build',
      },
      "codemods:e2e": {
        cache: false,
        command: "node packages/codemods/test/e2e.mjs",
        dependsOn: ["vite-hub#build", "@vite-hub/codemods#build"],
      },
      "database:e2e": {
        cache: false,
        command: "node packages/database/test/e2e.mjs",
        dependsOn: ["@vite-hub/database#build"],
      },
      // Keeps only the rules that catch unsound type evidence. It checks the
      // lines changed since VITE_DOCTOR_SINCE, so it needs no baseline.
      "doctor:typescript": {
        cache: false,
        command:
          'node node_modules/vite-doctor/dist/cli.mjs . --extends vite-doctor/typescript/strict --rules typescript/boundaries/no-unvalidated-deserialization,typescript/evidence/no-caller-chosen-result-type,typescript/evidence/no-chained-type-assertions,typescript/evidence/no-widen-then-assert --since "${VITE_DOCTOR_SINCE:-HEAD^}" --no-cache --max-warnings 0',
      },
      "docs:build": {
        cache: false,
        command: "vp run --filter vitehub-docs build",
      },
      "e2e:local": {
        cache: false,
        command: "node test/local/local.mjs",
      },
      "e2e:netlify": {
        cache: false,
        command: "node test/local/netlify-real-project.mjs",
        dependsOn: ["build"],
      },
      "e2e:deno": {
        cache: false,
        command: "node test/local/deno-real-project.mjs",
        dependsOn: ["build"],
      },
      "e2e:deno:live": {
        cache: false,
        command: "node test/local/deno-real-project.mjs --live",
        dependsOn: ["build"],
      },
      "knip:catalog": {
        cache: false,
        command:
          "vp run -t @vite-hub/sandbox#build && vp run -t @vite-hub/queue#build && vp exec knip --include catalog --no-progress --reporter compact",
      },
      "kv:e2e": {
        cache: false,
        command: "node packages/kv/test/e2e.mjs",
        dependsOn: ["@vite-hub/kv#build"],
      },
      lint: {
        cache: false,
        command: "vp exec oxlint . --ignore-path .gitignore",
      },
      "playground:vite:build": {
        cache: false,
        command: "cd playground/vite && vp build",
        dependsOn: ["build"],
      },
      "playground:vite:build:local": {
        cache: false,
        command: "node test/local/build-playground.mjs",
        dependsOn: ["build"],
      },
      "playground:vite:provision": {
        cache: false,
        command: "cd playground/vite && node ../../packages/vite-hub/dist/bin.js provision run",
        dependsOn: ["vite-hub#build"],
      },
      preflight: {
        cache: false,
        command: "node test/preflight.mjs",
      },
      "queue:e2e": {
        cache: false,
        command: "node packages/queue/test/e2e-live.mjs",
        dependsOn: ["@vite-hub/queue#build"],
      },
      "rate-limit:e2e": {
        cache: false,
        command: "node packages/rate-limit/test/e2e.mjs",
        dependsOn: ["@vite-hub/rate-limit#build"],
      },
      "sandbox-task:e2e": {
        cache: false,
        command: "node packages/sandbox/test/task/e2e.mjs",
        dependsOn: ["@vite-hub/sandbox#build"],
      },
      "schedule:e2e": {
        cache: false,
        command: "node packages/schedule/test/e2e-live.mjs",
        dependsOn: ["@vite-hub/schedule#build"],
      },
      ...rootTestTasks,
      // Needs Postgres and Redis. Set VITEHUB_TEST_POSTGRES_URL and VITEHUB_TEST_REDIS_URL.
      "test:services": {
        cache: false,
        command: "node test/service-tests.mjs",
      },
      typecheck: {
        cache: false,
        command: "node test/typecheck.mjs",
      },
      verify: {
        cache: false,
        command:
          "vp run preflight && vp run knip:catalog && vp run lint && vp run doctor:typescript && vp run typecheck && vp run test:contracts && vp run package:metadata && vp run test && vp run test:consumer",
      },
      "workflow:e2e": {
        cache: false,
        command: "node packages/workflow/test/e2e-live.mjs",
        dependsOn: ["@vite-hub/workflow#build"],
      },
      "workspace:e2e": {
        cache: false,
        command: "node packages/workspace/test/e2e.mjs",
        dependsOn: ["@vite-hub/workspace#build"],
      },
    },
  },
});
