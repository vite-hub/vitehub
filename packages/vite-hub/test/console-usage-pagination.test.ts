import { createClient } from "@libsql/client";
import { createLibsqlAgentInvocationStore } from "@vite-hub/agent/invocations/sqlite";
import { defineAgentInvocations } from "@vite-hub/agent/server";
import { expect, it } from "vitest";
import { createConsoleUsageIndex } from "../src/console/runtime/server/usage-index.ts";
import { createUsageSummary } from "../src/console/runtime/server/usage.ts";
import type { UsageQuery } from "../src/console/runtime/server/usage.ts";

const timestamp = "2026-09-05T12:00:00.000Z";

it.each(["index", "custom"] as const)(
  "keeps %s history pages stable across insertions and deletions",
  async (mode) => {
    const client = createClient({ url: "file::memory:" });
    try {
      const store = createLibsqlAgentInvocationStore({
        client,
        maxAgeMs: false,
        maxRecords: false,
      });
      const invocations = defineAgentInvocations({ store });
      const index = createConsoleUsageIndex(client);
      const query = (options: UsageQuery) =>
        mode === "index" ? index.query(options) : createUsageSummary(invocations, options);
      const insert = (id: string, at = timestamp) =>
        store.create({
          id,
          agentName: "bot",
          title: "Task",
          status: "completed",
          traceId: id,
          createdAt: at,
          completedAt: at,
          updatedAt: at,
          observations: [
            {
              name: "agent.invocation.finish",
              sequence: 1,
              timestamp: at,
              type: "lifecycle",
              attributes: { "usage.record": { usage: { totalTokens: 5 } } },
            },
          ],
        });
      for (let i = 0; i < 55; i++) await insert(`session-${String(i).padStart(2, "0")}`);
      if (mode === "index") await index.rebuild();
      const options = {
        now: timestamp,
        window: "24h" as const,
        agentName: "bot",
        status: "completed" as const,
        search: "Task",
      };
      const first = await query(options);
      expect(first.sessions).toHaveLength(50);
      const cursor = String(first.cursor);
      expect(cursor).not.toMatch(/^\d+$/);

      // Backfilled records can enter before the page boundary. Normal new completions are after the fixed cutoff.
      await insert("zz-backfill");
      await insert("zz-later", "2026-09-05T12:00:01.000Z");
      const nextOptions = { ...options, now: "2026-09-07T12:00:00.000Z", cursor };
      const second = await query(nextOptions);
      expect(second).toMatchObject({
        from: first.from,
        to: first.to,
        sessionCount: 56,
        totals: { invocations: 56, totalTokens: 280 },
        sessions: [
          { id: "session-04" },
          { id: "session-03" },
          { id: "session-02" },
          { id: "session-01" },
          { id: "session-00" },
        ],
      });
      expect(second.cursor).toBeUndefined();

      // Removing both a seen row and the boundary row must not shift the next page.
      await client.execute(
        `DELETE FROM vitehub_agent_invocations WHERE id IN ('session-54', 'session-05', 'session-02')`,
      );
      expect(await query(nextOptions)).toMatchObject({
        from: first.from,
        to: first.to,
        sessionCount: 53,
        totals: { invocations: 53, totalTokens: 265 },
        sessions: [
          { id: "session-04" },
          { id: "session-03" },
          { id: "session-01" },
          { id: "session-00" },
        ],
      });

      for (const changed of [
        { window: "7d" as const },
        { agentName: "other" },
        { status: "failed" as const },
        { search: "different" },
      ]) {
        await expect(query({ ...nextOptions, ...changed })).rejects.toMatchObject({
          statusCode: 400,
        });
      }
      for (const invalid of ["50", "%", encodeURIComponent(JSON.stringify({ version: 1 }))]) {
        await expect(query({ ...options, cursor: invalid })).rejects.toMatchObject({
          statusCode: 400,
        });
      }
    } finally {
      client.close();
    }
  },
);
