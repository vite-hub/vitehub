import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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
async function startBuiltServer(instances: string): Promise<{ code: number | null; output: string; response?: Response }> {
  const port = await freePort();
  const server = spawn(process.execPath, [join(root, ".output/server/index.mjs")], {
    cwd: root,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), VITEHUB_INSTANCES: instances },
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
    plugins: [nitro() as never, vitehub({ preset: "node", kv: true })],
    root,
  });
  await builder.buildApp();
}, 120_000);

afterAll(async () => {
  if (root) await rm(root, { force: true, recursive: true, maxRetries: 3 });
});

it("fails at boot when 3 instances would split the fs-lite KV store", async () => {
  const result = await startBuiltServer("3");

  expect(result.response).toBeUndefined();
  expect(result.code).not.toBe(0);
  expect(result.output).toContain("VITEHUB_INSTANCES is 3, but these primitives keep their state in one process or on one host.");
  expect(result.output).toContain("  - kv: fs-lite (host). Files in .vitehub/data/kv on this host. Fix: Set REDIS_URL");
}, 30_000);

it("prints the durability table and serves with one instance", async () => {
  const result = await startBuiltServer("1");

  expect(result.response?.status).toBe(200);
  await expect(result.response?.json()).resolves.toEqual({ ok: true });
  expect(result.output).toContain("[vitehub] Durability (1 instance, from VITEHUB_INSTANCES):");
  expect(result.output).toMatch(/ {2}kv {2}fs-lite {2}host {2}Files in \.vitehub\/data\/kv on this host\./);
}, 30_000);
