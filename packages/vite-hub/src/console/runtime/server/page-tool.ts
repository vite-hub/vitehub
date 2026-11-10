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
 * Registers the Console in the page tools pill. The Console access policy decides who gets it, so in `local` mode only
 * the development server shows it. With Content, the segment loads with the page, so it can offer the draft of the open
 * page. Without Content it loads when someone reaches for it. Generated Console output calls this with the app base.
 */
export function installConsolePageTool(nitroApp: unknown, options: ViteHubPageToolsInstallOptions = {}): void {
  registerViteHubPageTool(nitroApp, {
    id: "console",
    label: "Console",
    icon: "i-lucide-square-terminal",
    script,
    ...getConsoleSections().includes("content") ? {} : { lazy: true },
    allowed: ({ event }) => consoleAllowsRequest(event),
  })
  installViteHubPageTools(nitroApp, options)
}
