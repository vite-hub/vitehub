import type { AgentSandboxConfig } from '../module-types'

let sandboxConfig: false | AgentSandboxConfig | undefined

export function getSandboxRuntimeConfig() {
  return sandboxConfig
}

export function setSandboxRuntimeConfig(config: false | AgentSandboxConfig | undefined) {
  sandboxConfig = config
}

export function resetSandboxRuntimeState() {
  sandboxConfig = undefined
}
