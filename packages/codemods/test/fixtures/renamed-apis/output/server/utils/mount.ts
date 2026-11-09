import { createMountxDriver } from "@vite-hub/workspace/mountx"
import { agentConsole as vitehubConsole } from "vite-hub/console/server"

export const driver = createMountxDriver({ workspace: "docs" })
export const consoleRuntime = vitehubConsole
export { createMountxDriver as createWorkspaceDriver }
