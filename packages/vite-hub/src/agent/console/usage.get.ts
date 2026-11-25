import { getConsoleAgentDefinition, getConsoleAgents } from "../../console/runtime/server/agents.ts";
import { getConsoleInvocations, getConsoleUsageIndex, readConsoleJournalUsage } from "../../console/runtime/server/invocations.ts";
import { withConsoleAccess, type ConsoleAccessRoute } from "../../console/runtime/server/access.ts";
import { assertConsoleRequest, consoleRequestURL, consoleRoute } from "../../console/runtime/server/request.ts";
import { consoleHttpError } from "../../console/runtime/server/http-error.ts";
import { createUsageSummary, parseConsoleUsageStatus, parseConsoleUsageWindow, usageQueryWindow } from "./usage.ts";

import type { ConsoleRequestEvent, ConsoleRoute } from "../../console/runtime/server/request.ts";
import type { AgentInvocations } from "@vite-hub/agent";
import { viteHubErrorDiagnostics } from "../../error-diagnostics.ts";

const caches = new WeakMap<
  AgentInvocations,
  Map<string, { expiresAt: number; value: Record<string, unknown> }>
>();

const requests = new WeakMap<AgentInvocations, Map<string, symbol>>();

async function cached(
  invocations: AgentInvocations,
  key: string,
  resolve: () => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const cache = caches.get(invocations) ?? new Map();
  caches.set(invocations, cache);
  const now = Date.now();
  for (const [cachedKey, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(cachedKey);
  }
  const current = cache.get(key);
  if (current && current.expiresAt > now) return current.value;
  // Cache completed responses only. Worker requests cannot share pending D1 I/O.
  const active = requests.get(invocations) ?? new Map<string, symbol>();
  requests.set(invocations, active);
  const token = Symbol();
  active.set(key, token);
  try {
    const value = await resolve();
    if (active.get(key) === token) {
      cache.set(key, { expiresAt: Date.now() + 5_000, value });
    }
    return value;
  } finally {
    if (active.get(key) === token) active.delete(key);
  }
}

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
  return cached(
    invocations,
    JSON.stringify([options.agentName ?? null, options.window, options.cursor, options.status, options.search]),
    async () => {
      const index = getConsoleUsageIndex(invocations);
      if (index) {
        await invocations.list({ limit: 1 }); // Initialize the owning invocation store before projecting it.
        const result = await index.query(options);
        return { ...result, costSupported: costConfigured || result.costSupported === true };
      }
      const result = await createUsageSummary(invocations, options);
      return { ...result, costSupported: costConfigured || result.costSupported === true };
    },
  );
};

const journalUsageHandler = async (event: ConsoleRequestEvent): Promise<Record<string, unknown>> => {
  const { costConfigured, options } = usageQuery(event);
  const invocations = getConsoleInvocations();
  const result =
    (await readConsoleJournalUsage(invocations, options, usageQueryWindow(options))) ??
    (await createUsageSummary(invocations, options));
  return { ...result, costSupported: costConfigured || result.costSupported };
};

/** The usage summary, for the `usage.get` operation. */
export const readConsoleUsage: ConsoleAccessRoute<typeof usageHandler> = withConsoleAccess(usageHandler, { section: "usage" });

/**
 * The usage summary that the journal adds up at request time, for the `invocations.usage` operation. It has the same
 * input and answer as `usage.get`, keeps no copy, and caches nothing.
 */
export const readConsoleJournalUsageRoute: ConsoleAccessRoute<typeof journalUsageHandler> = withConsoleAccess(journalUsageHandler, { section: "usage" });

/** `GET <base>/_vitehub/console/usage` */
const consoleUsageRoute: ConsoleRoute = consoleRoute(readConsoleUsage);
export default consoleUsageRoute;
