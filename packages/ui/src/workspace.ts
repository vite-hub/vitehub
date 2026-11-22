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
export { WorkspaceBar } from "./workspace/workspace-bar.ts";
export { bootChecklist, WorkspaceBootStatus, type BootStepState, type BootStepView } from "./workspace/workspace-boot-status.ts";
// The checklist formats its step times with the shared duration formatter. It stays public under its first name.
export { formatDuration as formatElapsed } from "./internal/format.ts";
export { WorkspaceEditor } from "./workspace/workspace-editor.ts";
export { WorkspaceEditorHead } from "./workspace/workspace-editor-head.ts";
export { groupExamples, WorkspaceExamples, type WorkspaceExample } from "./workspace/workspace-examples.ts";
export { WorkspaceFileLink, provideWorkspaceFileOpener, type WorkspaceFileOpener } from "./workspace/workspace-file-link.ts";
export { WorkspaceFileTree } from "./workspace/workspace-file-tree.ts";
export { WorkspaceGuide } from "./workspace/workspace-guide.ts";
export { WorkspaceIssues, type WorkspaceIssue } from "./workspace/workspace-issues.ts";
export { WorkspacePreview, workspacePreviewScript, type WorkspacePreviewDevice } from "./workspace/workspace-preview.ts";
export { WorkspaceShell, type WorkspaceLayout, type WorkspaceSplits, type WorkspaceTab, type WorkspaceTabItem } from "./workspace/workspace-shell.ts";
export { WorkspaceSidebar, type WorkspaceSidebarAction } from "./workspace/workspace-sidebar.ts";
export { WorkspaceStart } from "./workspace/workspace-start.ts";
export { WorkspaceStatus, workspaceLanguage, type WorkspaceCursor } from "./workspace/workspace-status.ts";
export { WorkspaceSteps, type WorkspaceStep } from "./workspace/workspace-steps.ts";
export { WorkspaceTask } from "./workspace/workspace-task.ts";
export { WorkspaceTerminal, type WorkspaceTerminalOutput } from "./workspace/workspace-terminal.ts";
