import { defineContentPreset } from "@vite-hub/content"

import { cmsErrorDiagnostics } from "./error-diagnostics.ts"
import { cmsGitHubDefaults, cmsOptionKeys, cmsOptionProblem, cmsOptionsProblem, cmsRenamedAccessProblem, cmsStoreOf } from "./options.ts"
import { createCmsRoles } from "./roles.ts"

import type { ContentAuthorize, ContentPreset } from "@vite-hub/content"
import type { CmsRoleSet } from "./roles.ts"

/** Options of the `cms` Content preset. Use literal values, such as `roles: true`, so the build can read them. */
export interface CmsPresetOptions {
  /** Opt into the CMS roles of `admin(cmsAccess)`. Without it, set `defineContent({ authorize })` to allow access. */
  roles?: true
  /** Renamed to `roles: true`. The preset fails with `CONTENT_CMS_OPTION_INVALID` when it is set. */
  access?: never
  /**
   * Database that receives the Workspace history tables, and with the GitHub store only the editor sessions table.
   * Defaults to the Database named `default`, or the only one. Without a Database Definition, the tables go to the
   * implicit `default` Database.
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
  /** GitHub store: how a publish reaches `branch`. `"commit"` (default) commits to it. `"pr"` opens a pull request from a `vitehub/publish/*` branch, which only Console access or a signed link previews. */
  publish?: "commit" | "pr"
}

let cmsRoleSet: Promise<CmsRoleSet> | undefined

function loadCmsRoles(): Promise<CmsRoleSet> {
  cmsRoleSet ??= Promise.all([import("better-auth/plugins/access"), import("better-auth/plugins/admin/access")])
    .then(([access, adminAccess]) => createCmsRoles(access, adminAccess))
  return cmsRoleSet
}

const cmsDefaultAuthorize: ContentAuthorize = async ({ user, action }) => {
  if (String(user?.role) !== user?.role) return false
  return (await loadCmsRoles()).can(user, { content: [action] })
}

const cms: ContentPreset<CmsPresetOptions> = defineContentPreset<CmsPresetOptions>({
  name: "cms",
  options: {
    access: undefined,
    blob: "default",
    branch: undefined,
    database: undefined,
    draftBranch: undefined,
    publish: undefined,
    repo: undefined,
    roles: undefined,
    root: undefined,
    store: undefined,
    workspace: "content",
  },
  configure(options) {
    if (options.access !== undefined) throw cmsErrorDiagnostics.CONTENT_CMS_OPTION_INVALID({ problem: cmsRenamedAccessProblem })
    for (const key of cmsOptionKeys) {
      const problem = cmsOptionProblem(key, Reflect.get(options, key))
      if (problem) throw cmsErrorDiagnostics.CONTENT_CMS_OPTION_INVALID({ problem: `option ${JSON.stringify(key)} ${problem}` })
    }
    const github = cmsStoreOf(options) === "github"
    const set = { ...options, blob: github && options.blob === "default" ? undefined : options.blob }
    const problem = cmsOptionsProblem(set)
    if (problem) throw cmsErrorDiagnostics.CONTENT_CMS_OPTION_INVALID({ problem })
    return {
      workspace: options.workspace,
      ...(options.roles ? { authorize: cmsDefaultAuthorize } : {}),
      ...(github && options.publish === "pr" ? { publish: "pr" as const } : {}),
      ...(github ? { privateBranches: [options.draftBranch ?? cmsGitHubDefaults.draftBranch] } : {}),
    }
  },
})

export { cms }
export default cms
