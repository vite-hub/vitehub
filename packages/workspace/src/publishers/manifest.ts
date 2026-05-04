import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import type { WorkspacePublisher } from "../types.ts"

export interface ManifestPublisherOptions {
  path?: string
}

export function manifest(options: ManifestPublisherOptions = {}): WorkspacePublisher {
  return {
    name: "manifest",
    async publish(ctx) {
      const path = resolve(ctx.rootDir, options.path || `.vitehub/workspaces/${ctx.workspace.name}.json`)
      const entries = await ctx.store.list("", { recursive: true })
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, `${JSON.stringify({ name: ctx.workspace.name, entries }, null, 2)}\n`)
    },
  }
}
