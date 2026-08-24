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

export type AgentInvocationStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface AgentInvocationListItem {
  agent?: string;
  context?: string;
  description?: string;
  id: string;
  project?: string;
  provider?: string;
  startedAt?: string;
  status: AgentInvocationStatus;
  title: string;
  updatedAt?: string;
}

export type AgentInspectionValue =
  | boolean
  | number
  | string
  | null
  | readonly AgentInspectionValue[]
  | { readonly [key: string]: AgentInspectionValue };

export interface AgentInvocationConfiguration {
  agent?: {
    name?: string;
    version?: string;
  };
  capabilities?: readonly {
    id: string;
    metadata?: Readonly<Record<string, AgentInspectionValue>>;
  }[];
  driver?: {
    kind?: string;
    model?: {
      id?: string;
      provider?: string;
    };
    provider?: string;
  };
  instructions?: readonly string[];
  runtime?: {
    name?: string;
  };
  tools?: readonly { name: string }[];
  workspace?: {
    mode?: string;
    name?: string;
    sources?: readonly string[];
  };
}

export interface AgentInvocationView {
  agentName?: string;
  annotations?: Record<string, boolean | number | string | null>;
  cancelledAt?: string;
  completedAt?: string;
  configuration?: AgentInvocationConfiguration;
  createdAt: string;
  error?: { message: string; name?: string };
  failedAt?: string;
  id: string;
  observations: readonly import("@vite-hub/runtime").TraceEventLogEntry[];
  origin?: string;
  startedAt?: string;
  status: AgentInvocationStatus;
  threadId?: string;
  title?: string;
  traceId: string;
  updatedAt: string;
}
