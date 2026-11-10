import { installViteHubPageTools, registerViteHubPageTool } from "@vite-hub/internal/runtime/page-tools"

import type { ViteHubPageToolsInstallOptions } from "@vite-hub/internal/runtime/page-tools"

import { resolveConsoleSections } from "../../internal.ts"
import { consoleClientAssets } from "./client-assets.ts"

import type { ConsoleSectionId } from "../sections.ts"

/** The access checks load on the first page that asks for the tools, not when the server starts. */
async function consoleAllowsRequest(event: unknown, section?: ConsoleSectionId, kind?: "read" | "write"): Promise<boolean> {
  return (await import("./access.ts")).consoleAllowsRequest(event, section, kind)
}

/**
 * Registers the Console in the page tools pill. The Console access policy decides who gets it, so in `local` mode only
 * the development server shows it. With Content, the segment loads with the page, so it can offer the draft of the open
 * page. Without Content it loads when someone reaches for it. Generated Console output calls this with the app base.
 */
export function installConsolePageTool(nitroApp: unknown, options: ViteHubPageToolsInstallOptions = {}): void {
  const pageTool = consoleClientAssets()?.pageTool
  if (pageTool) {
    const script = `/_vitehub/assets/${pageTool}`
    registerViteHubPageTool(nitroApp, {
      id: "console",
      label: "Console",
      icon: "i-lucide-square-terminal",
      script,
      ...resolveConsoleSections().includes("content") ? {} : { lazy: true },
      allowed: ({ request }) => consoleAllowsRequest(request),
    })
  }
  installViteHubPageTools(nitroApp, options)
}
