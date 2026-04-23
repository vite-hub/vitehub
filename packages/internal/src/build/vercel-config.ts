export interface VercelConfigJson {
  routes: Array<{ handle: string } | { dest: string, src: string }>
  version: 3
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

export interface NodeFunctionConfig {
  handler: "index.mjs"
  launcherType: "Nodejs"
  runtime: "nodejs24.x"
  shouldAddHelpers: false
  supportsResponseStreaming: true
  [key: string]: unknown
}

export function createNodeFunctionConfig(extra: Record<string, unknown> = {}): NodeFunctionConfig {
  return {
    handler: "index.mjs",
    launcherType: "Nodejs",
    runtime: "nodejs24.x",
    shouldAddHelpers: false,
    supportsResponseStreaming: true,
    ...extra,
  }
}
