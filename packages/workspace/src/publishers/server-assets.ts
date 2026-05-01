import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import type { WorkspacePublisher } from "../types.ts"

export interface ServerAssetsPublisherOptions {
  dir: string
}

export function serverAssets(options: ServerAssetsPublisherOptions): WorkspacePublisher {
  return {
    name: "server-assets",
    async publish(ctx) {
      for (const entry of await ctx.store.glob("**/*")) {
        const file = await ctx.store.readFile(entry.path)
        if (!file) continue
        const out = resolve(ctx.rootDir, options.dir, entry.path)
        await mkdir(dirname(out), { recursive: true })
        await writeFile(out, file.content)
      }
    },
  }
}
