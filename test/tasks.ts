const outputConfig = "--config test/output/vitest.config.ts";

function providerOutputTask(provider: "cloudflare" | "vercel") {
  return {
    cache: false,
    command: `vp run playground:vite:build:local --provider ${provider} && vp test ${outputConfig} test/output/${provider}.test.ts`,
  };
}

export const rootTestTasks = Object.freeze({
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
  "test:output": {
    cache: false,
    command: "vp run test:output:cloudflare && vp run test:output:vercel",
  },
  "test:output:cloudflare": providerOutputTask("cloudflare"),
  "test:output:vercel": providerOutputTask("vercel"),
});
