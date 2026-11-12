import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createBuilder } from "vite";
import { afterAll, beforeAll, expect, it } from "vitest";

import { vitehub } from "../src/index.ts";

let root: string;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  await new Promise<void>((done) => server.close(() => done()));
  if (!address || typeof address === "string") throw new TypeError("Expected a TCP address.");
  return address.port;
}

/** Starts the built server. Resolves with its output when it exits, or with the response of `/api/ping` when it serves. */
async function startBuiltServer(instances: string, env: Record<string, string> = {}, projectRoot = root): Promise<{ code: number | null; output: string; response?: Response }> {
  const port = await freePort();
  const server = spawn(process.execPath, [join(projectRoot, ".output/server/index.mjs")], {
    cwd: projectRoot,
    env: { ...process.env, ...env, HOST: "127.0.0.1", PORT: String(port), VITEHUB_INSTANCES: instances },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  server.stdout.on("data", (chunk: Buffer) => (output += chunk));
  server.stderr.on("data", (chunk: Buffer) => (output += chunk));
  let exited: number | null | undefined;
  const exit = new Promise<number | null>((done) => server.once("exit", (code) => done((exited = code))));
  try {
    const deadline = Date.now() + 15_000;
    while (exited === undefined) {
      try {
        return { code: null, output, response: await fetch(`http://127.0.0.1:${port}/api/ping`) };
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await new Promise((done) => setTimeout(done, 100));
      }
    }
    return { code: await exit, output };
  } finally {
    server.kill();
  }
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "vitehub-durability-node-build-"));
  await mkdir(join(root, "server/api"), { recursive: true });
  await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir");
  await writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }));
  await writeFile(join(root, "server/api/ping.get.ts"), `export default () => ({ ok: true })\n`);
  const { nitro } = (await import("nitro/vite" as string)) as { nitro: () => unknown };
  const builder = await createBuilder({
    logLevel: "silent",
    nitro: { prerender: { routes: ["/api/ping"], failOnError: true } },
    plugins: [nitro() as never, vitehub({ preset: "node", kv: true })],
    root,
  });
  const previousInstances = process.env.VITEHUB_INSTANCES;
  process.env.VITEHUB_INSTANCES = "3";
  try {
    await builder.buildApp();
  } finally {
    if (previousInstances === undefined) delete process.env.VITEHUB_INSTANCES;
    else process.env.VITEHUB_INSTANCES = previousInstances;
  }
}, 120_000);

afterAll(async () => {
  if (root) await rm(root, { force: true, recursive: true, maxRetries: 3 });
});

it("fails at boot when 3 instances would split the fs-lite KV store", async () => {
  const result = await startBuiltServer("3");

  expect(result.response).toBeUndefined();
  expect(result.code).not.toBe(0);
  expect(result.output).toContain("VITEHUB_INSTANCES is 3, but these primitives keep their state in one process or on one host.");
  expect(result.output).toContain('  - kv: fs-lite (host). Files in .vitehub/data/kv on this host. Fix: Set `kv: { driver: "redis" }`');
}, 30_000);

it("keeps a local store unsafe for 3 instances when REDIS_URL is supplied at boot", async () => {
  const result = await startBuiltServer("3", { REDIS_URL: "redis://127.0.0.1:1" });
  expect(result.response).toBeUndefined();
  expect(result.code).not.toBe(0);
  expect(result.output).toContain("kv: fs-lite (host)");
});

it("prerenders without deployment instance enforcement", async () => {
  expect(await readFile(join(root, ".output/public/api/ping"), "utf8")).toContain('"ok":true');
});

it("prints the durability table and serves with one instance", async () => {
  const result = await startBuiltServer("1");

  expect(result.response?.status).toBe(200);
  await expect(result.response?.json()).resolves.toEqual({ ok: true });
  expect(result.output).toContain("[vitehub] Durability (1 instance, from VITEHUB_INSTANCES):");
  expect(result.output).toMatch(/ {2}kv {2}fs-lite {2}host {2}Files in \.vitehub\/data\/kv on this host\./);
}, 30_000);

it("loads Definitions with deferred Nitro hooks before serving and enforces their stores", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "vitehub-durability-definitions-"));
  try {
    await mkdir(join(projectRoot, "server/api"), { recursive: true });
    await mkdir(join(projectRoot, "server/databases"), { recursive: true });
    await mkdir(join(projectRoot, "server/workspaces/docs"), { recursive: true });
    await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(projectRoot, "node_modules"), "dir");
    await writeFile(join(projectRoot, "package.json"), JSON.stringify({ private: true, type: "module" }));
    await writeFile(join(projectRoot, "server/api/ping.get.ts"), [
      'import { getDurabilityReport } from "vite-hub/runtime/durability"',
      'import { useWorkspaceFiles } from "@vite-hub/workspace/files"',
      'export default async () => {',
      '  const workspace = useWorkspaceFiles("docs", { mode: "write" })',
      '  await workspace.fs.writeFile("probe.txt", "ready")',
      '  return { ...getDurabilityReport(), content: await workspace.fs.readFile("probe.txt", "utf8") }',
      '}',
    ].join("\n"));
    await writeFile(join(projectRoot, "server/databases/default.ts"), `import { defineDatabase } from "@vite-hub/database"\nconst options = { connection: { url: "file:instance.db" }, schema: {} }\nexport default defineDatabase(options)\n`);
    await writeFile(join(projectRoot, "server/workspaces/docs/config.ts"), [
      'import { defineWorkspace } from "@vite-hub/workspace"',
      'import { useNitroApp } from "nitro/app"',
      'const options = {',
      '  store: { provider: "memory" },',
      '  hooks: { "write:error": ({ error }) => {',
      '    if (error instanceof Error) useNitroApp().captureError?.(error, { tags: ["workspace"] })',
      '  } },',
      '}',
      'export default defineWorkspace(options)',
    ].join("\n"));
    const { nitro } = (await import("nitro/vite" as string)) as { nitro: () => unknown };
    const builder = await createBuilder({
      logLevel: "silent",
      plugins: [nitro() as never, vitehub({
        preset: "node",
        database: { connection: { url: "libsql://shared.example?authToken=secret" } },
        kv: false,
        workspace: { assets: false, store: { provider: "github", repository: "acme/workspaces" } },
      })],
      root: projectRoot,
    });
    await builder.buildApp();
    const single = await startBuiltServer("1", {}, projectRoot);
    expect(single.response?.status, single.output).toBe(200);
    const report = await single.response?.json();
    expect(report).toMatchObject({ content: "ready", primitives: expect.arrayContaining([
      expect.objectContaining({ primitive: "database", store: "sqlite", scope: "host" }),
      expect.objectContaining({ primitive: "workspace", name: "docs", store: "memory", scope: "process" }),
    ]) });
    expect(JSON.stringify(report)).not.toContain("secret");
    const multiple = await startBuiltServer("3", {}, projectRoot);
    expect(multiple.response).toBeUndefined();
    expect(multiple.code).not.toBe(0);
    expect(multiple.output).toContain("database: sqlite (host)");
    expect(multiple.output).toContain("workspace (docs): memory (process)");
  } finally {
    await rm(projectRoot, { force: true, recursive: true, maxRetries: 3 });
  }
}, 120_000);
