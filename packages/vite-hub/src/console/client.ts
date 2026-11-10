import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import * as v from "valibot"

import { missingFeaturePackagesError } from "../internal/optional-owners.ts"

import type { ConsoleClientAssets } from "./runtime/server/client-assets.ts"

const manifestSchema = v.object({ pageTool: v.string(), script: v.string(), style: v.string() })

/** The installed `@vite-hub/console-client`: the folder that the Console serves at `/_vitehub/assets`, and its entry names. */
export interface ConsoleClient extends ConsoleClientAssets {
  dir: string
}

/**
 * Reads `@vite-hub/console-client`, the prebuilt Console app. `vite-hub` declares it as an optional peer, so an app
 * that does not turn the Console on does not install its 23 MB. Throws the install error of the `console` feature when
 * the app did not install it.
 */
export function resolveConsoleClient(): ConsoleClient {
  let manifestFile: string
  try {
    manifestFile = fileURLToPath(import.meta.resolve("@vite-hub/console-client/manifest.json"))
  }
  catch {
    throw missingFeaturePackagesError(["console"])
  }
  // page-tool.vite.config.ts writes this file when it builds the package.
  const manifest = v.parse(manifestSchema, JSON.parse(readFileSync(manifestFile, "utf8")))
  return { dir: join(dirname(manifestFile), "client"), pageTool: manifest.pageTool, script: manifest.script, style: manifest.style }
}
