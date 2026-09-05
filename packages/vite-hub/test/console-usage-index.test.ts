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
