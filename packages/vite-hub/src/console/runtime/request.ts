import type { AgentInvocationSummary } from "vite-hub/agent";

export type ConsoleSession = {
  agentName?: string;
  id: string;
  invocations: AgentInvocationSummary[];
  updatedAt: string;
};

export function groupConsoleSessions(invocations: AgentInvocationSummary[]): ConsoleSession[] {
  const grouped = new Map<string, ConsoleSession>();
  for (const invocation of invocations) {
    const id = invocation.threadId || invocation.id;
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
