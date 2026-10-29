import { cmsOptionKeys, cmsOptionProblem, cmsOptionsProblem, cmsStoreOf } from "../cms-options.ts"
import { contentErrorDiagnostics } from "../error-diagnostics.ts"
import { defineContentPreset } from "../presets.ts"

import type { ContentPreset } from "../presets.ts"

/** Options of the `cms` Content preset. The build reads them from `server/content.ts`, so pass string literals. */
export interface CmsPresetOptions {
  /**
   * Database that receives the Workspace history tables, and with the GitHub store only the editor sessions table.
   * Defaults to the Database named `default`, or the only one. Without a Database Definition, the preset adds the
   * `default` Database.
   */
  database?: string
  /** Blob store that holds file contents. Defaults to `default`. Not for the GitHub store. */
  blob?: string
  /** Name of the Workspace that the preset adds. Defaults to `content`. */
  workspace?: string
  /** Where documents live. `repo` selects `"github"`, which keeps them in a repository; otherwise `"blob-database"`. */
  store?: "blob-database" | "github"
  /**
   * The repository, as `owner/name`. Setting it selects the GitHub store. A GitHub store without it (`store: "github"`)
   * reads `VITEHUB_WORKSPACE_GITHUB_REPOSITORY` when first used.
   */
  repo?: string
  /** GitHub store: the published branch. Defaults to `main`. */
  branch?: string
  /** GitHub store: the branch that holds drafts. Defaults to `vitehub/content`. It is created at the first save. */
  draftBranch?: string
  /**
   * GitHub store: the folder of the repository that holds the collections' paths. Defaults to `""`, the repository
   * root, where a collection path such as `content/posts/**\/*.md` starts at the root.
   */
  root?: string
  /** GitHub store: how a publish reaches `branch`. `"commit"` (default) commits to it. `"pr"` opens a pull request. */
  publish?: "commit" | "pr"
}

/**
 * Store editable collections without wiring. `vitehub()` turns on Workspace, Database, and Blob when they are unset.
 * At build time the Content Vite plugin adds a Workspace named `content` on the Blob + Database Store, using the
 * `default` Blob store and the default or only Database, and adds the Workspace history tables to that Database. When
 * the app has no Database Definition, it adds the `default` Database. `defineContent({ extends: cms })` then uses
 * that Workspace.
 *
 * With `repo` (or `store: "github"`) the Workspace is a GitHub repository instead: published content on one branch, drafts on
 * another, and no Blob store. The Database keeps editor sessions.
 */
const cms: ContentPreset<CmsPresetOptions> = defineContentPreset<CmsPresetOptions>({
  name: "cms",
  options: {
    blob: "default",
    branch: undefined,
    database: undefined,
    draftBranch: undefined,
    publish: undefined,
    repo: undefined,
    root: undefined,
    store: undefined,
    workspace: "content",
  },
  configure(options) {
    for (const key of cmsOptionKeys) {
      const problem = cmsOptionProblem(key, Reflect.get(options, key))
      if (problem) throw contentErrorDiagnostics.CONTENT_R0006({ message: `[vitehub] Content cms preset option ${JSON.stringify(key)} ${problem}` })
    }
    // The default `blob` is not something the app set, so a GitHub store does not see it.
    const github = cmsStoreOf(options) === "github"
    const set = { ...options, blob: github && options.blob === "default" ? undefined : options.blob }
    const problem = cmsOptionsProblem(set)
    if (problem) throw contentErrorDiagnostics.CONTENT_R0006({ message: `[vitehub] Content cms preset ${problem}` })
    return { workspace: options.workspace, ...(github && options.publish === "pr" ? { publish: "pr" as const } : {}) }
  },
})

export { cms }
export default cms
