import { useRuntimeConfig } from 'nitro/runtime-config'
import type { AgentSandboxConfig } from '../module-types'
import { setSandboxRuntimeConfig } from './state'

const sandboxNitroPlugin = () => {
  const runtimeConfig = useRuntimeConfig() as { sandbox?: false | AgentSandboxConfig }
  setSandboxRuntimeConfig(runtimeConfig.sandbox)
}

export default sandboxNitroPlugin
