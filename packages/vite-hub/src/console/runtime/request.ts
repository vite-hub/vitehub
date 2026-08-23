import type { AgentInvocationSummary } from "vite-hub/agent";

export const CONSOLE_SESSION_LOOKUP_PAGE_LIMIT = 3;

export type ConsoleSession = {
  agentName?: string;
  id: string;
  invocations: AgentInvocationSummary[];
  updatedAt: string;
};

export function shouldLoadRequestedConsoleSession(options: {
  cursor?: string;
  isLoadingMore: boolean;
  loadedPages: number;
  requestedSession?: string;
  sessions: readonly ConsoleSession[];
}): boolean {
  return Boolean(
    options.requestedSession &&
      !options.sessions.some((session) => session.id === options.requestedSession) &&
      options.cursor &&
      !options.isLoadingMore &&
      options.loadedPages < CONSOLE_SESSION_LOOKUP_PAGE_LIMIT,
  );
}

export function groupConsoleSessions(invocations: AgentInvocationSummary[]): ConsoleSession[] {
  const grouped = new Map<string, ConsoleSession>();
  for (const invocation of invocations) {
    const id = invocation.threadId
      ? `${invocation.agentName?.length || 0}:${invocation.agentName || ""}:${invocation.threadId}`
      : invocation.id;
    const session = grouped.get(id);
    if (session) {
      session.invocations.push(invocation);
      if (Date.parse(invocation.updatedAt) > Date.parse(session.updatedAt)) {
        session.updatedAt = invocation.updatedAt;
      }
    } else {
      grouped.set(id, {
        agentName: invocation.agentName,
        id,
        invocations: [invocation],
        updatedAt: invocation.updatedAt,
      });
    }
  }
  return [...grouped.values()]
    .map((session) => ({
      ...session,
      invocations: session.invocations.toSorted(
        (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
      ),
    }))
    .toSorted((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

export function createConsoleRequest() {
  return async (path: string, options: { signal?: AbortSignal }): Promise<unknown> => {
    const response = await fetch(path, { signal: options.signal });
    if (!response.ok) throw new Error(`Console request failed with status ${response.status}.`);
    const result = await response.json();
    return result;
  };
}
