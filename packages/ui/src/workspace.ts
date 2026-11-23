// Outside the root barrel, so chat pages never load CodeMirror or xterm. `Workspace` with a runner is the whole
// workspace. The parts build other layouts, and render the state of `useWebContainer()` from `@vite-hub/web-container/vue`.
export { BrowserSupportNotice, detectUnsupportedBrowser, type UnsupportedBrowser } from "./workspace/browser-support-notice.ts";
export {
  ConnectPanel,
  connectProviderLabel,
  ConnectProviderRow,
  type ConnectProviderState,
  type ConnectProviderStatus,
} from "./workspace/connect-panel.ts";
export { useConnectStore, type ConnectStore, type UseConnectStoreOptions } from "./workspace/connect-store.ts";
export { render, type RenderRunnerOptions, type WorkspaceRenderContext, type WorkspaceRenderResult } from "./workspace/runners/render.ts";
export { webContainer, type WebContainerRunner, type WebContainerRunnerOptions, type WorkspaceSnapshot } from "./workspace/runners/web-container.ts";
export {
  useWorkspace,
  useWorkspaceDevice,
  Workspace,
  type WorkspaceContext,
  type WorkspaceDevice,
  type WorkspaceFiles,
  type WorkspaceMenuItem,
  type WorkspaceRun,
  type WorkspaceRunInput,
  type WorkspaceRunner,
  type WorkspaceRunState,
  type WorkspaceSlotProps,
} from "./workspace/workspace.ts";
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
