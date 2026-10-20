import type { AgentInspectionValue, AgentToolInspection } from "@vite-hub/ui";

export type { AgentInspectionValue, AgentToolInspection };

export type AgentInvocationStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface AgentInvocationListItem {
  channel?: string;
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

export interface AgentInvocationConfiguration {
  agent?: {
    name?: string;
    version?: string;
  };
  capabilities?: readonly {
    id: string;
    inspection?: {
      label: string;
      truncated?: boolean;
      view?: import("@json-render/core").Spec;
      state?: Readonly<Record<string, AgentInspectionValue>>;
    };
    metadata?: Readonly<Record<string, AgentInspectionValue>>;
  }[];
  channels?: readonly {
    id: string;
    kind: string;
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
  truncated?: boolean;
  runtime?: {
    name?: string;
  };
  tools?: readonly AgentToolInspection[];
  workspace?: {
    mode?: string;
    name?: string;
    sources?: readonly (string | { id: string; repository?: string })[];
  };
}

export interface AgentInvocationView {
  agentName?: string;
  annotations?: Record<string, boolean | number | string | null>;
  cancelledAt?: string;
  completedAt?: string;
  configuration?: AgentInvocationConfiguration;
  createdAt: string;
  error?: import("@vite-hub/runtime").RuntimeDiagnosticError;
  failedAt?: string;
  id: string;
  observations: readonly import("@vite-hub/runtime").TraceEventLogEntry[];
  observationsTruncated?: boolean;
  origin?: string;
  startedAt?: string;
  status: AgentInvocationStatus;
  threadId?: string;
  title?: string;
  traceId: string;
  updatedAt: string;
  usage?: {
    totalTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
    cost?: { display?: string; estimated?: boolean; source?: string };
  };
}
