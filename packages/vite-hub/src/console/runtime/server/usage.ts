import type { AgentInvocations } from "@vite-hub/agent";
import {
  agentUsagePeriod,
  agentUsageRow,
  matchesAgentUsageQuery,
  summarizeAgentUsage,
  type AgentUsagePeriod,
  type AgentUsageQuery,
  type AgentUsageRow,
  type AgentUsageSummary,
} from "@vite-hub/agent/usage";
import { viteHubErrorDiagnostics } from "../../../error-diagnostics.ts";
import { consoleHttpError } from "./http-error.ts";

export {
  agentUsageCursor as usageCursor,
  invocationUsage,
  parseAgentUsageStatus as parseConsoleUsageStatus,
  parseAgentUsageWindow as parseConsoleUsageWindow,
} from "@vite-hub/agent/usage";

export type { AgentUsageQuery as UsageQuery } from "@vite-hub/agent/usage";

/** Keep every page inside the first request's date window and filter scope. */
export function usageQueryWindow(options: AgentUsageQuery): AgentUsagePeriod {
  const period = agentUsagePeriod(options);
  if (!("problem" in period)) return period;
  if (period.problem === "cursor") {
    throw consoleHttpError(400, viteHubErrorDiagnostics.VITE_HUB_R0115({ message: "Invalid usage cursor" }));
  }
  const message = period.problem === "window" ? "Invalid usage window" : "Invalid usage timestamp";
  throw consoleHttpError(400, viteHubErrorDiagnostics.VITE_HUB_R0072({ message }));
}

export async function createUsageSummary(
  invocations: AgentInvocations,
  options: AgentUsageQuery = {},
): Promise<AgentUsageSummary> {
  const period = usageQueryWindow(options);
  const rows: AgentUsageRow[] = [];
  let cursor: string | undefined;
  do {
    const page = await invocations.list({
      ...(options.agentName ? { agentName: options.agentName } : {}),
      ...(cursor === undefined ? {} : { cursor }),
      limit: 100,
    });
    const selected = page.invocations.filter((summary) =>
      matchesAgentUsageQuery(agentUsageRow(summary), options, period),
    );
    const records = await Promise.all(selected.map((summary) => invocations.get(summary.id)));
    for (const [index, record] of records.entries()) {
      const summary = selected[index];
      if (summary) rows.push(agentUsageRow(record ?? summary));
    }
    cursor = page.cursor;
  } while (cursor !== undefined);
  return summarizeAgentUsage(rows, options, period);
}
