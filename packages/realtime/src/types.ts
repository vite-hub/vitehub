export interface RealtimeDefinition {
  auth?: boolean
  document: {
    format: "tiptap-markdown"
    workspace: string
  }
  engine: "yjs"
  history?: {
    checkpoint: true | { message?: string }
  }
}

export interface DiscoveredRealtimeDefinition {
  handler: string
  name: string
  source: "server-realtime"
}

export interface RealtimeModuleOptions {
  projectRoot?: string
}

export interface RealtimePerson {
  color: string
  id: string
  image?: string
  name: string
}

export type RealtimeWorkspaceChange =
  | { operation: "create" | "delete" | "update", path: string }
  | { operation: "move", from: string, to: string }

export type RealtimeRegistry = Record<string, () => Promise<{ default: RealtimeDefinition }>>
