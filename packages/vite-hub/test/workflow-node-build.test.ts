import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createBuilder } from "vite";
import { expect, it } from "vitest";

import { vitehub } from "../src/index.ts";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  await new Promise<void>((done) => server.close(() => done()));
  if (!address || typeof address === "string") throw new TypeError("Expected a TCP address.");
  return address.port;
}

async function postToBuiltServer(root: string, path: string, body: unknown): Promise<Response> {
  const port = await freePort();
  const server = spawn(process.execPath, [join(root, ".output/server/index.mjs")], {
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port) },
    stdio: "ignore",
  });
  try {
    const deadline = Date.now() + 15_000;
    while (true) {
      try {
        return await fetch(`http://127.0.0.1:${port}${path}`, {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await new Promise((done) => setTimeout(done, 100));
      }
    }
  } finally {
    server.kill();
  }
}

it("runs a discovered Workflow from the built node server", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-workflow-node-build-"));
  try {
    await mkdir(join(root, "server/workflows/onboard-user"), { recursive: true });
    await mkdir(join(root, "server/api"), { recursive: true });
    await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir");
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }));
    await writeFile(
      join(root, "server/workflows/onboard-user/index.ts"),
      [
        `import { defineWorkflow } from "vite-hub/workflow"`,
        ``,
        `export default defineWorkflow<{ email: string }>(async ({ payload, steps }) => {`,
        `  return await steps.createUser(payload)`,
        `})`,
        ``,
      ].join("\n"),
    );
    await writeFile(
      join(root, "server/workflows/onboard-user/01.create-user.ts"),
      `export default async function createUser(input: { email: string }) {\n  return { id: \`user:\${input.email}\` }\n}\n`,
    );
    await writeFile(
      join(root, "server/api/onboard.post.ts"),
      [
        `import { defineEventHandler, readBody } from "h3"`,
        `import { getWorkflowRun, runWorkflow } from "vite-hub/workflow"`,
        ``,
        `export default defineEventHandler(async (event) => {`,
        `  const run = await runWorkflow("onboard-user", await readBody(event))`,
        `  let state = await getWorkflowRun("onboard-user", run.id)`,
        `  for (let attempt = 0; state.status !== "completed" && attempt < 50; attempt++) {`,
        `    await new Promise(done => setTimeout(done, 20))`,
        `    state = await getWorkflowRun("onboard-user", run.id)`,
        `  }`,
        `  const result = state.result instanceof Response ? await state.result.json() : state.result`,
        `  return { provider: run.provider, status: state.status, result }`,
        `})`,
        ``,
      ].join("\n"),
    );
    const { nitro } = (await import("nitro/vite" as string)) as { nitro: () => unknown };
    const builder = await createBuilder({
      logLevel: "silent",
      plugins: [nitro() as never, vitehub({ preset: "node", workflow: true })],
      root,
    });
    await builder.buildApp();

    const response = await postToBuiltServer(root, "/api/onboard", { email: "ada@example.com" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      provider: "vercel",
      status: "completed",
      result: { id: "user:ada@example.com" },
    });
  } finally {
    await rm(root, { force: true, recursive: true, maxRetries: 3 });
  }
}, 120_000);
