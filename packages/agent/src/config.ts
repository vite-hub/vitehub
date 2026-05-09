import type { AgentModuleOptions, ResolvedAgentModuleOptions } from "./types.ts"

const defaultAgentRoute = "/agents/[agent]"

export function normalizeAgentOptions(options: AgentModuleOptions | false | undefined): false | ResolvedAgentModuleOptions {
  if (options === false) {
    return false
  }

  return {
    execution: options?.execution || "inline",
    imports: options?.imports !== false,
    integrations: {
      sandbox: options?.integrations?.sandbox ?? "auto",
      workflow: options?.integrations?.workflow ?? "auto",
    },
    providers: {
      model: {
        provider: options?.providers?.model?.provider || "vercel-ai-sdk",
      },
      sandbox: {
        provider: options?.providers?.sandbox?.provider || "auto",
      },
      scheduler: {
        provider: options?.providers?.scheduler?.provider || "auto",
      },
      state: {
        provider: options?.providers?.state?.provider || "auto",
      },
    },
    route: options?.route === true ? defaultAgentRoute : options?.route ?? false,
    runtime: options?.runtime || "auto",
  }
}
