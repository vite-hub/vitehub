import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
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

const consoleHttpErrorModules = async () => [
  await sourceModule("src/console/runtime/server/http-error.ts"),
  {
    type: "ESModule" as const,
    path: resolve(root, "src/console/runtime/server/nitro/h3"),
    contents: (await build({
      bundle: true,
      conditions: ["workerd", "worker"],
      format: "esm",
      platform: "neutral",
      stdin: { contents: 'export { createError } from "h3"', resolveDir: root },
      write: false,
    })).outputFiles[0]!.text,
  },
];

const agentUsageModule = async () => ({
  type: "ESModule" as const,
  path: resolve(root, "src/console/runtime/server/@vite-hub/agent/usage"),
  contents: (await build({
    bundle: true,
    conditions: ["workerd", "worker"],
    format: "esm",
    platform: "neutral",
    stdin: { contents: 'export * from "@vite-hub/agent/usage"', resolveDir: root },
    write: false,
  })).outputFiles[0]!.text,
});

it("paginates Console usage in Cloudflare without Node compatibility", async () => {
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
      await agentUsageModule(),
      await sourceModule("src/error-diagnostics.ts"),
      ...await consoleHttpErrorModules(),
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

it.each([false, true])("adds up a D1 journal without a new table (large search: %s)", async (search) => {
  const worker = new Miniflare({
    compatibilityDate: "2026-07-14",
    d1Databases: ["DB"],
    modulesRoot: root,
    modules: [
      {
        type: "ESModule",
        path: resolve(root, "worker.mjs"),
        contents: `
          import { agentUsagePeriod, readAgentUsage } from "./src/console/runtime/server/@vite-hub/agent/usage";
          export default {
            async fetch(request, env) {
              try { return await answer(env, await request.json()) } catch (error) { return Response.json({ error: String(error?.stack ?? error) }, { status: 500 }) }
            }
          };
          async function answer(env, input) {
              const statements = [];
              const query = { now: Date.parse("2026-09-30T01:00:00.000Z"), window: "24h", ...input };
              const summary = await readAgentUsage({
                async execute(s) {
                  statements.push(s.sql);
                  return { rows: (await env.DB.prepare(s.sql).bind(...s.args).all()).results };
                },
              }, query, agentUsagePeriod(query));
              return Response.json({ statements: statements.length, summary });
          }
        `,
      },
      await agentUsageModule(),
    ],
  });
  try {
    const db = await worker.getD1Database("DB");
    await db.prepare(`CREATE TABLE vitehub_agent_invocations (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, agent_name TEXT, status TEXT, updated_at TEXT, record TEXT)`).run();
    await db.prepare("CREATE INDEX vitehub_agent_invocations_status_updated_at ON vitehub_agent_invocations (status, updated_at)").run();
    const insert = (id: string, at: string, usd: string, totalTokens: number) => db
      .prepare(`INSERT INTO vitehub_agent_invocations(id,agent_name,status,updated_at,record) VALUES (?,'bot','completed',?,?)`)
      .bind(id, at, JSON.stringify({
        agentName: "bot", completedAt: at, createdAt: at, id, status: "completed", updatedAt: at,
        observations: [{ name: "agent.invocation.finish", attributes: { "usage.record": { cost: { usd }, usage: { totalTokens } } } }],
      }))
      .run();
    await insert("run", "2026-09-30T00:00:00.000Z", "0.1", 5);
    await insert("old", "2026-09-20T00:00:00.000Z", "9", 1);
    const at = "2026-09-28T23:30:00-02:00";
    await db.prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 96)
      INSERT INTO vitehub_agent_invocations(id,agent_name,status,updated_at,record)
      SELECT 'trace-' || n, 'bot', 'completed', ?, ? FROM seq`)
      .bind(at, JSON.stringify({
        agentName: "bot", completedAt: at, createdAt: at, updatedAt: at,
        observations: [
          ...Array.from({ length: 10 }, () => ({ name: "agent.message", attributes: { text: "x".repeat(32_000) } })),
          { name: "agent.invocation.finish", attributes: { "usage.record": { cost: { usd: "00000000000000.25" }, model: "\tgpt\n", usage: { totalTokens: 2 } } } },
        ],
      }))
      .run();
    const tables = async () => (await db.prepare("SELECT name FROM sqlite_master ORDER BY name").all()).results;
    const before = await tables();
    const request = (input: object) => worker.dispatchFetch("http://console.test", { method: "POST", body: JSON.stringify(input) });
    if (search) {
      const time = "2026-09-30T00:30:00.000Z";
      await db.prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 50000)
        INSERT INTO vitehub_agent_invocations(id,agent_name,status,updated_at,record)
        SELECT printf('run_%037d', n), 'bot', 'completed', ?, ? FROM seq`)
        .bind(time, JSON.stringify({
          completedAt: time, createdAt: time, title: "Über 100%_", updatedAt: time,
          observations: [{ name: "agent.invocation.finish", attributes: { "usage.record": { cost: { usd: "0.01" }, usage: { totalTokens: 2 } } } }],
        }))
        .run();
    }
    const input = search ? { search: "ÜBER 100%_" } : {};
    const response = await request(input);
    const body = await response.json();
    expect(body).toMatchObject({
      statements: search ? 2 : 1,
      summary: { partial: false, totals: search
        ? { costUsd: "500", invocations: 50_000, totalTokens: 100_000 }
        : { costUsd: "24.1", invocations: 97, totalTokens: 197 } },
    });
    expect(response.status).toBe(200);
    if (search) {
      const { summary } = v.parse(v.object({ summary: v.object({ cursor: v.string(), sessions: v.array(v.object({ id: v.string() })), totals: v.unknown() }) }), body);
      const second = await request({ ...input, cursor: summary.cursor });
      expect(second.status).toBe(200);
      const next = v.parse(v.object({ summary: v.object({ sessions: v.array(v.object({ id: v.string() })), totals: v.unknown() }) }), await second.json());
      expect(next.summary.totals).toEqual(summary.totals);
      expect(summary.sessions).toHaveLength(50);
      expect(next.summary.sessions).toHaveLength(50);
      expect(next.summary.sessions[0]?.id).toBe(`run_${String(49_950).padStart(37, "0")}`);
    }
    expect(await tables()).toEqual(before);
  } finally {
    await worker.dispose();
  }
}, 30_000);
