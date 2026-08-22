import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    tasks: {
      "blob:e2e": {
        cache: false,
        command: "node packages/blob/test/e2e.mjs",
        dependsOn: ["@vite-hub/blob#build"],
      },
      build: {
        cache: false,
        command: "node test/run-package-task.mjs build",
      },
      "database:e2e": {
        cache: false,
        command: "node packages/database/test/e2e.mjs",
        dependsOn: ["@vite-hub/database#build"],
      },
      "doctor:typescript": {
        cache: false,
        command:
          'vp exec vite-doctor scan . --extends vite-doctor/typescript/strict --since "${VITE_DOCTOR_SINCE:-HEAD^}" --no-cache --max-warnings 0',
      },
      "docs:build": {
        cache: false,
        command: "vp run --filter vitehub-docs build",
      },
      "docs:dev": {
        cache: false,
        command: "vp run --filter vitehub-docs dev",
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
      "fallow:dead-code": {
        cache: false,
        command:
          "vp exec fallow dead-code --baseline .fallow-baseline.json --summary --format markdown --fail-on-issues",
      },
      "knip:catalog": {
        cache: false,
        command: "vp exec knip --include catalog --no-progress --reporter compact",
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
      "playground:vite:build:cloudflare": {
        cache: false,
        command: "vp run playground:vite:build --mode chat",
      },
      "playground:vite:build:local": {
        cache: false,
        command: "node test/local/build-playground.mjs",
        dependsOn: ["build"],
      },
      "playground:vite:provision": {
        cache: false,
        command: "cd playground/vite && node ../../packages/cli/dist/index.js provision run",
        dependsOn: ["@vite-hub/cli#build"],
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
      release: {
        cache: false,
        command:
          'vp dlx bumpp@11.1.0 package.json packages/*/package.json --commit "chore(release): v%s" --tag "v%s" --push --no-push-all --git-check',
      },
      "sandbox:e2e": {
        cache: false,
        command: "node packages/sandbox/test/e2e.mjs",
        dependsOn: ["@vite-hub/sandbox#build"],
      },
      "schedule:e2e": {
        cache: false,
        command: "node packages/schedule/test/e2e-live.mjs",
        dependsOn: ["@vite-hub/schedule#build"],
      },
      test: {
        cache: false,
        command: "node test/run-package-task.mjs test",
      },
      "test:contracts": {
        cache: false,
        command: "vp test",
      },
      "test:consumer": {
        cache: false,
        command:
          "VITEHUB_CONSUMER_CONTRACT=1 vp test test/consumer/vite-hub.test.ts test/consumer/source-closures.test.ts",
        dependsOn: ["build"],
      },
      "test:output": {
        cache: false,
        command: "vp test --config test/output/vitest.config.ts",
      },
      "test:output:cloudflare": {
        cache: false,
        command: "vp test --config test/output/vitest.config.ts test/output/cloudflare.test.ts",
      },
      "test:output:vercel": {
        cache: false,
        command: "vp test --config test/output/vitest.config.ts test/output/vercel.test.ts",
      },
      typecheck: {
        cache: false,
        command:
          "vp run build && vp run --filter vitehub-docs --ignore-depends-on typecheck && node test/run-package-task.mjs typecheck",
      },
      verify: {
        cache: false,
        command:
          "vp run fallow:dead-code && vp run knip:catalog && vp run lint && vp run doctor:typescript && vp run typecheck && vp run test:contracts && vp run test && vp run test:consumer",
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
