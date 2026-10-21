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

export type AgentInspectionValue =
  | boolean
  | number
  | string
  | null
  | readonly AgentInspectionValue[]
  | { readonly [key: string]: AgentInspectionValue };

export interface AgentToolInspection {
  /** Capability that registered this tool, when known. */
  capabilityId?: string;
  description?: string;
  /** Iconify icon name declared by the tool, for example `i-lucide-database`. */
  icon?: string;
  inputSchema?: AgentInspectionValue;
  /** Short past-tense label from the tool's `title`, for example `Searched meals`. */
  label?: string;
  name: string;
  mcp?: { server: string; name: string };
  outputSchema?: AgentInspectionValue;
}
