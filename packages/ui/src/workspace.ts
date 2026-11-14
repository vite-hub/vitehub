// Outside the root barrel, so chat pages never load CodeMirror or xterm. Run the app with `useWebContainer()` from
// `@vite-hub/web-container/vue`, then pass its state to these parts.
export { BrowserSupportNotice, detectUnsupportedBrowser, type UnsupportedBrowser } from "./workspace/browser-support-notice.ts";
export {
  ConnectPanel,
  connectProviderLabel,
  ConnectProviderRow,
  type ConnectProviderState,
  type ConnectProviderStatus,
} from "./workspace/connect-panel.ts";
export { useConnectStore, type ConnectStore, type UseConnectStoreOptions } from "./workspace/connect-store.ts";
export {
  PlaygroundContainer,
  usePlaygroundDevice,
  type PlaygroundContainerTemplate,
  type PlaygroundContext,
  type PlaygroundDevice,
} from "./workspace/playground-container.ts";
export { bootChecklist, WorkspaceBootStatus, type BootStepState, type BootStepView } from "./workspace/workspace-boot-status.ts";
// The checklist formats its step times with the shared duration formatter. It stays public under its first name.
export { formatDuration as formatElapsed } from "./internal/format.ts";
export { WorkspaceEditor } from "./workspace/workspace-editor.ts";
export { WorkspaceFileTree } from "./workspace/workspace-file-tree.ts";
export { WorkspacePreview, workspacePreviewScript, type WorkspacePreviewDevice } from "./workspace/workspace-preview.ts";
export { WorkspaceShell, type WorkspaceLayout, type WorkspaceSplits, type WorkspaceTab, type WorkspaceTabItem } from "./workspace/workspace-shell.ts";
export { WorkspaceTerminal, type WorkspaceTerminalOutput } from "./workspace/workspace-terminal.ts";
