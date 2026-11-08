import { installViteHubPageTools, registerViteHubPageTool } from "@vite-hub/internal/runtime/page-tools"

import type { ViteHubPageToolsInstallOptions } from "@vite-hub/internal/runtime/page-tools"

import { getConsoleSections } from "./sections.ts"

import type { ConsoleSectionId } from "../sections.ts"

/** The access checks load on the first page that asks for the tools, not when the server starts. */
async function consoleAllowsRequest(event: unknown, section?: ConsoleSectionId, kind?: "read" | "write"): Promise<boolean> {
  return (await import("./access.ts")).consoleAllowsRequest(event, section, kind)
}

/**
 * The Console page tool script, with the Console's hashed assets, below the app base. The package build writes the
 * hashed file name.
 */
const script = "/_vitehub/assets/__VITEHUB_CONSOLE_PAGE_TOOL_ASSET__"

/**
 * Registers the Console and Content windows in the page tools pill. The Console access policy decides
 * who gets it, so in `local` mode only the development server shows it. Generated Console output calls this with the
 * app base.
 */
export function installConsolePageTool(nitroApp: unknown, options: ViteHubPageToolsInstallOptions = {}): void {
  registerViteHubPageTool(nitroApp, {
    id: "console",
    label: "Console",
    icon: "i-lucide-square-terminal",
    script, lazy: true,
    allowed: ({ event }) => consoleAllowsRequest(event),
  })
  registerViteHubPageTool(nitroApp, {
    // Eager, so the segment can offer the draft of the open page before the editor opens. The editor frame still waits.
    id: "content", label: "Content", icon: "i-lucide-file-pen", script,
    allowed: async ({ event }) => getConsoleSections().includes("content") && await consoleAllowsRequest(event, "content", "write"),
  })
  installViteHubPageTools(nitroApp, options)
}
