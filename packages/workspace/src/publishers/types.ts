import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import type { WorkspacePublisher } from "../types.ts"

export interface TypesPublisherOptions {
  path?: string
}

export function types(options: TypesPublisherOptions = {}): WorkspacePublisher {
  return {
    name: "types",
    async publish(ctx) {
      const path = resolve(ctx.rootDir, options.path || `.vitehub/workspaces/${ctx.workspace.name}.d.ts`)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, `declare module "virtual:vitehub/workspaces/${ctx.workspace.name}" {\n  const manifest: { name: ${JSON.stringify(ctx.workspace.name)}, entries: Array<{ path: string, type: "file" | "directory" }> }\n  export default manifest\n}\n`)
    },
  }
}
