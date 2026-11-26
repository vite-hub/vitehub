import { getConsoleAgentDefinition, getConsoleAgents } from "../../console/runtime/server/agents.ts";
import { getConsoleInvocations, readConsoleJournalUsage } from "../../console/runtime/server/invocations.ts";
import { withConsoleAccess, type ConsoleAccessRoute } from "../../console/runtime/server/access.ts";
import { assertConsoleRequest, consoleRequestURL, consoleRoute } from "../../console/runtime/server/request.ts";
import { consoleHttpError } from "../../console/runtime/server/http-error.ts";
import { createUsageSummary, parseConsoleUsageStatus, parseConsoleUsageWindow, usageQueryWindow } from "./usage.ts";

import type { ConsoleRequestEvent, ConsoleRoute } from "../../console/runtime/server/request.ts";
import { viteHubErrorDiagnostics } from "../../error-diagnostics.ts";

function pricedUsageAgents(names: readonly string[]): string[] {
  return names.filter((name) => {
    const capabilities = getConsoleAgentDefinition(name, "inspect")?.capabilities;
    return (
      Array.isArray(capabilities) &&
      capabilities.some((capability) => capability?.id === "usage" && capability.metadata?.pricing === true)
    );
  });
}

function usageQuery(event: ConsoleRequestEvent) {
  assertConsoleRequest(event);
  const query = consoleRequestURL(event).searchParams;
  const agentName = query.get("agent")?.trim() || undefined;
  if (agentName && agentName.length > 512) {
    throw consoleHttpError(400, viteHubErrorDiagnostics.VITE_HUB_R0070({ message: "Invalid Agent name" }));
  }
  const windowValue = query.get("window");
  const window = windowValue === null ? "30d" : parseConsoleUsageWindow(windowValue);
  if (!window) {
    throw consoleHttpError(400, viteHubErrorDiagnostics.VITE_HUB_R0071({ message: "Invalid usage window" }));
  }
  const statusValue = query.get("status");
  const status = statusValue === null ? undefined : parseConsoleUsageStatus(statusValue);
  if (statusValue !== null && !status) {
    throw consoleHttpError(400, viteHubErrorDiagnostics.VITE_HUB_R0072({ message: "Invalid usage status" }));
  }
  const search = query.get("search")?.trim() || undefined;
  if (search && search.length > 512) {
    throw consoleHttpError(400, viteHubErrorDiagnostics.VITE_HUB_R0072({ message: "Invalid usage search" }));
  }
  const cursor = query.get("cursor") ?? undefined;
  const costConfigured = pricedUsageAgents(agentName ? [agentName] : getConsoleAgents()).length > 0;
  return { costConfigured, options: { agentName, cursor, window, status, search } };
}

const usageHandler = async (event: ConsoleRequestEvent): Promise<Record<string, unknown>> => {
  const { costConfigured, options } = usageQuery(event);
  const invocations = getConsoleInvocations();
  const result =
    (await readConsoleJournalUsage(invocations, options, usageQueryWindow(options))) ??
    (await createUsageSummary(invocations, options));
  return { ...result, costSupported: costConfigured || result.costSupported };
};

export const readConsoleUsage: ConsoleAccessRoute<typeof usageHandler> = withConsoleAccess(usageHandler, { section: "usage" });

const consoleUsageRoute: ConsoleRoute = consoleRoute(readConsoleUsage);
export default consoleUsageRoute;
