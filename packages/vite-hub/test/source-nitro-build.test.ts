import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createBuilder, resolveConfig } from "vite";
import type { Plugin } from "vite";
import { VITEHUB_PROJECT_ROOT, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite";
import { describe, expect, it } from "vitest";

import { vitehub } from "../src/index.ts";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  await new Promise<void>((done) => server.close(() => done()));
  if (!address || typeof address === "string") throw new TypeError("Expected a TCP address.");
  return address.port;
}

async function fetchBuiltServer(root: string, path: string): Promise<Response> {
  const port = await freePort();
  const server = spawn(process.execPath, [join(root, ".output/server/index.mjs")], {
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port) },
    stdio: "ignore",
  });
  try {
    const deadline = Date.now() + 15_000;
    while (true) {
      try {
        return await fetch(`http://127.0.0.1:${port}${path}`);
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await new Promise((done) => setTimeout(done, 100));
      }
    }
  } finally {
    server.kill();
  }
}

describe("Source Collections through the Nitro Vite plugin", () => {
  it("uses the final client base supplied by a later config hook", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-source-base-"));
    try {
      await writeFile(join(root, "package.json"), JSON.stringify({ private: true }));
      const resolved = await resolveConfig(
        {
          configFile: false,
          root,
          plugins: [
            vitehub({ preset: "node" }),
            {
              name: "collection-client-base",
              enforce: "post",
              config: { order: "post", handler: () => ({ base: "/portal/" }) },
            },
          ],
        },
        "build",
      );
      expect(resolved.define?.__VITEHUB_APP_BASE_URL__).toBe(JSON.stringify("/portal/"));
      expect(resolved.environments.client?.define?.__VITEHUB_APP_BASE_URL__).toBe(JSON.stringify("/portal/"));
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it.each([
    { nitroPosition: "before", contributedConfig: false, conflictingRoute: false },
    { nitroPosition: "after", contributedConfig: false, conflictingRoute: false },
    { nitroPosition: "before", contributedConfig: true, conflictingRoute: false },
    { nitroPosition: "after", contributedConfig: true, conflictingRoute: false },
    { nitroPosition: "before", contributedConfig: false, conflictingRoute: true },
  ] as const)(
    "serves a generated Collection route with %j",
    async ({ nitroPosition, contributedConfig, conflictingRoute }) => {
      const root = await mkdtemp(join(tmpdir(), "vitehub-source-nitro-build-"));
      try {
        const serverDir = contributedConfig ? "backend" : "server";
        await mkdir(join(root, serverDir, "collections"), { recursive: true });
        await symlink(
          resolve(import.meta.dirname, "../../../node_modules"),
          join(root, "node_modules"),
          "dir",
        );
        await writeFile(
          join(root, "package.json"),
          JSON.stringify({ private: true, type: "module" }),
        );
        await writeFile(join(root, "index.html"), "<main>ok</main>\n");
        await writeFile(
          join(root, serverDir, "collections", "articles.ts"),
          [
            `import * as v from "valibot"`,
            `import { defineCollection } from "vite-hub/source"`,
            ``,
            `export const articles = defineCollection(async () => [{ id: "a", title: "A" }], {`,
            `  cursor: article => article.id,`,
            `  cursorSchema: v.string(),`,
            `})`,
            ``,
          ].join("\n"),
        );
        if (conflictingRoute) {
          await mkdir(join(root, "server/routes/api"), { recursive: true });
          await writeFile(
            join(root, "server/routes/api/articles.get.ts"),
            "export default () => []\n",
          );
        }
        const { nitro } = (await import("nitro/vite" as string)) as { nitro: () => unknown };
        const plugins =
          nitroPosition === "before"
            ? [nitro() as never, vitehub({ preset: "node" })]
            : [vitehub({ preset: "node" }), nitro() as never];
        const configuration: Plugin = {
          name: "collection-host-configuration",
          config() {
            return {
              root,
              [VITEHUB_PROJECT_ROOT]: root,
              [VITEHUB_SERVER_DIRS]: [serverDir],
            };
          },
        };
        const buildConfig = {
          logLevel: "silent" as const,
          ...(conflictingRoute ? { nitro: { serverDir: join(root, "server") } } : {}),
          plugins: [...(contributedConfig ? [configuration] : []), ...plugins],
          root: contributedConfig ? import.meta.dirname : root,
        };
        if (conflictingRoute) {
          await expect(createBuilder(buildConfig)).rejects.toThrow(
            'Generated Collection route "/api/articles" conflicts',
          );
          return;
        }
        const builder = await createBuilder(buildConfig);
        await builder.buildApp();

        const response = await fetchBuiltServer(root, "/api/articles");

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("application/json");
        await expect(response.json()).resolves.toMatchObject({ items: [{ id: "a", title: "A" }] });
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    },
    120_000,
  );
});
