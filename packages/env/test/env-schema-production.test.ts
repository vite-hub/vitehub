import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { build } from "vite";
import { afterEach, expect, it, vi } from "vitest";

const labRoot = fileURLToPath(new URL("../examples/schema-lab/", import.meta.url));
const compiler = fileURLToPath(
  new URL("../../../node_modules/typescript/bin/tsc", import.meta.url),
);
const execute = promisify(execFile);
const contractKeys = [
  "VITEHUB_PUBLIC_APP_NAME",
  "VITEHUB_PUBLIC_PLAN",
  "VITEHUB_PUBLIC_NOTICE",
  "VITEHUB_RETRIES",
  "VITEHUB_DRY_RUN",
  "VITEHUB_MODE",
  "VITEHUB_SERVICE_URL",
  "VITEHUB_TIMEOUT",
  "VITEHUB_LABEL",
  "VITEHUB_API_TOKEN",
  "VITEHUB_ROLES",
  "VITEHUB_SETTINGS",
  "VITEHUB_METADATA",
  "VITEHUB_PUBLIC_TAGS",
];
const firstToken = "schema-lab-synthetic-runtime-token-first";
const secondToken = "schema-lab-synthetic-runtime-token-second";
const documentationExample = "schema-lab-documentation-example-only";

afterEach(() => vi.unstubAllEnvs());

function runtimeEnvironment(overrides: NodeJS.ProcessEnv = {}) {
  const environment = { ...process.env };
  for (const key of contractKeys) delete environment[key];
  return { ...environment, ENV_SCHEMA_LAB_PORT: "0", ...overrides };
}

async function outputFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? outputFiles(path) : [path];
    }),
  );
  return files.flat().sort();
}

async function outputSnapshot() {
  const files = [
    ...(await outputFiles(join(labRoot, "dist"))),
    ...(await outputFiles(join(labRoot, ".vitehub"))),
  ];
  const content = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
  return { hash: createHash("sha256").update(content).digest("hex"), content };
}

function expectPrivateValuesAbsent(content: string) {
  for (const value of [firstToken, secondToken, documentationExample])
    expect(content).not.toContain(value);
}

async function requestProductionConfig(environment: NodeJS.ProcessEnv): Promise<unknown> {
  const child = spawn(process.execPath, ["dist/server/server.js"], {
    cwd: labRoot,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let resolveReady: (url: string) => void = () => {};
  let rejectReady: (error: Error) => void = () => {};
  const ready = new Promise<string>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => {
      rejectReady(new Error(`Production server exited before listening: ${output}`));
      resolve();
    }),
  );
  const collect = (chunk: Buffer) => {
    output += chunk.toString();
    const url = /ENV_SCHEMA_LAB_LISTENING (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1];
    if (url) resolveReady(url);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  child.once("error", rejectReady);
  const timeout = setTimeout(
    () => rejectReady(new Error("Production server did not listen within 10 seconds")),
    10_000,
  );
  try {
    const url = await ready;
    const page = await fetch(url);
    expect(page.status).toBe(200);
    const html = await page.text();
    expectPrivateValuesAbsent(html);
    const script = /src="([^"]+\.js)"/.exec(html)?.[1];
    expect(script).toBeTruthy();
    const clientResponse = await fetch(new URL(script ?? "", url));
    expect(clientResponse.status).toBe(200);
    const client = await clientResponse.text();
    expect(client).toContain("Built application");
    expect(client).not.toContain("apiToken");
    expectPrivateValuesAbsent(client);
    const response = await fetch(`${url}/api/config`);
    expect(response.status).toBe(200);
    const body = await response.text();
    expectPrivateValuesAbsent(body);
    return JSON.parse(body);
  } finally {
    clearTimeout(timeout);
    child.kill("SIGTERM");
    const killTimeout = setTimeout(() => child.kill("SIGKILL"), 2000);
    await closed;
    clearTimeout(killTimeout);
    expectPrivateValuesAbsent(output);
  }
}

async function expectStartupFailure(environment: NodeJS.ProcessEnv, key: string) {
  let failed = false;
  try {
    await execute(process.execPath, ["dist/server/server.js"], {
      cwd: labRoot,
      env: environment,
      timeout: 10_000,
    });
  } catch (error) {
    failed = true;
    expect(error).toHaveProperty("code", 1);
    if (!(error instanceof Error) || !("stdout" in error) || !("stderr" in error)) throw error;
    const output = `${error.stdout}\n${error.stderr}`;
    expect(output).toContain(key);
    expect(output).not.toContain("ENV_SCHEMA_LAB_LISTENING");
    expectPrivateValuesAbsent(output);
  }
  expect(failed).toBe(true);
}

it("prepares and builds without server credentials, then validates each production process", async () => {
  for (const key of contractKeys) vi.stubEnv(key, undefined);
  await execute(process.execPath, ["prepare.mjs"], { cwd: labRoot, env: runtimeEnvironment() });
  await execute(process.execPath, [compiler, "--noEmit", "-p", "tsconfig.json"], {
    cwd: labRoot,
    env: runtimeEnvironment(),
  });

  vi.stubEnv("VITEHUB_PUBLIC_APP_NAME", "Built application");
  vi.stubEnv("VITEHUB_PUBLIC_PLAN", "team");
  await build({
    root: labRoot,
    configFile: join(labRoot, "vite.config.ts"),
    mode: "client",
    logLevel: "silent",
  });
  await build({ root: labRoot, configFile: join(labRoot, "vite.config.ts"), logLevel: "silent" });
  await execute(process.execPath, [compiler, "--noEmit", "-p", "tsconfig.json"], {
    cwd: labRoot,
    env: runtimeEnvironment(),
  });
  const built = await outputSnapshot();
  expectPrivateValuesAbsent(built.content);

  const first = await requestProductionConfig(
    runtimeEnvironment({
      VITEHUB_API_TOKEN: firstToken,
      VITEHUB_RETRIES: "3",
      VITEHUB_DRY_RUN: "true",
      VITEHUB_MODE: "send",
      VITEHUB_SERVICE_URL: "https://first.example.test",
      VITEHUB_TIMEOUT: "",
      VITEHUB_LABEL: "",
      VITEHUB_ROLES: '["read","write"]',
      VITEHUB_SETTINGS: '{"enabled":true,"retries":3,"tags":["one"]}',
      VITEHUB_METADATA: '{"nested":[1,true,null]}',
    }),
  );
  expect(first).toEqual({
    public: { appName: "Built application", plan: "team", tags: ["docs"] },
    runtime: {
      retries: 3,
      dryRun: true,
      mode: "send",
      serviceUrl: "https://first.example.test",
      timeout: 5,
      label: "",
      roles: ["read", "write"],
      settings: { enabled: true, retries: 3, tags: ["one"] },
      metadata: { nested: [1, true, null] },
    },
    tokenConfigured: true,
    tokenRedacted: "<redacted>",
  });
  const second = await requestProductionConfig(
    runtimeEnvironment({
      VITEHUB_API_TOKEN: secondToken,
      VITEHUB_RETRIES: "4",
      VITEHUB_DRY_RUN: "false",
      VITEHUB_MODE: "draft",
      VITEHUB_SERVICE_URL: "https://second.example.test",
      VITEHUB_TIMEOUT: "9",
      VITEHUB_LABEL: "restart",
      VITEHUB_PUBLIC_APP_NAME: "Runtime change must not replace build value",
      VITEHUB_PUBLIC_PLAN: "free",
    }),
  );
  expect(second).toEqual({
    public: { appName: "Built application", plan: "team", tags: ["docs"] },
    runtime: {
      retries: 4,
      dryRun: false,
      mode: "draft",
      serviceUrl: "https://second.example.test",
      timeout: 9,
      label: "restart",
      roles: ["read"],
      settings: { enabled: false, retries: 2, tags: [] },
    },
    tokenConfigured: true,
    tokenRedacted: "<redacted>",
  });

  await expectStartupFailure(runtimeEnvironment(), "env.server.apiToken");
  for (const [key, value, path] of [
    ["VITEHUB_API_TOKEN", "", "apiToken"],
    ["VITEHUB_ROLES", '["admin"]', "roles"],
    ["VITEHUB_ROLES", "[", "roles"],
    ["VITEHUB_SETTINGS", '{"enabled":"true","retries":2,"tags":[]}', "settings"],
    ["VITEHUB_SETTINGS", '{"enabled":true}', "settings"],
    ["VITEHUB_METADATA", '{"__proto__":{"polluted":true}}', "metadata"],
    ["VITEHUB_RETRIES", "", "retries"],
    ["VITEHUB_RETRIES", "0xff", "retries"],
    ["VITEHUB_RETRIES", "11", "retries"],
    ["VITEHUB_DRY_RUN", "sometimes", "dryRun"],
    ["VITEHUB_MODE", "unknown", "mode"],
    ["VITEHUB_SERVICE_URL", "/relative", "serviceUrl"],
    ["VITEHUB_TIMEOUT", "0", "timeout"],
  ]) {
    await expectStartupFailure(
      runtimeEnvironment({ VITEHUB_API_TOKEN: firstToken, [key]: value }),
      `env.server.${path}`,
    );
  }
  const restarted = await outputSnapshot();
  expect(restarted.hash).toBe(built.hash);
  expectPrivateValuesAbsent(restarted.content);
}, 90_000);
