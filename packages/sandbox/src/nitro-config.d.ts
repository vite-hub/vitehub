import type { AgentSandboxConfig } from './module-types'

declare module 'nitro/types' {
  interface NitroConfig {
    sandbox?: false | AgentSandboxConfig
  }

  interface NitroRuntimeConfig {
    sandbox?: false | AgentSandboxConfig
  }
}

declare module 'nitropack/types' {
  interface NitroConfig {
    sandbox?: false | AgentSandboxConfig
  }

  interface NitroRuntimeConfig {
    sandbox?: false | AgentSandboxConfig
  }
}

export {}
