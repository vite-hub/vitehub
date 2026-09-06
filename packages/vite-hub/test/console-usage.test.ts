import { describe, expect, it, vi } from "vitest";
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "@vite-hub/agent/server";

import { createUsageSummary, invocationUsage } from "../src/console/runtime/server/usage.ts";

function invocationRecordFromUsageRecord(usageRecord: Record<string, unknown>) {
  return {
    completedAt: "2026-08-27T10:00:00.000Z",
    createdAt: "2026-08-27T10:00:00.000Z",
    cursor: "usage-invocation",
    id: "usage-invocation",
    observations: [
      {
        attributes: { "usage.record": usageRecord },
        name: "agent.invocation.finish",
        sequence: 1,
        timestamp: "2026-08-27T10:00:00.000Z",
        type: "lifecycle" as const,
      },
    ],
    status: "completed" as const,
    traceId: "usage-trace",
    updatedAt: "2026-08-27T10:00:00.000Z",
  } satisfies Parameters<typeof invocationUsage>[0];
}

function invocationRecord(usage: Record<string, unknown>) {
  return invocationRecordFromUsageRecord({ usage });
}

describe("Console usage projection", () => {
  it("uses the configured invocation model when provider usage omits it", () => {
    expect(
      invocationUsage({
        ...invocationRecord({ totalTokens: 10 }),
        annotations: { "agent.model.id": "claude-sonnet-4-5" },
      }),
    ).toEqual({
      model: "claude-sonnet-4-5",
      totalTokens: 10,
    });
  });

  it("reads reasoning tokens from fallback usage details", () => {
    expect(
      invocationUsage(
        invocationRecord({
          details: { reasoningOutputTokens: 4 },
          totalTokens: 10,
        }),
      ),
    ).toEqual({ reasoningTokens: 4, totalTokens: 10 });
  });

  it("prefers normalized output token details", () => {
    expect(
      invocationUsage(
        invocationRecord({
          details: { reasoningOutputTokens: 9 },
          outputTokenDetails: { reasoningTokens: 0 },
          totalTokens: 10,
        }),
      ),
    ).toEqual({ reasoningTokens: 0, totalTokens: 10 });
  });

  it("inherits the nearest compound model while flattening calls", () => {
    expect(
      invocationUsage(
        invocationRecordFromUsageRecord({
          calls: [
            {
              calls: [
                { usage: { totalTokens: 4 } },
                { model: "leaf-model", usage: { totalTokens: 6 } },
              ],
              model: "compound-model",
            },
          ],
        }),
      ),
    ).toMatchObject({
      calls: [
        { model: "compound-model", totalTokens: 4 },
        { model: "leaf-model", totalTokens: 6 },
      ],
      totalTokens: 10,
    });
  });

  it("preserves raw-only calls as unavailable model evidence", async () => {
    const record = invocationRecordFromUsageRecord({
      calls: [
        { model: "known-model", usage: { totalTokens: 10 } },
        { raw: { requestId: "raw-only" } },
      ],
      usage: { totalTokens: 15 },
    });
    const { observations: _observations, ...summary } = record;
    const invocations = {
      get: vi.fn(async () => record),
      getByRunId: vi.fn(async () => record),
      list: vi.fn(async () => ({ invocations: [summary] })),
    };

    expect(invocationUsage(record)).toEqual({
      calls: [{ model: "known-model", totalTokens: 10 }, {}],
      totalTokens: 15,
    });
    // doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- SAFETY: This fixture supplies the three read methods used by the usage summary.
    await expect(
      createUsageSummary(invocations as unknown as Parameters<typeof createUsageSummary>[0], {
        now: "2026-08-27T12:00:00.000Z",
        window: "24h",
      }),
    ).resolves.toMatchObject({
      models: expect.arrayContaining([
        expect.objectContaining({
          model: "known-model",
          totalTokens: 10,
          totalTokensAvailable: true,
        }),
        expect.objectContaining({
          invocations: 1,
          model: "Unknown model",
          totalTokensAvailable: false,
        }),
      ]),
      totals: { totalTokens: 15, totalTokensAvailable: true },
    });
  });

  it("includes terminal invocation usage without a completed-only filter", async () => {
    const record = invocationRecord({ totalTokens: 10 });
    const { observations: _observations, ...summary } = record;
    const list = vi.fn(async () => ({ invocations: [summary] }));
    const invocations = {
      get: vi.fn(async () => record),
      getByRunId: vi.fn(async () => record),
      list,
    };

    // doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- SAFETY: This fixture supplies the three read methods used by the usage summary.
    await expect(
      createUsageSummary(invocations as unknown as Parameters<typeof createUsageSummary>[0], {
        now: "2026-08-27T12:00:00.000Z",
        window: "24h",
      }),
    ).resolves.toMatchObject({
      available: true,
      partial: false,
      totals: { invocations: 1, totalTokens: 10 },
    });
    expect(list).toHaveBeenCalledWith({ limit: 100 });
  });

  it("preserves empty opaque cursors while scanning usage pages", async () => {
    const first = invocationRecord({ totalTokens: 10 });
    const second = {
      ...invocationRecord({ totalTokens: 20 }),
      cursor: "second-usage",
      id: "second-usage",
      traceId: "second-usage-trace",
    };
    const records = new Map([
      [first.id, first],
      [second.id, second],
    ]);
    const list = vi.fn(async (options?: { cursor?: string }) => ({
      ...(options?.cursor === undefined ? { cursor: "" } : {}),
      invocations: [options?.cursor === undefined ? first : second].map(
        ({ observations: _observations, ...summary }) => summary,
      ),
    }));
    const invocations = {
      get: vi.fn(async (id: string) => records.get(id)),
      getByRunId: vi.fn(),
      list,
    };

    // doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- SAFETY: This fixture supplies the three read methods used by the usage summary.
    await expect(
      createUsageSummary(invocations as unknown as Parameters<typeof createUsageSummary>[0], {
        now: "2026-08-27T12:00:00.000Z",
        window: "24h",
      }),
    ).resolves.toMatchObject({
      available: true,
      partial: false,
      totals: { invocations: 2, totalTokens: 30 },
    });
    expect(list).toHaveBeenNthCalledWith(2, expect.objectContaining({ cursor: "" }));
  });

  it("marks missing usage evidence incomplete for model totals", async () => {
    const recorded = invocationRecordFromUsageRecord({
      model: "recorded-model",
      usage: { totalTokens: 10 },
    });
    const missing = {
      ...recorded,
      cursor: "missing-usage",
      id: "missing-usage",
      observations: [],
      traceId: "missing-usage-trace",
    };
    const records = new Map([
      [recorded.id, recorded],
      [missing.id, missing],
    ]);
    const invocations = {
      get: vi.fn(async (id: string) => records.get(id)),
      getByRunId: vi.fn(),
      list: vi.fn(async () => ({
        invocations: [...records.values()].map(
          ({ observations: _observations, ...summary }) => summary,
        ),
      })),
    };

    // doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- SAFETY: This fixture supplies the three read methods used by the usage summary.
    await expect(
      createUsageSummary(invocations as unknown as Parameters<typeof createUsageSummary>[0], {
        now: "2026-08-27T12:00:00.000Z",
        window: "24h",
      }),
    ).resolves.toMatchObject({
      models: [{ model: "recorded-model", totalTokens: 10, totalTokensAvailable: true }],
      partial: true,
      totals: { invocations: 2, totalTokens: 10, totalTokensAvailable: false },
    });
  });

  it("marks records that disappear after listing as incomplete", async () => {
    const record = invocationRecord({ totalTokens: 10 });
    const { observations: _observations, ...summary } = record;
    const invocations = {
      get: vi.fn(async () => undefined),
      getByRunId: vi.fn(),
      list: vi.fn(async () => ({ invocations: [summary] })),
    };

    // doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- SAFETY: This fixture supplies the three read methods used by the usage summary.
    await expect(
      createUsageSummary(invocations as unknown as Parameters<typeof createUsageSummary>[0], {
        now: "2026-08-27T12:00:00.000Z",
        window: "24h",
      }),
    ).resolves.toMatchObject({
      available: true,
      partial: true,
      totals: { invocations: 1, totalTokensAvailable: false },
    });
  });
});

describe("Console session usage history with a custom store", () => {
  it("keeps missing usage sessions and applies filters to the complete history", async () => {
    const store = createMemoryAgentInvocationStore();
    const invocations = defineAgentInvocations({ store });
    for (let index = 0; index < 55; index++) {
      const record = invocationRecord({ totalTokens: 10 });
      await store.create({
        ...record,
        id: `session-${String(index).padStart(2, "0")}`,
        title: "Shared 100%_title",
        annotations: { "agent.model.id": "known-model" },
        threadId: "shared-thread",
        agentName: "bot",
        status: "failed",
        ...(index === 0 ? { observations: [] } : {}),
      });
    }
    await store.create({
      ...invocationRecord({ totalTokens: 999 }),
      id: "other-agent",
      title: "Shared 100%_title",
      threadId: "shared-thread",
      agentName: "other",
      status: "failed",
    });
    await store.create({
      ...invocationRecord({ totalTokens: 999 }),
      id: "completed",
      title: "Shared 100%_title",
      agentName: "bot",
    });
    const options = {
      now: "2026-08-27T12:00:00.000Z",
      window: "24h" as const,
      agentName: "bot",
      status: "failed" as const,
      search: "100%_",
    };
    const first = await createUsageSummary(invocations, options);
    expect(first).toMatchObject({
      available: true,
      sessionCount: 55,
      totals: { invocations: 55, totalTokens: 540, totalTokensAvailable: false },
    });
    expect(first.sessions).toHaveLength(50);
    const second = await createUsageSummary(invocations, {
      ...options,
      cursor: String(first.cursor),
    });
    expect(second).toMatchObject({
      sessionCount: 55,
      totals: first.totals,
      sessions: [
        { id: "session-04" },
        { id: "session-03" },
        { id: "session-02" },
        { id: "session-01" },
        {
          id: "session-00",
          models: ["known-model"],
          title: "Shared 100%_title",
          partial: true,
          totals: { totalTokensAvailable: false },
        },
      ],
    });
    expect(second.cursor).toBeUndefined();
  });

  it("rechecks filters when a session title changes after listing", async () => {
    const store = createMemoryAgentInvocationStore();
    const record = invocationRecord({ totalTokens: 10 });
    await store.create({ ...record, title: "Old title" });
    const invocations = defineAgentInvocations({ store });
    const list = invocations.list.bind(invocations);
    vi.spyOn(invocations, "list").mockImplementationOnce(async (options) => {
      const page = await list(options);
      await store.update(record.id, {
        timestamp: record.updatedAt,
        observation: {
          name: "agent.title.recorded",
          type: "lifecycle",
          sequence: 2,
          timestamp: record.updatedAt,
          attributes: { "vitehub.session.title": "New title" },
        },
      });
      return page;
    });
    expect(
      await createUsageSummary(invocations, { now: "2026-08-27T12:00:00.000Z", search: "old" }),
    ).toMatchObject({ sessionCount: 0, sessions: [], totals: { invocations: 0 } });
  });

  it("uses the final finish evidence and preserves decimal ordering", async () => {
    const record = invocationRecord({ totalTokens: 10 });
    expect(
      invocationUsage({
        ...record,
        observations: [
          ...record.observations,
          { ...record.observations[0]!, attributes: {}, sequence: 2 },
        ],
      }),
    ).toBeUndefined();
    const store = createMemoryAgentInvocationStore();
    for (const [id, usd] of [
      ["higher", "1.000000000000000002"],
      ["lower", "1.000000000000000001"],
    ]) {
      await store.create({
        ...invocationRecordFromUsageRecord({ cost: { usd }, usage: { totalTokens: 10 } }),
        id: id!,
      });
    }
    expect(
      await createUsageSummary(defineAgentInvocations({ store }), {
        now: "2026-08-27T12:00:00.000Z",
      }),
    ).toMatchObject({
      expensive: [{ id: "higher" }, { id: "lower" }],
      totals: { costUsd: "2.000000000000000003" },
    });
  });
});
