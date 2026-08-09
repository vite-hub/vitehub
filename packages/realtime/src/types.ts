import type { WorkspaceSnapshot } from "@vite-hub/workspace"

export interface RealtimeDefinition {
  auth?: boolean
  document: {
    workspace: string
  }
  history?: {
    checkpoint: true | { message?: string }
  }
}

export interface RealtimeCheckpoint {
  content: string
  snapshot: WorkspaceSnapshot
}

export interface DiscoveredRealtimeDefinition {
  handler: string
  name: string
  source: "server-realtime"
}

export interface RealtimeModuleOptions {
  authority?: "auto" | "cloudflare" | "memory"
  projectRoot?: string
}

export interface RealtimePerson {
  clientId: number
  color: string
  id: string
  image?: string
  name: string
}

export type RealtimeWorkspaceChange =
  | { operation: "create" | "delete" | "update", path: string }
  | { operation: "move", from: string, to: string }

export type RealtimeRegistry = Record<string, () => Promise<{ default: RealtimeDefinition }>>
