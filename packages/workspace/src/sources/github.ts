import { WorkspaceError } from "../errors.ts"

import type { WorkspaceSource } from "../types.ts"

export interface GitHubSourceOptions {
  repo: string
  ref?: string
  root?: string
  auth?: string
}

export function github(options: GitHubSourceOptions): WorkspaceSource {
  return {
    name: "github",
    async getKeys() {
      throw new WorkspaceError(`[vitehub] source.github(${JSON.stringify(options.repo)}) is typed for provider compatibility but is not implemented by the local v1 provider.`)
    },
    async getItem() {
      throw new WorkspaceError(`[vitehub] source.github(${JSON.stringify(options.repo)}) is typed for provider compatibility but is not implemented by the local v1 provider.`)
    },
  }
}
