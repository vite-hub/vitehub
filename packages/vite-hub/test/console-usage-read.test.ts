import { createClient } from "@libsql/client";
import { createLibsqlAgentInvocationStore } from "@vite-hub/agent/invocations";
import { defineAgentInvocations } from "@vite-hub/agent/server";
import { agentUsagePeriod, readAgentUsage } from "@vite-hub/agent/usage";
import { afterEach, describe, expect, it } from "vitest";
import { createConsoleUsageIndex } from "../src/agent/console/usage-index.ts";
import { createUsageSummary } from "../src/agent/console/usage.ts";
import type { AgentInvocationRecord, AgentInvocations } from "@vite-hub/agent";
import type { AgentUsagePeriod, AgentUsageQuery } from "@vite-hub/agent/usage";
import type { Client } from "@libsql/client";

const now = "2026-09-05T12:00:00.000Z";
const clients: Client[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

const priced = (usd: string, estimated = false) => ({
  cost: { usd, estimated },
  usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
});

async function journal() {
  const client = createClient({ url: "file::memory:" });
  clients.push(client);
  const store = createLibsqlAgentInvocationStore({ client, maxAge: false, maxRecords: false });
  const invocations = defineAgentInvocations({ store });
  const seed = async (
    id: string,
    usage: unknown,
    at = "2026-09-05T11:15:00.000Z",
    status: AgentInvocationRecord["status"] = "failed",
    agentName = "bot",
    truncated = false,
  ) => {
    await store.create({
      id, agentName, status, title: `Task ${id}`, createdAt: at, updatedAt: at,
      ...(status === "pending" || status === "running" ? {} : { completedAt: at }),
      traceId: id,
      annotations: { "agent.model.id": "model" },
      observations: usage === undefined ? [] : [{
        name: "agent.invocation.finish", sequence: 1, timestamp: at, type: "lifecycle",
        attributes: { "usage.record": usage, "vitehub.observation.truncated": truncated },
      }],
    });
  };
  const firstModel = "provider:model|variant:雪";
  const secondModel = 'provider:model|variant:"other"';
  await seed("selected-compound", { calls: [
    { model: firstModel, ...priced("0.1") },
    { model: firstModel, ...priced("0.2") },
    { model: secondModel, usage: { inputTokens: 7 } },
  ] });
  await seed("selected-precise", { model: firstModel, ...priced("0.000000000000001", true) });
  await seed("selected-repeat", { model: firstModel, ...priced("0.000000000000001") });
  await seed("selected-zero", { model: secondModel, ...priced("0") });
  await seed("selected-order-small", { model: "a-small", ...priced("0") });
  await seed("selected-order-tie", { model: "a-tied", usage: { totalTokens: 20 } });
  await seed("selected-older", { model: firstModel, ...priced("0.4") }, "2026-09-04T13:15:00.000Z");
  await seed("selected-truncated", { model: firstModel, ...priced("100") }, undefined, undefined, undefined, true);
  await seed("selected-missing", undefined);
  await seed("selected-other-agent", { model: firstModel, ...priced("10") }, undefined, undefined, "other");
  await seed("selected-other-status", { model: firstModel, ...priced("10") }, undefined, "completed");
  await seed("selected-cancelled", { model: secondModel, ...priced("0.5") }, "2026-09-05T09:00:00.000Z", "cancelled");
  await seed("running", undefined, undefined, "running");
  await seed("irrelevant", { model: firstModel, ...priced("10") });
  await seed("selected-outside", { model: firstModel, ...priced("10") }, "2026-08-01T00:00:00.000Z");
  return { client, invocations, store };
}

const tables = async (client: Client) =>
  (await client.execute("SELECT type, name FROM sqlite_master ORDER BY type, name")).rows.map(row => `${row.type}:${row.name}`);

const finish = (usage: unknown) => ({
  attributes: { "usage.record": usage, "vitehub.observation.id": "late-finish" },
  name: "agent.invocation.finish",
  timestamp: "2026-09-05T11:15:00.000Z",
  type: "lifecycle" as const,
});

async function compare(client: Client, invocations: AgentInvocations, index: ReturnType<typeof createConsoleUsageIndex>) {
  for (const window of ["24h", "7d", "90d"] as const) {
    for (const filters of [{}, { agentName: "bot", status: "failed" as const, search: "selected" }, { status: "cancelled" as const }]) {
      const query: AgentUsageQuery = { now, window, ...filters };
      const period = agentUsagePeriod(query);
      if ("problem" in period) throw new Error(period.problem);
      const { generatedAt: _read, ...read } = await readAgentUsage(client, query, period);
      const indexed = await index.query(query);
      const label = JSON.stringify(query);
      expect(read.totals, label).toEqual(indexed.totals);
      expect(read.buckets, label).toEqual(indexed.buckets);
      expect(read.models, label).toEqual(indexed.models);
      expect(read.agents, label).toEqual(indexed.agents);
      expect(read.sessionCount, label).toEqual(indexed.sessionCount);
      expect(read.partial, label).toEqual(indexed.partial);
      expect(read.sessions, label).toEqual(indexed.sessions);
      const { generatedAt: _fallback, ...fallback } = await createUsageSummary(invocations, query);
      expect(read, label).toEqual(fallback);
    }
  }
}

describe("Console usage that the journal adds up at request time", { timeout: 90_000 }, () => {
  it("gives the totals of usage.get, after same-timestamp updates, deletes, and backdated imports", async () => {
    const { client, invocations, store } = await journal();
    const before = await tables(client);
    const period = agentUsagePeriod({ now });
    if ("problem" in period) throw new Error(period.problem);
    await readAgentUsage(client, { now }, period);
    expect(await tables(client)).toEqual(before);
    const index = createConsoleUsageIndex(client);
    await compare(client, invocations, index);

    const updatedAt = async () => (await client.execute({ args: ["selected-precise"], sql: "SELECT updated_at FROM vitehub_agent_invocations WHERE id = ?" })).rows[0]?.updated_at;
    const updated = await updatedAt();
    await store.update("selected-precise", { appendObservation: finish({ model: "late", ...priced("7") }), timestamp: "2026-09-05T11:15:00.000Z" });
    expect(await updatedAt()).toBe(updated);
    await store.delete("selected-zero");
    await store.create({
      id: "imported", agentName: "bot", status: "failed", title: "Task imported", traceId: "imported",
      createdAt: "2026-09-02T08:00:00.000Z", updatedAt: "2026-09-02T08:00:00.000Z", completedAt: "2026-09-02T08:00:00.000Z",
      observations: [{ ...finish({ model: "imported", ...priced("3") }), sequence: 1 }],
    });
    await compare(client, invocations, index);
    const { sessions, models } = await readAgentUsage(client, { now, window: "7d" }, agentUsagePeriod({ now, window: "7d" }) as AgentUsagePeriod);
    expect(sessions.map(session => session.id)).toContain("imported");
    expect(sessions.map(session => session.id)).not.toContain("selected-zero");
    expect(models.map(model => model.model)).toContain("late");
  });
});
