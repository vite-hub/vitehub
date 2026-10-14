import { contentErrorDiagnostics } from "../error-diagnostics.ts"
import { defineContentPreset } from "../presets.ts"

import type { ContentPreset } from "../presets.ts"

/** Options of the `cms` Content preset. The build reads them from `server/content.ts`, so pass string literals. */
export interface CmsPresetOptions {
  /** Database that receives the Workspace history tables. Defaults to the Database named `default`, or the only one. */
  database?: string
  /** Blob store that holds file contents. Defaults to `default`. */
  blob?: string
  /** Name of the Workspace that the preset adds. Defaults to `content`. */
  workspace?: string
}

const namePattern = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/i

/**
 * Store editable collections without wiring. At build time the Content Vite plugin adds a Workspace named `content`
 * on the Blob + Database Store, using the `default` Blob store and the default or only Database, and adds the
 * Workspace history tables to that Database. `defineContent({ extends: cms })` then uses that Workspace.
 */
const cms: ContentPreset<CmsPresetOptions> = defineContentPreset<CmsPresetOptions>({
  name: "cms",
  options: { blob: "default", database: undefined, workspace: "content" },
  configure(options) {
    for (const key of ["blob", "database", "workspace"] as const) {
      const value = options[key]
      if (value === undefined && key === "database") continue
      if (String(value) !== value || !namePattern.test(value)) {
        throw contentErrorDiagnostics.CONTENT_R0006({ message: `[vitehub] Content cms preset option ${JSON.stringify(key)} must be a name of letters, numbers, dots, underscores, dashes, and slashes.` })
      }
    }
    return { workspace: options.workspace }
  },
})

export { cms }
export default cms
