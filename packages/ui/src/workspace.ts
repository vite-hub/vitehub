// Outside the root barrel, so chat pages never load CodeMirror or xterm. Run the app with `useWebContainer()` from
// `@vite-hub/web-container/vue`, then pass its state to these parts.
export { BrowserSupportNotice, detectUnsupportedBrowser, type UnsupportedBrowser } from "./workspace/browser-support-notice.ts";
export { bootChecklist, formatElapsed, WorkspaceBootStatus, type BootStepState, type BootStepView } from "./workspace/workspace-boot-status.ts";
export { WorkspaceEditor } from "./workspace/workspace-editor.ts";
export { WorkspaceFileTree } from "./workspace/workspace-file-tree.ts";
export { WorkspacePreview } from "./workspace/workspace-preview.ts";
export { WorkspaceShell, type WorkspaceLayout, type WorkspaceSplits, type WorkspaceTab } from "./workspace/workspace-shell.ts";
export { WorkspaceTerminal, type WorkspaceTerminalOutput } from "./workspace/workspace-terminal.ts";
