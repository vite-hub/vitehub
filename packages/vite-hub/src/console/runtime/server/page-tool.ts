import { installViteHubPageTools, registerViteHubPageTool } from "@vite-hub/internal/runtime/page-tools"

import { consoleAllowsRequest } from "./access.ts"

/** The Console page tool script, with the Console's hashed assets. The package build writes the hashed file name. */
const script = "/_vitehub/assets/__VITEHUB_CONSOLE_PAGE_TOOL_ASSET__"

/**
 * Registers the `console` page tool: a link to the Console in the page tools pill. The Console access policy decides
 * who gets it, so in `local` mode only the development server shows it. Generated Console output calls this.
 */
export function installConsolePageTool(nitroApp: unknown): void {
  registerViteHubPageTool({
    id: "console",
    label: "Console",
    icon: "i-lucide-square-terminal",
    script,
    allowed: ({ event }) => consoleAllowsRequest(event),
  })
  installViteHubPageTools(nitroApp)
}
