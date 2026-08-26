import type { AgentInvocationConfiguration, AgentInvocationView } from "./types.ts";
import { isSafeExternalUrl } from "./internal/url.ts";

export interface AgentInvocationDisplaySource {
  agentName?: string;
  annotations?: AgentInvocationView["annotations"];
  channelId?: string;
  configuration?: AgentInvocationConfiguration;
  id: string;
  origin?: string;
  threadId?: string;
  title?: string;
}

function annotation(source: AgentInvocationDisplaySource, key: string): string | undefined {
  const value = source.annotations?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function agentInvocationTitle(source: AgentInvocationDisplaySource): string {
  return (
    source.title ?? annotation(source, "github.title") ?? source.agentName ?? "Agent Invocation"
  );
}

export function agentInvocationContext(source: AgentInvocationDisplaySource): string {
  const repository = annotation(source, "github.repository");
  const pullRequest = source.annotations?.["github.pullRequest"];
  if (repository && (typeof pullRequest === "string" || typeof pullRequest === "number")) {
    return `${repository} · PR #${pullRequest}`;
  }
  return source.threadId ?? source.origin ?? source.channelId ?? source.id;
}

export function agentInvocationProject(source: AgentInvocationDisplaySource): string {
  const repository = annotation(source, "github.repository");
  return (
    repository?.split("/").at(-1) ??
    source.configuration?.workspace?.name ??
    source.agentName ??
    "Workspace"
  );
}

export function agentInvocationExternalUrl(
  source: AgentInvocationDisplaySource,
): string | undefined {
  const value = annotation(source, "github.url");
  return value && isSafeExternalUrl(value) ? value : undefined;
}
