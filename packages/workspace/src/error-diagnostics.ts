import { defineDiagnostics } from "nostics"

const dynamicError = {
  why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
}

/** A code whose call site passes the message as `why`, with the fix that the reader applies. */
const withFix = (fix: string) => ({ ...dynamicError, fix })

// Each code identifies one ViteHub failure site. Keep published codes stable.
// Retired codes. Do not reuse them: WORKSPACE_R0010, WORKSPACE_R0011, WORKSPACE_R0030 to WORKSPACE_R0032, WORKSPACE_R0062, and WORKSPACE_R0068.
export const workspaceErrorDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/workspace/diagnostics",
  codes: {
    // Operation errors. The `workspace.*` operations of the CLI, the Console, and Agents throw them with an HTTP status.
    WORKSPACE_FORBIDDEN: {
      why: "An Agent may not write past an edit lease that a person holds.",
      fix: "Tell the person you work for who is editing the files, and try again after they finish. A developer allows overrides with operations({ overrideLeases: true }).",
    },
    WORKSPACE_HISTORY_FAILED: {
      why: ({ workspace }: { workspace: string }) => `The history operation of Workspace "${workspace}" failed.`,
      fix: "Read `error.cause` for the Store error. Check that the Store of the Workspace is reachable, then retry.",
    },
    WORKSPACE_HISTORY_INVALID: {
      why: ({ problem }: { problem: "cursor-ref" | "empty-commit" }) => problem === "empty-commit"
        ? "The commit has no changes. Pass `put` or `delete`."
        : "The cursor belongs to one ref. Pass the same ref.",
      fix: "Pass `put` or `delete` to `workspace.commit`, and pass a `cursor` only with the `ref` of the `workspace.history` call that returned it.",
    },
    WORKSPACE_NOT_FOUND: {
      why: ({ id, path, problem, workspace }: { id?: string, path?: string, problem: "path" | "revision" | "target" | "workspace", workspace: string }) => ({
        path: `Revision ${id} has no path "${path}".`,
        revision: `The Workspace has no revision "${id}". Pull again without a base revision.`,
        target: `Workspace "${workspace}" has no ref or revision "${id}". Run \`vitehub workspace refs ${workspace}\` to list refs.`,
        workspace: `Unknown Workspace: ${workspace}.`,
      })[problem],
      fix: "Check the Workspace name, the ref or revision, and the path. `vitehub workspace refs <workspace>` lists the refs, and `vitehub workspace show <workspace> <ref>` lists the files. When a base revision is gone, pull again without it.",
    },

    // Checkout errors. `vitehub pull`, `push`, `resolve`, `status`, and the Git hooks print them with the code and the fix.
    WORKSPACE_CHECKOUT_CONFLICT: {
      why: ({ conflicted, workspace }: { conflicted: string, workspace: string }) => `Workspace "${workspace}" has unresolved conflicts: ${conflicted}.`,
      fix: "Edit each file and remove the conflict markers, or run `vitehub resolve` for a binary file. Then push again.",
    },
    WORKSPACE_CHECKOUT_DIR: {
      why: ({ dir, workspace }: { dir?: string, workspace?: string }) => dir === undefined
        ? `Workspace "${workspace}" is not checked out yet.`
        : `The checkout folder "${dir}" must be a folder inside the project, not the project root.`,
      fix: "Pass `--dir` with a folder inside the project, such as `vitehub pull <workspace> --dir content`.",
    },
    WORKSPACE_CHECKOUT_FAILED: {
      why: ({ message }: { message: string }) => message,
      fix: "Read the message. Run `vitehub status` to see the state of the checkout, then run the command again.",
    },
    WORKSPACE_CHECKOUT_MISSING: {
      why: ({ workspace }: { workspace?: string }) => workspace === undefined ? "vitehub.lock has no checked-out Workspace." : `Workspace "${workspace}" is not checked out.`,
      fix: "Run `vitehub pull <workspace> --dir <folder>` first.",
    },
    WORKSPACE_CHECKOUT_OPTIONS: {
      why: ({ actual, expected, key, workspace }: { actual: string, expected: string, key: "dir" | "ref" | "remote", workspace?: string }) => workspace === undefined
        ? `This checkout uses ${expected}, not "${actual}".`
        : `Workspace "${workspace}" is checked out with ${key} "${expected}", not "${actual}".`,
      fix: "Edit `vitehub.lock` to change the `dir` or `ref` of the entry. To change the remote, remove the entry from `vitehub.lock` and pull into a new folder.",
    },
    WORKSPACE_CHECKOUT_OVERLAP: {
      why: ({ dir, other, otherDir, workspace }: { dir: string, other: string, otherDir: string, workspace: string }) => `Workspace "${workspace}" folder "${dir}" overlaps Workspace "${other}" folder "${otherDir}".`,
      fix: "Use separate checkout folders that do not contain one another.",
    },
    WORKSPACE_CHECKOUT_PATH: {
      why: ({ other, path, problem }: { other?: string, path: string, problem: "excluded" | "not-portable" | "not-relative" | "reserved" | "spelling" }) => ({
        "excluded": `The path "${path}" is excluded from the checkout.`,
        "not-portable": `The path "${path}" has a component that is not portable between file systems.`,
        "not-relative": `The remote path "${path}" is not a relative Workspace path.`,
        "reserved": `The top-level file name "${path}" is reserved by the operation input map.`,
        "spelling": `The checkout paths "${other}" and "${path}" use different spellings for one file-system path, or replace a file with a directory.`,
      })[problem],
      fix: "Rename the path to a portable name that the checkout does not exclude, before you pull or push it. For two spellings of one path, rename one. For a file that a folder replaces, keep local edits elsewhere, remove the `vitehub.lock` entry, and pull into a new empty folder.",
    },
    WORKSPACE_CHECKOUT_SYMLINK: {
      why: ({ path }: { path: string }) => path === "vitehub.lock"
        ? "vitehub.lock is a symbolic link. A checkout reads and writes only a real lock file."
        : `${path} is a symbolic link. A checkout reads and writes only real files and folders.`,
      fix: "Replace the symbolic link with a real folder or file, then try again.",
    },
    WORKSPACE_CHECKOUT_TOO_LARGE: {
      why: ({ largest, limit, size, workspace }: { largest: string, limit: string, size: string, workspace: string }) => `The push of Workspace "${workspace}" is ${size}, over the ${limit} limit of one push.${largest ? ` Largest files: ${largest}.` : ""}`,
      fix: "A push is one revision and sends each changed file whole, with binary files in base64. Keep large media in Blob, or add new files in smaller groups with a push after each group.",
    },
    WORKSPACE_CHECKOUT_USAGE: {
      why: ({ command, flag, problem }: { command?: string, flag?: string, problem: "flag" | "names" | "value" }) => ({
        flag: `Unknown flag --${flag}.`,
        names: `${command} accepts at most one Workspace name.`,
        value: `--${flag} needs a value.`,
      })[problem],
      fix: "Pass only the flags of the command, each with its value, and at most one Workspace name, for example `vitehub pull docs --dir content`.",
    },
    WORKSPACE_LOCK_BUSY: {
      why: "Another vitehub command is writing vitehub.lock: vitehub.lock.lock exists.",
      fix: "Wait for that command to finish and try again. If no vitehub command runs, delete `vitehub.lock.lock`.",
    },
    WORKSPACE_LOCK_INVALID: {
      why: ({ problem }: { problem: "json" | "shape" }) => problem === "json" ? "vitehub.lock is not valid JSON." : "vitehub.lock has no `version: 1` and `workspaces` object.",
      fix: "Fix the conflict in `vitehub.lock`, or delete the entry and pull again.",
    },

    // Config errors. The Vite plugin and the runtime throw them because the `store` option must change.
    WORKSPACE_RENAMED_STORE_PROVIDER_KEY: {
      why: ({ provider }: { driver: string, provider: string }) => `The Workspace \`store\` sets \`provider: ${provider}\`. ViteHub renamed this key to \`driver\`, and it does not read \`provider\`, so the Store would not be the one you chose.`,
      fix: ({ driver }: { driver: string, provider: string }) => `Set \`store: { driver: ${driver} }\`, or run \`npx @vite-hub/codemods driver-key\` to rename it in every config file.`,
    },
    WORKSPACE_RENAMED_STORE_REPOSITORY_KEY: {
      why: () => "The GitHub Workspace `store` sets `repository`. ViteHub renamed this key to `repo`, and it does not read `repository`, so the Store would use `VITEHUB_WORKSPACE_GITHUB_REPOSITORY` or no repository.",
      fix: () => "Rename `repository` to `repo` in `store: { driver: \"github\" }`, or run `vitehub migrate` to rename it in every file.",
    },
    WORKSPACE_UNKNOWN_STORE_DRIVER: {
      why: ({ driver, renamed }: { driver: string, renamed?: string }) => renamed
        ? `The Workspace \`store.driver\` is ${driver}. ViteHub renamed this driver to "${renamed}", and it does not read ${driver}.`
        : `The Workspace \`store.driver\` ${driver} is not a Workspace Store driver.`,
      fix: ({ renamed }: { driver: string, renamed?: string }) => renamed
        ? `Set \`store: { driver: "${renamed}" }\`, or run \`npx @vite-hub/codemods driver-key\` to rename it in every config file.`
        : "Set `store.driver` to \"local\", \"memory\", \"github\", \"cloudflare\", or \"vercel\", or pass a Store object.",
    },
    // Registry errors. The generated Workspace registry loads each Definition module when the app first uses it.
    WORKSPACE_REGISTRY_LOAD_FAILED: {
      why: ({ reason, workspace }: { reason: string, workspace: string }) => `The module of Workspace "${workspace}" did not load: ${reason}`,
      fix: "Read `error.cause` for the first error. Make sure that the module of the Workspace loads without errors and exports its Definition: the default export of a file in `server/workspaces/`, or the export that the Vite plugin names in its Workspace contribution. Then restart the dev server or build again.",
    },

    // Source errors. The build checks the Sources that the app reads after deploy.
    WORKSPACE_SOURCE_ACCESS_FAILED: {
      why: ({ source, workspace }: { source: string, workspace: string }) => `Source "${source}" of Workspace "${workspace}" cannot reach its data with the credentials of the build. The deployed app would fail on its first read.`,
      fix: "Read `error.cause` for the response of the provider. For a GitHub Source, check that `repo` and `ref` exist and that the token of the build (`auth`, `VITEHUB_GITHUB_TOKEN`, or `gh auth token`) can read the repository. Then build again.",
    },

    // Published numbered errors.
    WORKSPACE_R0069: withFix("Use a Store with retained history: `createBlobDatabaseWorkspaceStore()` or the `github` Store. Open the Workspace with a scope that grants the complete Workspace, not selected paths."),
    WORKSPACE_R0070: withFix("Pass a `limit` from 1 to 100, and pass a `cursor` only with the `ref` of the `history.list()` call that returned it."),
    WORKSPACE_R0071: withFix("Use a ref name with up to 128 letters, numbers, `_`, and `-`, joined by single `.` or `/`, for example `draft` or `team/review`. In a GitHub Store with `refs`, use `published` or `draft`, not the branch name."),
    WORKSPACE_R0072: withFix("Set the `repo` option of the GitHub Store or `VITEHUB_WORKSPACE_GITHUB_REPOSITORY`, for example `owner/repo`. Set the `token` option or `VITEHUB_GITHUB_TOKEN`."),
    WORKSPACE_R0073: withFix("Make the commit message or metadata shorter, as the message says. Remove each `Vitehub-Metadata:` line from the message, and pass the values in the `metadata` option."),
    WORKSPACE_R0001: withFix("Pass the path of a file or folder in the Workspace, for example `docs/guide.md`. The Workspace root itself cannot be written, moved, or deleted."),
    WORKSPACE_R0002: withFix("Enable at least one operation in `createWorkspaceTools(workspace, { operations })`, for example `{ operations: { read: true } }`."),
    WORKSPACE_R0003: withFix("Get write tools from `useWorkspace(name, { mode: \"write\" }).tools.write()`. Do not pass the result of `useWorkspace()` to `createWorkspaceTools()`. Or remove `write` from `operations`."),
    WORKSPACE_B0001: withFix("Export the Workspace Definition from the file, for example `export default defineWorkspace({ ... })`. For a contributed Workspace, set `definition.export` to the name of the export."),
    WORKSPACE_B0002: withFix("Use `defineWorkspace()` in `server/workspaces/<name>.ts`. Move the `defineAgent()` call to `server/agents/<name>/agent.ts`."),
    WORKSPACE_B0003: withFix("Rename or remove one of the definitions that the message lists. Each Workspace name has one definition."),
    WORKSPACE_B0004: withFix("Set `vitehub.workspaces` in the plugin to an array of `{ name, definition: { module, export? }, reason? }` entries, or to a function that returns one. Set `module` to an absolute path, a `file:` URL, or a package specifier."),
    WORKSPACE_B0005: withFix("Set the Cloudflare Artifacts Store in the `workspace` config, for example `vitehub({ workspace: { store: { driver: \"cloudflare\", binding: \"WORKSPACE_ARTIFACTS\", namespace: \"vitehub\" } } })`, and remove `store` from the Workspace Definition. Or remove the import that the build cannot load from the Definition file, so that the build can read its `store`."),
    WORKSPACE_R0004: withFix("Put a value after the option, for example `--timeout 30000` or `--url http://localhost:5173`."),
    WORKSPACE_R0005: withFix("Pass a whole number of milliseconds from 1 to 2147483647, for example `--timeout 30000`."),
    WORKSPACE_R0006: withFix("Pass a whole number of milliseconds from 1 to 2147483647, for example `--timeout 30000`."),
    WORKSPACE_R0007: withFix("Remove the option. `vitehub workspace dev --help` lists the options."),
    WORKSPACE_R0008: withFix("Put a command after `exec`, for example `vitehub workspace dev docs exec ls`."),
    WORKSPACE_R0009: withFix("Put `exec` before the command, for example `vitehub workspace dev docs exec ls -la`. Or omit the command to open the interactive command loop."),
    WORKSPACE_C0001: withFix("Set `workspace` to an object, for example `workspace: { store: { driver: \"memory\" } }`, or to `false`."),
    WORKSPACE_C0002: withFix("Remove the option. The `workspace` config accepts `assets`, `projectRoot`, `root`, and `store`."),
    WORKSPACE_R0015: withFix("Remove the option. `defineWorkspace()` accepts `bindings`, `commit`, `hooks`, `loaders`, `plugins`, `rootDir`, `rules`, `sourceRootDir`, `sources`, and `store`."),
    WORKSPACE_R0016: withFix("Pass an object to `defineWorkspace()`, for example `defineWorkspace({ sources: {} })`."),
    WORKSPACE_R0017: withFix("Remove `name` from the Workspace Definition. The file name sets the Workspace name, for example `server/workspaces/docs.ts` defines `docs`."),
    WORKSPACE_R0018: withFix("Use fewer and shorter glob patterns with fewer `{a,b}` and `*` parts, for example `docs/**/*.md` in place of a list of patterns."),
    WORKSPACE_R0019: withFix("Use fewer and shorter glob patterns with fewer `{a,b}` and `*` parts, for example `docs/**/*.md` in place of a list of patterns."),
    WORKSPACE_R0020: withFix("Use fewer and shorter glob patterns with fewer `{a,b}` and `*` parts, for example `docs/**/*.md` in place of a list of patterns."),
    WORKSPACE_R0021: withFix("Remove `name` from the Workspace Definition. The file name sets the Workspace name, for example `server/workspaces/docs.ts` defines `docs`."),
    WORKSPACE_R0022: withFix("Pass the Workspace name as a non-empty string, for example `registerWorkspace(\"docs\", definition)` or `registerWorkspacePlugin(\"docs\", plugin)`."),
    WORKSPACE_R0023: withFix("Set `maxBytes` to a number of bytes or to a string such as `\"512kb\"` or `\"10mb\"`."),
    WORKSPACE_R0024: withFix("Give each Workspace plugin a non-empty string `id`, for example `{ id: \"my-plugin\", rules }`."),
    WORKSPACE_R0025: withFix("Declare the target as a `url()` Source in the Workspace Definition, and make the Source visible in the Workspace scope."),
    WORKSPACE_R0026: withFix("Use a Store that supports rebase: `github` or `cloudflare`. Or do not call `rebase()` on this Workspace."),
    WORKSPACE_R0027: withFix("Set another `binding` in the Workspace `store` options, or set `namespace` to the namespace that Wrangler config already has for that binding."),
    WORKSPACE_R0028: withFix("The client closed the Workspace Dev connection before the command finished. Run the command again and keep the connection open."),
    WORKSPACE_R0029: withFix("Give each Cloudflare Artifacts namespace its own `binding` in the Workspace `store` options."),
    WORKSPACE_R0033: withFix("Run the operation again. If it fails again, check the Blob store of the project in the Vercel dashboard."),
    WORKSPACE_R0034: withFix("Pass the Workspace name, for example `createWorkspacePreparation({ workspace: \"docs\" })`."),
    WORKSPACE_R0035: withFix("Pass Source keys of the Workspace as non-empty strings, for example `sources: [\"handbook\"]`, or omit `sources`."),
    WORKSPACE_R0036: withFix("Set `retryDelayMs` to a number of milliseconds from 0 to 2147483647, or omit it to use 10000."),
    WORKSPACE_R0037: withFix("Set `materialize: \"startup\"` on the Sources to prepare, or pass their keys in `sources`."),
    WORKSPACE_R0038: withFix("Check each Source that the message names: its URL, repository, or files, and its credentials. Without `requireNonEmpty`, an empty Source is ready."),
    WORKSPACE_R0039: withFix("`stop()` cancelled this preparation. Call `start()` again to prepare the Workspace."),
    WORKSPACE_R0040: withFix("Pass a non-empty command, for example `vitehub workspace dev docs exec ls`."),
    WORKSPACE_R0041: withFix("Pass a Workspace name, or a Workspace from `useWorkspace(name, { mode: \"write\" })`, that can start a Workspace Session."),
    WORKSPACE_R0042: withFix("This is a ViteHub bug. Report it at https://github.com/vite-hub/vitehub/issues with the message and your Workspace Definition."),
    WORKSPACE_R0043: withFix("This is a ViteHub bug. Report it at https://github.com/vite-hub/vitehub/issues with the message and your Workspace Definition."),
    WORKSPACE_R0044: withFix("Make sure that the Workspace Session host can run `readlink` and can read the path in the message."),
    WORKSPACE_R0045: withFix("Set `executionAuthority` on the Workspace Session host. Use `unknownExecutionAuthority` from `@vite-hub/runtime` when the host cannot describe it."),
    WORKSPACE_C0003: withFix("Rename the Source key to one file name without `/` and without a `.json` ending, for example `issues`. ViteHub keeps the request descriptor at `.vitehub/sources/<key>.json`."),
    WORKSPACE_C0004: withFix("Set `mount` on the Source to a folder, for example `mount: \"docs\"`, or set `probeKeys`. A Workspace Scope grant needs paths, and a Source at the root has none."),
    WORKSPACE_C0005: withFix("Use a Source helper so that the Source kind is explicit, for example `github({ repo: \"owner/name\" })`, `url({ url, workspacePath: \"issues.json\" })`, or `file({ path: \"README.md\" })`. A `{ source: { ... } }` wrapper does not help, because ViteHub reads the options in it the same way."),
    WORKSPACE_C0006: withFix("Pass `path` or `workspacePath` to `file()`, for example `file({ path: \"README.md\" })`."),
    WORKSPACE_C0007: withFix("When the URL has a query, set `path` on the Source config, for example `{ url, path: \"issues.json\" }`. Or use the `url()` helper with `workspacePath: \"issues.json\"`."),
    WORKSPACE_R0046: withFix("Set `workspacePath` on the `url()` Source to read the response as a file. A request-only Source answers only `curl` Source requests."),
    WORKSPACE_R0047: withFix("Read the `url()` Source at its `workspacePath`. The Source has no other file."),
    WORKSPACE_R0048: withFix("Read this Source in an Agent Invocation. The Agent runs the resolver with the Invocation context before it reads the Source. Outside an Invocation, the Source has no files."),
    WORKSPACE_R0049: withFix("Set `responseType` to `\"json\"` or `\"text\"`."),
    WORKSPACE_R0050: withFix("Set `method` to `\"GET\"`, `\"HEAD\"`, or `\"POST\"`."),
    WORKSPACE_R0051: withFix("Use `query` for a fixed query or `querySchema` for a query that the Agent sets. Remove the other one, and remove the query from `url` when you use `querySchema`."),
    WORKSPACE_R0052: withFix("Use `body` for a fixed body or `bodySchema` for a body that the Agent sets. Remove the other one."),
    WORKSPACE_R0053: withFix("Set `method: \"POST\"` to send a body, or remove `body` and `bodySchema`."),
    WORKSPACE_R0054: withFix("Pass a schema that has `~standard.jsonSchema.input()`, the Standard JSON Schema interface. Or use a fixed `query` or `body`."),
    WORKSPACE_R0055: withFix("Send the request with the method, URL, query, and body that the Source declares. Read `.vitehub/sources/<source>.json` in the Workspace to get them."),
    WORKSPACE_R0056: withFix("Send the request with the method, URL, query, and body that the Source declares. Read `.vitehub/sources/<source>.json` in the Workspace to get them."),
    WORKSPACE_R0057: withFix("Send the request with the method, URL, query, and body that the Source declares. Read `.vitehub/sources/<source>.json` in the Workspace to get them."),
    WORKSPACE_R0058: withFix("Send the request with the method, URL, query, and body that the Source declares. Read `.vitehub/sources/<source>.json` in the Workspace to get them."),
    WORKSPACE_R0059: withFix("Send the request with the method, URL, query, and body that the Source declares. Read `.vitehub/sources/<source>.json` in the Workspace to get them."),
    WORKSPACE_R0060: withFix("Read this Source in an Agent Invocation. The Agent runs the resolver with the Invocation context before it reads the Source. Outside an Invocation, the Source has no files."),
    WORKSPACE_R0061: withFix("Return `repo` from the `github()` resolver, for example `{ repo: \"owner/name\" }`, or start the Agent Invocation with a `pullRequest` context value."),
    WORKSPACE_R0063: withFix("Use the URL of exactly one Source that the Workspace scope can see. Read `.vitehub/sources/<source>.json` in the Workspace and send the URL, method, query, and body that it declares."),
    WORKSPACE_R0064: withFix("This is a ViteHub bug. Report it at https://github.com/vite-hub/vitehub/issues with the message and your Workspace Definition."),
    WORKSPACE_R0065: withFix("The Cloudflare Artifacts Store keeps its Git checkout in memory. A Git step used the path in the message in a way that the error code rejects, for example `ENOENT` for a missing file. Run the operation again. If it fails again, report it at https://github.com/vite-hub/vitehub/issues with the message."),
    WORKSPACE_R0066: withFix("Connect a Blob store to the Vercel project so that it gets `BLOB_STORE_ID`. Off Vercel, set `BLOB_READ_WRITE_TOKEN`."),
    WORKSPACE_R0074: withFix("The Workspace Store keeps no file revisions, so ViteHub cannot prove that the file at the path in the message is the one it started to remove. Check the file. If it must go, delete it in the Store itself, for example in its directory or bucket, because the Workspace rejects writes under a Source. Then run the Source operation again."),
    WORKSPACE_R0075: withFix("Remove `read` from the rule. Workspace rules limit writes only, so `read: false` would not hide the files. Keep files that a reader must not see out of the Workspace, for example in another Workspace or in an Env secret."),
    WORKSPACE_R0076: withFix("Remove the option from the rule. A Workspace rule accepts `commit`, `maxBytes`, `mediaType`, `validate`, and `write`."),
    WORKSPACE_R0077: withFix("Pass the Drizzle database of the history Database: `database: () => useDatabase(\"history\").db` with `import { useDatabase } from \"vite-hub/database\"`. A Database Definition from `defineDatabase()` is not a Drizzle database."),
  },
})
