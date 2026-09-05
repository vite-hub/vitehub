import {
  addDecimal,
  decimal,
  decimalString,
  emptyTotals,
  modelUsage,
  publicTotals,
  stringValue,
  usageNode,
  usageSession,
  usageCursor,
  usageQueryWindow,
} from "./usage.ts";

import type { ConsoleInvocationUsage, UsageQuery, UsageTotal } from "./usage.ts";
import type { Client, InStatement, Row } from "@libsql/client";
import { viteHubErrorDiagnostics } from "../../../error-diagnostics.ts";

const metrics = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cachedInputTokens",
  "cacheWriteTokens",
  "reasoningTokens",
] as const;
const table = "vitehub_console_usage_v2";
const dirty = "vitehub_console_usage_v2_dirty";
const source = "vitehub_agent_invocations";
const terminalStatuses = new Set(["completed", "failed", "cancelled"]);
const terminalStatusList = [...terminalStatuses].map((status) => `'${status}'`).join(",");

export type { UsageQuery } from "./usage.ts";

/** A rebuildable projection. Invocation records remain the authoritative evidence. */
export function createConsoleUsageIndex(client: Client): {
  query(options?: UsageQuery): Promise<Record<string, unknown>>;
  rebuild(): Promise<void>;
} {
  let initialization: Promise<void> | undefined;
  let backfill: Promise<void> | undefined;
  const initialize = () =>
    (initialization ??= (async () => {
      await client.batch(
        [
          // Older processes can still use v1 during a rollout. This index owns only v2 resources.
          `CREATE TABLE IF NOT EXISTS ${table} (
        id TEXT NOT NULL, model_key TEXT NOT NULL, sequence INTEGER NOT NULL,
        agent TEXT NOT NULL, at TEXT NOT NULL, status TEXT NOT NULL, model TEXT,
        usage TEXT, incomplete INTEGER NOT NULL, revision TEXT NOT NULL,
        title TEXT, created_at TEXT NOT NULL, model_names TEXT NOT NULL, search_text TEXT NOT NULL,
        cost_whole TEXT, cost_fraction TEXT, cost_usd TEXT, estimated INTEGER,
        ${metrics.map((metric) => `${metric} INTEGER`).join(",")},
        PRIMARY KEY (id, model_key))`,
          `CREATE INDEX IF NOT EXISTS ${table}_at ON ${table}(model_key, at DESC, id DESC)`,
          `CREATE INDEX IF NOT EXISTS ${table}_agent_at ON ${table}(model_key, agent, at DESC, id DESC)`,
          `CREATE INDEX IF NOT EXISTS ${table}_cost ON ${table}(model_key, length(cost_whole) DESC, cost_whole DESC, cost_fraction DESC, sequence DESC)`,
          `CREATE TABLE IF NOT EXISTS ${dirty} (id TEXT PRIMARY KEY, generation INTEGER NOT NULL DEFAULT 1)`,
          ...["INSERT", "UPDATE"].map(
            (event) => `DROP TRIGGER IF EXISTS ${table}_${event.toLowerCase()}`,
          ),
          ...["INSERT", "UPDATE"].map(
            (event) => `CREATE TRIGGER IF NOT EXISTS ${table}_${event.toLowerCase()}
        AFTER ${event} ON ${source} BEGIN
          DELETE FROM ${table} WHERE id = NEW.id AND (NEW.status IS NULL OR NEW.status NOT IN (${terminalStatusList}));
          DELETE FROM ${dirty} WHERE id = NEW.id AND (NEW.status IS NULL OR NEW.status NOT IN (${terminalStatusList}));
          INSERT INTO ${dirty}(id) SELECT NEW.id WHERE NEW.status IN (${terminalStatusList})
          ON CONFLICT(id) DO UPDATE SET generation = generation + 1;
        END`,
          ),
          `CREATE TRIGGER IF NOT EXISTS ${table}_delete AFTER DELETE ON ${source} BEGIN
        DELETE FROM ${table} WHERE id = OLD.id;
        DELETE FROM ${dirty} WHERE id = OLD.id;
      END`,
          `DELETE FROM ${table} WHERE status IS NULL OR status NOT IN (${terminalStatusList})`,
          `DELETE FROM ${dirty} WHERE NOT EXISTS (
        SELECT 1 FROM ${source} s WHERE s.id = ${dirty}.id
        AND s.status IN (${terminalStatusList})
      )`,
          `INSERT OR IGNORE INTO ${dirty}(id)
        SELECT s.id FROM ${source} s LEFT JOIN ${table} p ON p.id = s.id AND p.model_key = ''
        WHERE s.status IN (${terminalStatusList}) AND (p.id IS NULL OR p.revision != s.updated_at)`,
        ],
        "write",
      );
    })().catch((error) => {
      initialization = undefined;
      throw error;
    }));

  const projectPage = async () => {
    // SQLite extracts only the final usage evidence. Transcripts and tool payloads never leave the database.
    const page =
      await client.execute(`SELECT d.id, d.generation, s.sequence, s.agent_name, s.status, s.updated_at,
      COALESCE(json_extract(s.record, '$.completedAt'), s.updated_at) AS at,
      json_extract(s.record, '$.annotations."agent.model.id"') AS model,
      json_extract(s.record, '$.title') AS title,
      COALESCE(json_extract(s.record, '$.createdAt'), s.updated_at) AS created_at,
      (SELECT j.value FROM json_each(s.record, '$.observations') j
        WHERE json_extract(j.value, '$.name') = 'agent.invocation.finish'
        ORDER BY CAST(j.key AS INTEGER) DESC LIMIT 1) AS finish
      FROM ${dirty} d JOIN ${source} s ON s.id = d.id
      WHERE s.status IN (${terminalStatusList}) LIMIT 250`);
    const writes: InStatement[] = [];
    for (const row of page.rows) {
      const finishValue = stringValue(row.finish);
      const finish = finishValue === undefined ? undefined : JSON.parse(finishValue);
      const incomplete = finish?.attributes?.["vitehub.observation.truncated"] === true;
      const configuredModel = stringValue(row.model)?.trim() || undefined;
      const usage = incomplete
        ? undefined
        : usageNode(finish?.attributes?.["usage.record"], true, configuredModel);
      const entries: Array<[string, ConsoleInvocationUsage | undefined]> = terminalStatuses.has(
        String(row.status),
      )
        ? [["", usage]]
        : [];
      if (entries.length && usage) entries.push(...modelUsage(usage));
      writes.push({
        sql: `DELETE FROM ${table} WHERE id = ? AND EXISTS(SELECT 1 FROM ${dirty} WHERE id = ? AND generation = ?)`,
        args: [row.id!, row.id!, row.generation!],
      });
      for (const [key, projected] of entries) {
        const amount = decimal(projected?.cost?.usd);
        const [whole, fraction = ""] = amount ? decimalString(amount).split(".") : [];
        writes.push({
          sql: `INSERT OR REPLACE INTO ${table}(id,model_key,sequence,agent,at,status,model,usage,incomplete,revision,cost_whole,cost_fraction,cost_usd,estimated,title,created_at,model_names,search_text,${metrics.join(",")}) SELECT ${Array(24).fill("?").join(",")} WHERE EXISTS(SELECT 1 FROM ${dirty} d JOIN ${source} s ON s.id = d.id WHERE d.id = ? AND d.generation = ?)`,
          args: [
            row.id!,
            key,
            row.sequence!,
            row.agent_name!,
            row.at!,
            row.status!,
            projected?.model ?? configuredModel ?? null,
            projected ? JSON.stringify({ ...projected, calls: undefined }) : null,
            incomplete ? 1 : 0,
            row.updated_at!,
            whole ?? null,
            amount ? fraction : null,
            projected?.cost?.usd ?? null,
            projected?.cost?.estimated ? 1 : 0,
            row.title ?? null,
            row.created_at!,
            JSON.stringify(
              projected
                ? [...modelUsage(projected).keys()]
                : configuredModel
                  ? [configuredModel]
                  : [],
            ),
            [row.id, row.agent_name, row.title]
              .filter((value) => value != null)
              .join("\n")
              .toLowerCase(),
            ...metrics.map((metric) => projected?.[metric] ?? null),
            row.id!,
            row.generation!,
          ],
        });
      }
      // If another writer changed this invocation during projection, its newer generation stays queued.
      writes.push({
        sql: `DELETE FROM ${dirty} WHERE id = ? AND generation = ?`,
        args: [row.id!, row.generation!],
      });
    }
    if (writes.length) await client.batch(writes, "write");
    return page.rows.length;
  };
  const rebuild = async () => {
    await initialize();
    if (!backfill)
      backfill = (async () => {
        while (await projectPage()) {
          // Yield to HTTP requests, cancellation, and the bounded first-response timer.
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      })().finally(() => {
        backfill = undefined;
      });
    await backfill;
  };

  return {
    rebuild,
    async query(options = {}) {
      const { window, now, to, from, after } = usageQueryWindow(options);
      await initialize();
      // Large historical archives rebuild in the background. Never claim complete totals while queued.
      const rebuilding = rebuild();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          rebuilding,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 100);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      const resolution = window.bucket;
      const bucket =
        resolution === "hour"
          ? "strftime('%Y-%m-%dT%H:00:00.000Z', at)"
          : "strftime('%Y-%m-%dT00:00:00.000Z', at)";
      const filter = `status IN (${terminalStatusList}) AND at >= ? AND at <= ?${options.agentName ? " AND agent = ?" : ""}${options.status ? " AND status = ?" : ""}${options.search ? " AND instr(search_text, ?) > 0" : ""}`;
      const search = options.search?.toLowerCase();
      const args = [
        from,
        to,
        ...(options.agentName ? [options.agentName] : []),
        ...(options.status ? [options.status] : []),
        ...(search ? [search] : []),
      ];
      const aggregate = (group: string, modelRows = false): InStatement => ({
        // Group equal decimal costs before multiplication in JS bigint. SQLite REAL must not round money.
        sql: `SELECT ${group} AS grouping, cost_usd AS cost,
          MAX(estimated) AS estimated,
          COUNT(*) AS count, COUNT(usage) AS recorded, MAX(incomplete) AS incomplete,
          ${metrics.map((metric) => `SUM(${metric}) AS ${metric}, COUNT(${metric}) AS ${metric}Count`).join(",")}
          FROM ${table} WHERE model_key ${modelRows ? "!=" : "="} '' AND ${filter}
          GROUP BY grouping, cost`,
        args,
      });
      const results = await client.batch(
        [
          aggregate(bucket),
          aggregate("model_key", true),
          aggregate("agent"),
          {
            sql: `SELECT * FROM ${table} WHERE model_key = '' AND ${filter}${after ? " AND (at < ? OR (at = ? AND id < ?))" : ""} ORDER BY at DESC, id DESC LIMIT 51`,
            args: [...args, ...(after ? [after.at, after.at, after.id] : [])],
          },
          {
            sql: `SELECT * FROM ${table} WHERE model_key = '' AND ${filter} AND cost_usd IS NOT NULL ORDER BY length(cost_whole) DESC, cost_whole DESC, cost_fraction DESC, sequence DESC LIMIT 10`,
            args,
          },
          `SELECT COUNT(*) AS count FROM ${dirty} d JOIN ${source} s ON s.id = d.id
          WHERE s.status IN (${terminalStatusList})`,
        ],
        "read",
      );
      const [periods, models, agents, runs, expensive, remaining] = results;
      if (!periods || !models || !agents || !runs || !expensive || !remaining)
        throw viteHubErrorDiagnostics.VITE_HUB_R0119({
          message: "Expected six usage query results",
        });
      const incomplete = Number(remaining.rows[0]?.count) > 0;
      const groups = (rows: Row[]) => {
        const result = new Map<string, UsageTotal>();
        for (const row of rows) {
          const key = String(row.grouping);
          const total = result.get(key) ?? emptyTotals();
          const count = Number(row.count);
          total.invocations += count;
          for (const metric of metrics) {
            total[metric] += Number(row[metric] ?? 0);
            total[`${metric}Available`] &&= Number(row[`${metric}Count`]) === count;
          }
          const cost = decimal(stringValue(row.cost));
          total.costAvailable &&= cost !== undefined;
          total.costEstimated ||= Number(row.estimated) === 1;
          if (cost) {
            total.pricedInvocations += count;
            total.cost = addDecimal(total.cost, { ...cost, units: cost.units * BigInt(count) });
          }
          result.set(key, total);
        }
        return result;
      };
      const periodGroups = groups(periods.rows);
      const totals =
        groups(periods.rows.map((row) => ({ ...row, grouping: "total" }))).get("total") ??
        emptyTotals();
      const buckets = [];
      const start = new Date(from);
      if (resolution === "hour") start.setUTCMinutes(0, 0, 0);
      else start.setUTCHours(0, 0, 0, 0);
      for (
        let time = start.valueOf();
        time <= now.valueOf();
        time += resolution === "hour" ? 3_600_000 : 86_400_000
      ) {
        const start = new Date(time).toISOString();
        buckets.push({
          start,
          ...publicTotals(periodGroups.get(start) ?? emptyTotals(), !incomplete),
          models: [],
        });
      }
      const run = (row: Row) => ({
        id: String(row.id),
        agent: String(row.agent),
        status: String(row.status),
        at: String(row.at),
        ...(row.usage ? { usage: JSON.parse(String(row.usage)) } : {}),
      });
      const recorded = periods.rows.reduce((sum, row) => sum + Number(row.recorded), 0);
      return {
        available: totals.invocations > 0,
        costAvailable: totals.costAvailable,
        costSupported: totals.pricedInvocations > 0,
        partial:
          incomplete ||
          recorded < totals.invocations ||
          (totals.invocations > 0 && !totals.totalTokensAvailable) ||
          periods.rows.some((row) => Number(row.incomplete)),
        projection: { complete: !incomplete, pending: Number(remaining.rows[0]?.count) },
        from,
        to,
        resolution,
        generatedAt: new Date().toISOString(),
        buckets,
        totals: publicTotals(totals, !incomplete),
        models: [...groups(models.rows)].map(([model, total]) => ({
          model,
          ...publicTotals(total, !incomplete),
        })),
        agents: [...groups(agents.rows)].map(([agent, total]) => ({
          agent,
          ...publicTotals(total, !incomplete),
        })),
        sessionCount: totals.invocations,
        sessions: runs.rows.slice(0, 50).map((row) => ({
          ...usageSession(
            {
              id: String(row.id),
              agentName: String(row.agent),
              title: stringValue(row.title),
              status: String(row.status),
              createdAt: String(row.created_at),
              completedAt: String(row.at),
              updatedAt: String(row.revision),
            },
            row.usage ? JSON.parse(String(row.usage)) : undefined,
          ),
          models: JSON.parse(String(row.model_names)),
        })),
        runs: runs.rows.slice(0, 50).map(run),
        ...(runs.rows.length > 50 ? { cursor: usageCursor(options, to, run(runs.rows[49]!)) } : {}),
        expensive: expensive.rows.map(run),
      };
    },
  };
}
