import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Miniflare } from "miniflare";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import * as v from "valibot";
import { expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const sourceModule = async (path: string) => ({
  type: "ESModule" as const,
  path: resolve(root, path),
  contents: transpileModule(await readFile(resolve(root, path), "utf8"), {
    compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2023 },
  }).outputText,
});

it("paginates Console usage in Cloudflare without Node compatibility", async () => {
  // Load the real usage module and its dependencies without bundling or Node shims.
  const worker = new Miniflare({
    compatibilityDate: "2026-04-20",
    compatibilityFlags: [],
    modulesRoot: root,
    modules: [
      {
        type: "ESModule",
        path: resolve(root, "worker.mjs"),
        contents: `
          import { usageCursor, usageQueryWindow } from "./src/console/runtime/server/usage.ts";
          export default {
            async fetch(request) {
              const query = await request.json();
              const to = "2026-09-05T12:00:00.000Z";
              const last = { at: to, id: "雪🌍%41" };
              const cursor = query.cursor ?? usageCursor(query, to, last);
              const page = usageQueryWindow({ ...query, cursor });
              return Response.json({ cursor, after: page.after, to: page.to, buffer: typeof Buffer });
            }
          };
        `,
      },
      await sourceModule("src/console/runtime/server/usage.ts"),
      await sourceModule("src/error-diagnostics.ts"),
      { type: "ESModule", path: resolve(root, "src/console/runtime/server/valibot"), contents: await readFile(new URL(import.meta.resolve("valibot")), "utf8") },
      { type: "ESModule", path: resolve(root, "src/nostics"), contents: await readFile(new URL(import.meta.resolve("nostics")), "utf8") },
    ],
  });
  try {
    const query = { agentName: "雪🌍%41", search: "100%_ &+?#" };
    const request = (body: object) => worker.dispatchFetch("http://console.test", {
      method: "POST", body: JSON.stringify(body),
    });
    const first = await request(query);
    expect(first.status).toBe(200);
    const page = await first.json();
    const { cursor } = v.parse(v.object({ cursor: v.string() }), page);
    expect(page).toMatchObject({
      buffer: "undefined", after: { id: "雪🌍%41", at: "2026-09-05T12:00:00.000Z" },
    });
    const next = await request({ ...query, cursor });
    expect(next.status).toBe(200);
    expect(await next.json()).toEqual(page);
  } finally {
    await worker.dispose();
  }
}, 30_000);

it("queries a cached usage index across concurrent D1 Worker requests", async () => {
  const worker = new Miniflare({
    compatibilityDate: "2026-07-14",
    d1Databases: ["DB"],
    modulesRoot: root,
    modules: [
      {
        type: "ESModule",
        path: resolve(root, "worker.mjs"),
        contents: `
          import { createConsoleUsageIndex } from "./src/console/runtime/server/usage-index.ts";
          let index;
          export default {
            async fetch(request, env) {
              const prepare = s => env.DB.prepare(s.sql).bind(...(s.args ?? []));
              index ??= createConsoleUsageIndex({
                async execute(s) { return { rows: (await prepare(s).all()).results }; },
                async batch(statements) { return (await env.DB.batch(statements.map(prepare))).map(r => ({ rows: r.results })); }
              }, { requestScoped: true });
              return Response.json(await index.query({ now: "2026-09-30T00:00:00.000Z" }));
            }
          };
        `,
      },
      await sourceModule("src/console/runtime/server/usage-index.ts"),
      await sourceModule("src/console/runtime/server/usage.ts"),
      await sourceModule("src/error-diagnostics.ts"),
      {
        type: "ESModule",
        path: resolve(root, "src/console/runtime/server/valibot"),
        contents: await readFile(new URL(import.meta.resolve("valibot")), "utf8"),
      },
      {
        type: "ESModule",
        path: resolve(root, "src/nostics"),
        contents: await readFile(new URL(import.meta.resolve("nostics")), "utf8"),
      },
    ],
  });
  try {
    const db = await worker.getD1Database("DB");
    await db
      .prepare(
        `CREATE TABLE vitehub_agent_invocations (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, agent_name TEXT, status TEXT, updated_at TEXT, record TEXT)`,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO vitehub_agent_invocations(id,agent_name,status,updated_at,record) VALUES ('run','bot','completed','2026-09-30T00:00:00.000Z',?)`,
      )
      .bind(
        JSON.stringify({
          completedAt: "2026-09-30T00:00:00.000Z",
          observations: [
            {
              name: "agent.invocation.finish",
              attributes: { "usage.record": { cost: { usd: "0.1" }, usage: { totalTokens: 5 } } },
            },
          ],
        }),
      )
      .run();
    const request = () => worker.dispatchFetch("http://console.test");
    const responses = await Promise.all([request(), request()]);
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        projection: { complete: true, pending: 0 },
        totals: { invocations: 1, costUsd: "0.1" },
      });
    }
    const next = await request();
    expect(next.status).toBe(200);
    expect(await next.json()).toMatchObject({ totals: { invocations: 1, costUsd: "0.1" } });
  } finally {
    await worker.dispose();
  }
}, 30_000);
