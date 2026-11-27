import { resolve } from "node:path"

interface VercelConfigJson {
  routes: Array<{ handle: string } | { dest: string, src: string }>
  version: 3
}

export function createDefaultVercelOutputRoot(rootDir: string): string {
  return resolve(rootDir, ".vercel", "output")
}

export function createVercelConfigJson(): VercelConfigJson {
  return {
    routes: [
      { handle: "filesystem" },
      { src: "/(.*)", dest: "/__server" },
    ],
    version: 3,
  }
}

interface NodeFunctionConfig {
  handler: "index.mjs"
  launcherType: "Nodejs"
  runtime: "nodejs24.x"
  shouldAddHelpers: false
  supportsResponseStreaming: true
}

export function createNodeFunctionConfig(extra: object = {}): NodeFunctionConfig {
  return {
    handler: "index.mjs",
    launcherType: "Nodejs",
    runtime: "nodejs24.x",
    shouldAddHelpers: false,
    supportsResponseStreaming: true,
    ...extra,
  }
}
