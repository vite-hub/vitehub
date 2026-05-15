declare global {
  interface ViteHubWorkspaceNameMap {
    "docs": true
  }

  interface ViteHubWorkspaceAssetMap {
    __vitehub_no_workspace_assets__?: never
  }
}

export {}
