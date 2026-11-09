import { createWorkspaceDriver } from "@vite-hub/workspace/mountx"
import { console as vitehubConsole } from "vite-hub/console/server"

export const driver = createWorkspaceDriver({ workspace: "docs" })
export const consoleRuntime = vitehubConsole
export { createWorkspaceDriver }
