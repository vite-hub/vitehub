import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"
import { resolveViteHubProjectRoot, VITEHUB_PROJECT_ROOT } from "@vite-hub/internal/build/vite"

import type { Plugin } from "vite"

const generatedErrorLogPlugin = ".vitehub/nitro/error-log.mjs"

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

async function writeIfChanged(file: string, contents: string): Promise<void> {
  if (await readFile(file, "utf8").catch(() => undefined) === contents) return
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, contents, "utf8")
}

/** Register the generated Nitro plugin that logs unhandled request errors with their cause chain. */
export function errorLogVitePlugin(): Plugin {
  return {
    name: "vite-hub/error-log",
    async config(config) {
      // SAFETY: ViteHub and Nitro extend Vite's user config with these documented top-level keys.
      const viteConfig = config as typeof config & { [VITEHUB_PROJECT_ROOT]?: string, nitro?: Record<string, unknown> }
      const projectRoot = typeof viteConfig[VITEHUB_PROJECT_ROOT] === "string"
        ? resolve(viteConfig[VITEHUB_PROJECT_ROOT])
        : resolveViteHubProjectRoot(config.root || process.cwd())
      const plugin = resolve(projectRoot, generatedErrorLogPlugin)
      await writeIfChanged(plugin, renderErrorLogNitroPlugin())
      const kit = createNitroServerKit(viteConfig.nitro)
      kit.addPlugin(plugin)
      viteConfig.nitro = kit.config
    },
  }
}
