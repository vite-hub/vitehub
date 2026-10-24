import { generatedNitroPlugin } from "./generated-nitro-plugin.ts"

import type { Plugin } from "vite"

/**
 * Render the Nitro plugin that logs unhandled request errors with their message, stack, status, and cause chain.
 * h3 logs only the sanitized HTTPError, and Cloudflare Workers serialize it through toJSON(), which drops all of these.
 * The response body stays sanitized. Errors that a route throws on purpose, such as a 401, are not logged.
 */
export function renderErrorLogNitroPlugin(): string {
  return [
    `import { normalizeRuntimeDiagnosticError } from "vite-hub/runtime"`,
    "",
    "export default function viteHubErrorLogPlugin(nitroApp) {",
    `  nitroApp.hooks.hook("error", (error, context) => {`,
    "    const status = Number(error?.status ?? error?.statusCode ?? 500)",
    "    if (error?.unhandled !== true && status < 500) return",
    "    const request = context?.event?.req",
    "    const url = request?.url ? new URL(request.url) : undefined",
    "    const route = request ? `${request.method} ${url?.pathname ?? \"\"}` : (context?.tags ?? []).join(\",\") || \"server\"",
    // The unhandled HTTPError wraps the thrown error. Log the thrown error so its own message and cause stay first.
    "    const thrown = error?.unhandled === true && error.cause !== undefined ? error.cause : error",
    "    console.error(`[vitehub] Unhandled error in ${route}`, normalizeRuntimeDiagnosticError(thrown, { includeStack: true }))",
    "  })",
    "}",
    "",
  ].join("\n")
}

/** Register the generated Nitro plugin that logs unhandled request errors with their cause chain. */
export function errorLogVitePlugin(): Plugin {
  return generatedNitroPlugin("vite-hub/error-log", "error-log.mjs", renderErrorLogNitroPlugin)
}
