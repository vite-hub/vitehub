import { defineConfig } from "vite-plus";

const outputConfig = "--config test/output/vitest.config.ts";

function providerOutputTask(provider: "cloudflare" | "vercel") {
  return {
    cache: false,
    command: `vp run playground:vite:build:local --provider ${provider} && vp test ${outputConfig} test/output/${provider}.test.ts`,
  } as const;
}

export default defineConfig({
  lint: {
    jsPlugins: ["./scripts/lint/comments.mjs"],
    rules: {
      "vitehub/no-comments": "error",
    },
  },
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
      "console:weight": {
        cache: false,
        command: "node scripts/console-weight/run.mjs",
      },
      "consumers:check": {
        cache: false,
        command: "node scripts/consumer-check.mjs",
      },
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
      "doctor:typescript": {
        cache: false,
        command:
          'node node_modules/vite-doctor/dist/cli.mjs . --since "${VITE_DOCTOR_SINCE:-origin/main}" --no-cache --max-warnings 0',
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
      "e2e:multi-instance": {
        cache: false,
        command: "node test/multi-instance/run.mjs",
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
        command: "vp lint . --ignore-path .gitignore",
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
      "package:metadata": {
        cache: false,
        command: "node test/package-metadata.mjs",
        dependsOn: ["build"],
      },
      test: {
        cache: false,
        command: "node test/run-package-task.mjs test",
      },
      "test:contracts": {
        cache: false,
        command: "vp test --config vitest.config.ts",
        dependsOn: ["build"],
      },
      "test:consumer": {
        cache: false,
        command: "vp test --config test/consumer/vitest.config.ts",
        dependsOn: ["build"],
      },
      "test:output:cloudflare": providerOutputTask("cloudflare"),
      "test:output:vercel": providerOutputTask("vercel"),
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
