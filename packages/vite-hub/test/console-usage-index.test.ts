import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { createConsoleUsageIndex } from "../src/console/runtime/server/usage-index.ts";
import type { Client } from "@libsql/client";
const clients: Client[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});
const now = "2026-09-05T12:00:00.000Z";
async function fixture() {
  const client = createClient({ url: "file::memory:" });
  clients.push(client);
  await client.execute(
    `CREATE TABLE vitehub_agent_invocations (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, agent_name TEXT, status TEXT, updated_at TEXT, record TEXT)`,
  );
  const insert = async (
    id: string,
    usage?: unknown,
    status = "completed",
    agent = "bot",
    at = now,
  ) => {
    await client.execute({
      sql: `INSERT INTO vitehub_agent_invocations(id,agent_name,status,updated_at,record) VALUES (?,?,?,?,?)`,
      args: [
        id,
        agent,
        status,
        at,
        JSON.stringify({
          completedAt: at,
          annotations: { "agent.model.id": "model" },
          observations:
            usage === undefined
              ? []
              : [{ name: "agent.invocation.finish", attributes: { "usage.record": usage } }],
        }),
      ],
    });
  };
  return { client, insert, index: createConsoleUsageIndex(client) };
}
const priced = (usd: string, estimated = false) => ({
  cost: { usd, estimated },
  usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
});
describe("Console persisted usage index", () => {
  it("includes failed costs, preserves zero and unknown, and counts auxiliary calls once", async () => {
    const { insert, index } = await fixture();
    await insert("failed", priced("0.1"), "failed");
    await insert("cancelled", priced("0.2", true), "cancelled");
    await insert("zero", priced("0"));
    await insert("unknown");
    await insert("calls", { calls: [priced("0.1"), priced("0.2")] });
    await index.rebuild();
    expect(await index.query({ now })).toMatchObject({
      costSupported: true,
      partial: true,
      totals: {
        invocations: 5,
        pricedInvocations: 4,
        costUsd: "0.6",
        averageCostUsd: "0.15",
        costEstimated: true,
        costAvailable: false,
      },
      models: [{ model: "model", invocations: 4, pricedInvocations: 4, costUsd: "0.6" }],
      expensive: [{ id: "calls" }, { id: "cancelled" }, { id: "failed" }, { id: "zero" }],
      runs: expect.arrayContaining([{ id: "unknown", agent: "bot", status: "completed", at: now }]),
    });
  });
  it("excludes pending and running invocations", async () => {
    const { client, insert, index } = await fixture();
    await insert("completed", priced("0.1"));
    await insert("pending", priced("10"), "pending");
    await insert("running", priced("20"), "running");
    await index.rebuild();
    expect(await index.query({ now })).toMatchObject({
      projection: { complete: true, pending: 0 },
      totals: { invocations: 1, pricedInvocations: 1, costUsd: "0.1" },
      models: [{ model: "model", invocations: 1, costUsd: "0.1" }],
      runs: [{ id: "completed" }],
      expensive: [{ id: "completed" }],
    });
    await client.execute(
      `UPDATE vitehub_agent_invocations SET status = 'running' WHERE id = 'completed'`,
    );
    await index.rebuild();
    expect(await index.query({ now })).toMatchObject({
      projection: { complete: true, pending: 0 },
      totals: { invocations: 0 },
      models: [],
      runs: [],
      expensive: [],
    });
  });
  it("projects terminal usage while active invocations keep updating", async () => {
    const { client, insert, index } = await fixture();
    await index.rebuild();
    for (let i = 0; i < 250; i++) await insert(`running-${i}`, priced("10"), "running");
    await insert("completed", priced("0.1"));

    let updating = true;
    const updates = (async () => {
      let revision = 0;
      while (updating) {
        await client.execute({
          sql: `UPDATE vitehub_agent_invocations SET updated_at = ? WHERE status = 'running'`,
          args: [new Date(Date.parse(now) + revision++).toISOString()],
        });
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    })();
    try {
      expect(await index.query({ now })).toMatchObject({
        projection: { complete: true, pending: 0 },
        totals: { invocations: 1, pricedInvocations: 1, costUsd: "0.1" },
        runs: [{ id: "completed" }],
      });
    } finally {
      updating = false;
      await updates;
      await index.rebuild();
    }
  });
  it("rebuilds idempotently, updates evidence, and removes deleted records", async () => {
    const { client, insert, index } = await fixture();
    await insert("run", priced("0.01"));
    await index.rebuild();
    const replacement = createConsoleUsageIndex(client);
    await replacement.rebuild();
    expect(await replacement.query({ now })).toMatchObject({
      totals: { costUsd: "0.01", invocations: 1 },
    });
    await client.execute({
      sql: `UPDATE vitehub_agent_invocations SET record = json_set(record, '$.observations[0].attributes."usage.record".cost.usd', ?) WHERE id = 'run'`,
      args: ["0.02"],
    });
    await replacement.rebuild();
    expect(await replacement.query({ now })).toMatchObject({
      totals: { costUsd: "0.02", invocations: 1 },
    });
    await client.execute("DELETE FROM vitehub_agent_invocations WHERE id = 'run'");
    expect(await replacement.query({ now })).toMatchObject({ totals: { invocations: 0 } });
  });
  it("preserves the v1 projection while old and new processes overlap", async () => {
    const { client, insert, index } = await fixture();
    await insert("shared", priced("0.1"));
    await client.batch(
      [
        `CREATE TABLE vitehub_console_usage_v1 (id TEXT PRIMARY KEY, usage TEXT)`,
        `INSERT INTO vitehub_console_usage_v1 VALUES ('shared', 'old projection')`,
        `CREATE TABLE vitehub_console_usage_v1_dirty (id TEXT PRIMARY KEY, generation INTEGER NOT NULL DEFAULT 1)`,
        `CREATE TRIGGER vitehub_console_usage_v1_update AFTER UPDATE ON vitehub_agent_invocations BEGIN
        INSERT INTO vitehub_console_usage_v1_dirty(id) VALUES (NEW.id)
        ON CONFLICT(id) DO UPDATE SET generation = generation + 1;
      END`,
      ],
      "write",
    );
    await index.rebuild();
    expect(await index.query({ now })).toMatchObject({ sessionCount: 1 });
    expect(
      (await client.execute(`SELECT usage FROM vitehub_console_usage_v1 WHERE id = 'shared'`)).rows,
    ).toEqual([{ usage: "old projection" }]);
    await client.execute(
      `UPDATE vitehub_agent_invocations SET record = json_set(record, '$.title', 'Updated') WHERE id = 'shared'`,
    );
    for (const version of ["v1", "v2"]) {
      expect(
        (await client.execute(`SELECT id FROM vitehub_console_usage_${version}_dirty`)).rows,
      ).toEqual([{ id: "shared" }]);
    }
    expect(await index.query({ now })).toMatchObject({
      sessions: [{ id: "shared", title: "Updated" }],
    });
    expect(
      (await client.execute(`SELECT usage FROM vitehub_console_usage_v1 WHERE id = 'shared'`)).rows,
    ).toEqual([{ usage: "old projection" }]);
  });

  it("uses the same agent and date filters for aggregates and pages", async () => {
    const { insert, index } = await fixture();
    for (let i = 0; i < 55; i++) await insert(`run-${i}`, priced("0.000000000000001"));
    await insert("other", priced("100"), "completed", "other");
    await insert("outside", priced("100"), "completed", "bot", "2026-08-01T00:00:00.000Z");
    await index.rebuild();
    const first = await index.query({ now, agentName: "bot", window: "24h" });
    expect(first).toMatchObject({ totals: { invocations: 55, costUsd: "0.000000000000055" } });
    expect(first.runs).toHaveLength(50);
    const next = await index.query({
      now,
      agentName: "bot",
      window: "24h",
      cursor: String(first.cursor),
    });
    expect(next.runs).toHaveLength(5);
    expect(next.cursor).toBeUndefined();
  });
  it("keeps sessions with shared titles and threads distinct, including missing usage", async () => {
    const { client, insert, index } = await fixture();
    await insert("a", priced("0"));
    await insert("b", undefined, "failed");
    await insert("c", priced("0.2"), "completed", "other");
    await client.execute(
      `UPDATE vitehub_agent_invocations SET record = json_set(record, '$.title', 'Same title', '$.threadId', 'shared-thread', '$.createdAt', '${now}')`,
    );
    await index.rebuild();
    const summary = await index.query({ now });
    expect(summary).toMatchObject({
      available: true,
      sessionCount: 3,
      sessions: [
        {
          id: "c",
          agent: "other",
          title: "Same title",
          totals: { costUsd: "0.2", costAvailable: true },
        },
        {
          id: "b",
          models: ["model"],
          title: "Same title",
          partial: true,
          totals: { totalTokensAvailable: false, costAvailable: false },
        },
        {
          id: "a",
          title: "Same title",
          partial: false,
          totals: { costUsd: "0", costAvailable: true },
        },
      ],
    });
    await client.execute(
      `UPDATE vitehub_agent_invocations SET record = json_set(record, '$.title', 'Änderung') WHERE id = 'a'`,
    );
    expect(await index.query({ now, search: "änderung" })).toMatchObject({
      sessionCount: 1,
      sessions: [{ id: "a", title: "Änderung" }],
    });
    await client.execute(`DELETE FROM vitehub_agent_invocations WHERE id = 'a'`);
    expect(await index.query({ now, search: "änderung" })).toMatchObject({
      sessionCount: 0,
      sessions: [],
    });
  });

  it("distinguishes partial provider usage from recorded zero usage", async () => {
    const { insert, index } = await fixture();
    await insert("partial", { usage: { inputTokens: 12 } });
    await insert("zero", { usage: { totalTokens: 0 } });
    await index.rebuild();
    expect(await index.query({ now })).toMatchObject({
      partial: true,
      sessions: [
        { id: "zero", partial: false, totals: { totalTokens: 0, totalTokensAvailable: true } },
        {
          id: "partial",
          partial: true,
          totals: { inputTokens: 12, inputTokensAvailable: true, totalTokensAvailable: false },
        },
      ],
    });
  });

  it("applies literal search, status, Agent, and time filters to all pages and totals", async () => {
    const { client, insert, index } = await fixture();
    for (let i = 0; i < 55; i++)
      await insert(`run-${String(i).padStart(2, "0")}`, priced("0.000000000000001"), "failed");
    await insert("completed", priced("10"));
    await insert("other", priced("10"), "failed", "other");
    await insert("old", priced("10"), "failed", "bot", "2026-08-01T00:00:00.000Z");
    await client.execute(
      `UPDATE vitehub_agent_invocations SET record = json_set(record, '$.title', 'Fix 100%_complete')`,
    );
    await insert("wrong-title", priced("10"), "failed");
    await index.rebuild();
    const options = {
      now,
      window: "24h" as const,
      agentName: "bot",
      status: "failed" as const,
      search: "100%_",
    };
    const first = await index.query(options);
    expect(first).toMatchObject({
      sessionCount: 55,
      totals: { invocations: 55, costUsd: "0.000000000000055" },
    });
    expect(first.sessions).toHaveLength(50);
    const second = await index.query({ ...options, cursor: String(first.cursor) });
    expect(second).toMatchObject({
      sessionCount: 55,
      totals: first.totals,
      sessions: [
        { id: "run-04" },
        { id: "run-03" },
        { id: "run-02" },
        { id: "run-01" },
        { id: "run-00" },
      ],
    });
    expect(second.cursor).toBeUndefined();
  });

  it("aggregates more than 100,000 runs without a scan ceiling", async () => {
    const { client, index } = await fixture();
    const record = JSON.stringify({
      completedAt: now,
      observations: [
        { name: "agent.invocation.finish", attributes: { "usage.record": priced("0.01") } },
      ],
    });
    await client.execute({
      sql: `WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < 100001) INSERT INTO vitehub_agent_invocations(id,agent_name,status,updated_at,record) SELECT 'run-' || x, 'bot', 'completed', ?, ? FROM n`,
      args: [now, record],
    });
    await index.rebuild();
    expect(await index.query({ now })).toMatchObject({
      projection: { complete: true },
      totals: {
        invocations: 100001,
        pricedInvocations: 100001,
        costUsd: "1000.01",
        totalTokens: 500005,
      },
    });
  }, 300_000);
});
