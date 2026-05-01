import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import { resolveInside } from "../path.ts"

import type { WorkspacePublisher } from "../types.ts"

export interface ServerAssetsPublisherOptions {
  dir: string
}

export function serverAssets(options: ServerAssetsPublisherOptions): WorkspacePublisher {
  return {
    name: "server-assets",
    async publish(ctx) {
      const outRoot = resolve(ctx.rootDir, options.dir)
      for (const entry of await ctx.store.glob("**/*")) {
        const file = await ctx.store.readFile(entry.path)
        if (!file) continue
        const out = resolveInside(outRoot, entry.path)
        await mkdir(dirname(out), { recursive: true })
        await writeFile(out, file.content)
      }
    },
  }
}
