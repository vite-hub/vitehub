import { generatedNitroPlugin } from "./generated-nitro-plugin.ts"

import type { Plugin } from "vite"

/**
 * Render the Nitro plugin that logs unhandled request errors with their message, stack, status, code, fix, and cause chain.
 * h3 logs only the sanitized HTTPError, and Cloudflare Workers serialize it through toJSON(), which drops all of these.
 * The plugin turns off that h3 log, so each error is logged once. The response body stays sanitized. Errors that a route
 * throws on purpose, such as a 401, are not logged.
 */
export function renderErrorLogNitroPlugin(): string {
  return [
    `import { normalizeRuntimeDiagnosticError } from "vite-hub/runtime"`,
    "",
    "export default function viteHubErrorLogPlugin(nitroApp) {",
    "  if (nitroApp.h3) nitroApp.h3.config.silent = true",
    `  nitroApp.hooks.hook("error", (error, context) => {`,
    "    const status = Number(error?.status ?? error?.statusCode ?? 500)",
    "    if (error?.unhandled !== true && status < 500) return",
    "    const request = context?.event?.req",
    "    const url = request?.url ? new URL(request.url, \"http://localhost\") : undefined",
    "    const route = request ? `${request.method} ${url?.pathname ?? \"\"}` : (context?.tags ?? []).join(\",\") || \"server\"",
    // The unhandled HTTPError wraps the thrown error. Log the thrown error so its own message and cause stay first.
    "    const thrown = error?.unhandled === true && error.cause !== undefined ? error.cause : error",
    "    console.error(`[vitehub] Unhandled error in ${route}`, normalizeRuntimeDiagnosticError(thrown, { includeStack: true }))",
    "  })",
    "}",
    "",
  ].join("\n")
}

/**
 * Render the Nitro error handler that answers with Nitro's default response but does not log it again.
 * In development, Nitro's default handler also logs every unhandled error as `[request error]`.
 */
export function renderErrorLogNitroHandler(): string {
  return [
    "export default async function viteHubErrorLogHandler(error, event, { defaultHandler }) {",
    "  const response = await defaultHandler(error, event, { silent: true })",
    "  return new Response(typeof response.body === \"string\" ? response.body : JSON.stringify(response.body, null, 2), response)",
    "}",
    "",
  ].join("\n")
}

/** Register the generated Nitro plugin that logs unhandled request errors once, with their cause chain. */
export function errorLogVitePlugin(): Plugin {
  return generatedNitroPlugin("vite-hub/error-log", "error-log.mjs", renderErrorLogNitroPlugin, { errorHandler: renderErrorLogNitroHandler })
}
