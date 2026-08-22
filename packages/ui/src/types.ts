import type { UIDataTypes, UIMessage, UITools } from "ai";

export type ViteHubUIMessage<
  Metadata = unknown,
  DataParts extends UIDataTypes = UIDataTypes,
  Tools extends UITools = UITools,
> = UIMessage<Metadata, DataParts, Tools>;

export interface ViteHubUISession<Message extends UIMessage = UIMessage> {
  createdAt?: Date | string;
  id: string;
  messages: readonly Message[];
  metadata?: unknown;
  title?: string;
  updatedAt?: Date | string;
}

export interface AgentInvocationView {
  agentName?: string;
  annotations?: Record<string, boolean | number | string | null>;
  completedAt?: string;
  createdAt: string;
  error?: { message: string; name?: string };
  failedAt?: string;
  id: string;
  observations: readonly import("@vite-hub/runtime").TraceEventLogEntry[];
  startedAt?: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  traceId: string;
  updatedAt: string;
}
