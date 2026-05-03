import type { WorkspacePublisher } from "../types.ts"

export interface VirtualModulePublisherOptions {
  id: string
  includeContent?: boolean
}

export function virtualModule(options: VirtualModulePublisherOptions): WorkspacePublisher {
  return {
    name: `virtual-module:${options.id}`,
    clientSafe: options.includeContent === true,
    async publish() {},
  }
}
