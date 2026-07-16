import type { ProviderJsonRecord } from "./provider-output-config.ts"

interface VercelConfigJson extends ProviderJsonRecord {
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

interface NodeFunctionConfig extends ProviderJsonRecord {
  handler: "index.mjs"
  launcherType: "Nodejs"
  runtime: "nodejs22.x"
  shouldAddHelpers: false
  supportsResponseStreaming: true
}

export function createNodeFunctionConfig(extra: ProviderJsonRecord = {}): NodeFunctionConfig {
  return {
    handler: "index.mjs",
    launcherType: "Nodejs",
    runtime: "nodejs22.x",
    shouldAddHelpers: false,
    supportsResponseStreaming: true,
    ...extra,
  }
}
