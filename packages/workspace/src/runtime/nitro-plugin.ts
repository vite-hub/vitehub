import { definePlugin as defineNitroPlugin } from "nitro"
import { useRuntimeConfig } from "nitro/runtime-config"

import workspaceRegistry from "#vitehub-workspace-registry"
import workspaceAssetsRegistry from "#vitehub-workspace-assets-registry"

import { setWorkspaceRuntimeAssetsRegistry, setWorkspaceRuntimeConfig, setWorkspaceRuntimeRegistry } from "./state.ts"

const workspaceNitroPlugin: ReturnType<typeof defineNitroPlugin> = defineNitroPlugin(() => {
  const runtimeConfig = useRuntimeConfig()
  setWorkspaceRuntimeConfig(runtimeConfig.workspace || false)
  setWorkspaceRuntimeRegistry(workspaceRegistry)
  setWorkspaceRuntimeAssetsRegistry(workspaceAssetsRegistry)
})

export default workspaceNitroPlugin
