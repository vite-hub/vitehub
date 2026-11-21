import { defineDiagnostics } from "nostics"

export const contentErrorDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/content/diagnostics",
  codes: {
    // Retired codes. Do not reuse them: CONTENT_R0006 and CONTENT_R0008.
    // Operation and schedule errors. The `content.*` operations and the schedule runner throw them.
    CONTENT_FORBIDDEN: {
      why: ({ action, target }: { action?: "edit" | "publish" | "read drafts of", target?: "collection" | "document" }) => action === undefined
        ? "An Agent may not take over a document that a person is editing."
        : `You cannot ${action} this ${target}.`,
      fix: "Ask for access, or allow the action in `defineContent({ authorize })`. Without `authorize`, nobody can use Content outside `vite dev`. An Agent waits until the person who edits a document finishes, unless the app allows it with `operations({ overrideLeases: true })`.",
    },
    CONTENT_SCHEDULE_CANCELLED: {
      why: "Content schedule was cancelled while publishing.",
      fix: "No change is needed. `unschedule()` cancelled the schedule while it published, so the schedule runner skips it.",
    },

    // Published numbered errors.
    CONTENT_R0001: {
      fix: "Use a relative path inside the Content Source root, as a string, without `.` or `..` segments, absolute or drive paths, or a first segment of `.git` or `.vitehub`.",
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    CONTENT_R0002: {
      fix: "Give each item of the `contentSource()` input that the message names a `content` string or bytes, or `data` that JSON can store.",
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    CONTENT_R0003: {
      fix: "Give each item of the `contentSource()` input its own path, so no two items map to the path that the message names.",
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    CONTENT_R0004: {
      fix: "Pass an id or path that exists in the collection or Source that the message names on that ref. The `list()` method of the collection shows its ids.",
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    CONTENT_R0007: {
      fix: "Use the Blob + Database Store for the Workspace that the message names, because Content collections need its retained history.",
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    CONTENT_R0009: {
      fix: "Change the options of `content.publish()` as the message says, for example one `expect` entry `{ collection, id, digest }` for each document and no `collection` or `ids` next to it.",
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    CONTENT_R0010: {
      fix: "Set `VITEHUB_CONTENT_KEY` in the Server Env to 32 random bytes as base64 or hex, such as from `openssl rand -base64 32`.",
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    CONTENT_R0011: {
      fix: "Change the options of `content.schedule()`, or the `--at` option of `vitehub content`, as the message says, for example an ISO `at` time in the future with a time zone.",
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    CONTENT_R0012: {
      fix: "Use the Blob + Database Store for the Workspace that the message names, and add `contentSessionsSchema` from `vite-hub/content/database` to its Database.",
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    CONTENT_R0013: {
      fix: "Remove the document from the draft with `remove()`, then publish the deletion with `content.publish()`.",
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    CONTENT_R0014: {
      fix: "Run `vitehub content <command> --help`, then pass the option or argument that the message names with a valid value.",
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    CONTENT_R0015: {
      fix: "Start `vite dev` in this project, or pass `--url <origin>` of a running or deployed app. `VITEHUB_DEV_SERVER_URL` also names a server.",
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    CONTENT_R0016: {
      fix: "Use the Blob + Database Store for the Workspace that the message names, or publish now with `content.publish()`.",
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    CONTENT_R0017: {
      fix: "Merge or close the open pull request that the message names, then publish again.",
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    CONTENT_R0018: {
      fix: "Import `sqlite` from `vite-hub/content/sqlite` in `server/content.ts`, so ViteHub loads SQLite WASM while the Worker starts. Cloudflare Workers compile WebAssembly only at startup.",
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    /** A new commit of a `github()` Source failed validation, so the head stays on the last valid commit. */
    CONTENT_R0019: {
      fix: "Fix the document in the repository and push a new commit, then run `vitehub content advance` or call `content.sources.advance()`. `vitehub content head` and `content.sources.head()` show the rejected commit and the reason.",
      why: ({ source, sha, reason, head }: { source: string, sha: string, reason: string, head: string | null }) => `[vitehub] Commit ${sha} of Content source ${JSON.stringify(source)} failed validation, so Content keeps ${head ? `commit ${head}` : "no head"}: ${reason}`,
    },
    /** A `github()` Source has no token, so it has no head commit. */
    CONTENT_R0020: {
      fix: "Set `VITEHUB_GITHUB_TOKEN` in the Server Env, or pass `github({ auth })`. Content then serves one validated commit at a time from ViteHub KV.",
      why: ({ source }: { source: string }) => `[vitehub] Content source ${JSON.stringify(source)} reads GitHub without a token, so it has no head commit. Each load reads the latest commit of its branch without validation.`,
    },
    /** A `github()` Source has a token, but the app has no KV store for its head commit. */
    CONTENT_R0021: {
      fix: "Remove `kv: false` from `vitehub()`, or install `@vite-hub/kv`. ViteHub turns KV on when `server/content.ts` imports `github()`. If `server/content.ts` gets its Sources from another file, enable KV yourself. Content keeps the head commit in the `default` KV store.",
      why: ({ source }: { source: string }) => `[vitehub] Content source ${JSON.stringify(source)} has a GitHub token, but the app has no KV store, so it has no head commit. Each load reads the latest commit of its branch without validation.`,
    },
    /** The KV store failed while Content read or stored the head commit of a `github()` Source. */
    CONTENT_R0022: {
      fix: "Check the `default` KV store of the app. On Cloudflare, bind a KV namespace as `KV`. On Vercel, set `KV_REST_API_URL` and `KV_REST_API_TOKEN`. `vitehub kv get <key>` reads the head.",
      why: ({ source, key, reason }: { source: string, key: string, reason: string }) => `[vitehub] The KV store failed on ${JSON.stringify(key)} for Content source ${JSON.stringify(source)}: ${reason}. Reads do not fail: they serve the commit that this server already serves, or the latest commit of the branch without validation, and try KV again after 5 seconds.`,
    },
    /** Content could not store a parsed commit in ViteHub KV, so other server instances download and parse it again. */
    CONTENT_R0023: {
      fix: "Check the `default` KV store. A host can limit the size of one value: Cloudflare KV takes up to 25 MiB. `content.sources.head()` shows the cache key and how many reads missed.",
      why: ({ source, key, reason }: { source: string, key: string, reason: string }) => `[vitehub] Content could not store ${key} of Content source ${JSON.stringify(source)} in KV: ${reason}`,
    },
    /** A request to the GitHub push webhook route has no valid `X-Hub-Signature-256` header. */
    CONTENT_R0024: {
      fix: "Set the webhook secret in GitHub to the value of `VITEHUB_GITHUB_WEBHOOK_SECRET` in the Server Env, and set the content type to `application/json`. GitHub shows the failed delivery under Settings, Webhooks, Recent Deliveries.",
      why: ({ delivery }: { delivery: string | null }) => `[vitehub] The GitHub webhook delivery ${delivery ?? "without an id"} has no valid X-Hub-Signature-256 signature, so Content ignored it.`,
    },
    /** A signed push names a repository that no `github()` Source of Content reads. */
    CONTENT_R0025: {
      fix: "Point the webhook at the app whose `server/content.ts` reads this repository with `github({ repo })`, or remove the webhook from the repository.",
      why: ({ repo, heads }: { repo: string, heads: string }) => `[vitehub] Content received a GitHub push for ${repo}, but no github() Source reads that repository. Sources with a head: ${heads}.`,
    },
    /** The GitHub push webhook route has no secret, so it is disabled. */
    CONTENT_R0026: {
      fix: "Set `VITEHUB_GITHUB_WEBHOOK_SECRET` in the Server Env to the secret of the GitHub webhook. Without it, the head of each `github()` Source moves at most once per hour.",
      why: () => "[vitehub] The Content GitHub webhook route answers 404, because the Server Env has no VITEHUB_GITHUB_WEBHOOK_SECRET.",
    },
    /** `content.sources.at()` received a ref that is not a full SHA, a `pr/<number>` ref, or a safe branch name. */
    CONTENT_R0027: {
      fix: "Pass a full 40-character commit SHA, `pr/<number>` such as `pr/12`, or a branch name with letters, digits, and `. _ - /`, up to 200 characters.",
      why: ({ ref, reason }: { ref: string, reason: string }) => `[vitehub] content.sources.at() cannot open ref ${JSON.stringify(ref)}: ${reason}.`,
    },
    /** The repository of a `github()` Source has no commit, branch, or pull request with this ref. */
    CONTENT_R0028: {
      fix: "Check the ref on GitHub. A branch must match its full name, and a SHA must be a full commit SHA. A private repository needs `VITEHUB_GITHUB_TOKEN` with read access.",
      why: ({ source, ref }: { source: string, ref: string }) => `[vitehub] The repository of Content source ${JSON.stringify(source)} has no ref ${JSON.stringify(ref)}.`,
    },
    /** GitHub did not answer a ref lookup, for example because of a rate limit. */
    CONTENT_R0029: {
      fix: "Set `VITEHUB_GITHUB_TOKEN` in the Server Env for a higher GitHub rate limit, then try again. `content.sources.at()` holds each branch and pull request lookup for 30 seconds.",
      why: ({ source, ref, reason }: { source: string, ref: string, reason: string }) => `[vitehub] Content could not look up ref ${JSON.stringify(ref)} of Content source ${JSON.stringify(source)} on GitHub: ${reason}`,
    },
    /** A document of the commit that a ref points to does not load or parse, so Content opens no view of it. */
    CONTENT_R0030: {
      fix: "Fix the document on the branch or pull request and push a new commit. The next `content.sources.at()` call after 30 seconds reads the new commit.",
      why: ({ source, ref, sha, reason }: { source: string, ref: string, sha: string, reason: string }) => `[vitehub] Commit ${sha} of ref ${JSON.stringify(ref)} in Content source ${JSON.stringify(source)} failed validation: ${reason}`,
    },
    /**
     * `content.sources.allow()` denied a ref. A route answers a plain 404 and keeps this message in its logs, so a caller
     * cannot tell a private ref from a missing one.
     */
    CONTENT_R0031: {
      fix: "A ref renders publicly when the published branch contains its commit, or when it is the head of an open or merged pull request from the same repository, or from a fork with the `preview:enabled` label. Other refs need the preview cookie of `content.preview.enable()` or a link from `content.sources.sign()`.",
      why: ({ source, ref, reason }: { source: string, ref: string, reason: string }) => `[vitehub] Content source ${JSON.stringify(source)} does not serve ref ${JSON.stringify(ref)} to this request: ${reason}.`,
    },
    /** GitHub did not answer a check of `content.sources.allow()`, for example because of a rate limit. Content holds no decision. */
    CONTENT_R0032: {
      fix: "Set `VITEHUB_GITHUB_TOKEN` in the Server Env for a higher GitHub rate limit, then try again. `content.sources.allow()` holds each decision for 10 minutes.",
      why: ({ source, ref, reason }: { source: string, ref: string, reason: string }) => `[vitehub] Content could not check on GitHub whether ref ${JSON.stringify(ref)} of Content source ${JSON.stringify(source)} is public: ${reason}`,
    },
    /** GitHub refused the branch lookup of a `github()` Source with 403 or 429, so the head did not move. */
    CONTENT_R0035: {
      fix: "Wait until the GitHub rate limit resets, then run `vitehub content advance`. Check that the token in `VITEHUB_GITHUB_TOKEN` or `github({ auth })` can read the repository: GitHub also answers 403 when it cannot.",
      why: ({ source, head }: { source: string, head: string | null }) => `[vitehub] GitHub refused the branch lookup of Content source ${JSON.stringify(source)} with 403 or 429, as it does when the rate limit is hit, so Content keeps ${head ? `commit ${head}` : "no head"}.`,
    },
    /** `content.history()` read a page of a `github()` Source without a GitHub token, so it returned no entries. */
    CONTENT_R0040: {
      fix: "Set `VITEHUB_GITHUB_TOKEN` in the Server Env, or pass `github({ auth })`. Content then reads the commits of each page from GitHub and caches them per head commit.",
      why: ({ source }: { source: string }) => `[vitehub] content.history() returned no entries for Content source ${JSON.stringify(source)} because it reads GitHub without a token.`,
    },
    /** `defineContent({ previews })` is not valid, or does not find the `github()` Source that preview URLs read. */
    CONTENT_R0045: {
      fix: "Set `previews: true` with one `github()` Source in `sources`, or name the Source with `previews: { source: \"docs\" }`.",
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    /** `vitehub content check`: a document does not load or parse, such as frontmatter that is not valid YAML. Error. */
    CONTENT_R0060: {
      fix: "Fix the file that the finding names so it parses, then run `vitehub content check` again.",
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    /** `vitehub content check`: frontmatter does not match the `schema` of `contentSource(input, { schema })`. Error. */
    CONTENT_R0061: {
      fix: "Change the frontmatter field that the finding names so it matches the schema, or change the schema.",
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    /** `vitehub content check`: a link points to a missing page below a first path segment that holds pages, such as `/docs/kvv`. Error. */
    CONTENT_R0062: {
      fix: "Fix the link. When another route serves the path, add it to `defineContent({ check: { ignoreLinks } })` or pass `--ignore` to `vitehub content check`.",
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    /** `vitehub content check`: a link points to a path that no page of the Source serves, such as `/learn`. Another route may serve it. Warning. */
    CONTENT_R0063: {
      fix: "When another route of the app serves the path, add it to `defineContent({ check: { ignoreLinks } })` or pass `--ignore` to `vitehub content check`. Otherwise fix the link.",
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    /** `vitehub content check`: a link names a heading that the target page does not have. Warning. */
    CONTENT_R0064: {
      fix: "Link to the id of an existing heading. Content makes the id from the heading text, such as `#configure-the-store`.",
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    /** `vitehub content check`: a page has no title, or a title shorter than 10 or longer than 60 characters. Warning. */
    CONTENT_R0065: {
      fix: "Set `title` in the frontmatter, between 10 and 60 characters with the site's title pattern. Use `seo.title` when the heading must stay.",
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    /** `vitehub content check`: a page has no description, or one shorter than 70 or longer than 160 characters. Warning. */
    CONTENT_R0066: {
      fix: "Set `description` in the frontmatter, between 70 and 160 characters.",
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    /** `vitehub content check`: two or more pages have the same title or the same description. Warning. */
    CONTENT_R0067: {
      fix: "Give each page its own title and description, or its own `seo.title` and `seo.description`.",
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    /** `vitehub content check`: a page skips a heading level, such as an `h2` followed by an `h4`. Warning. */
    CONTENT_R0068: {
      fix: "Go down one heading level at a time. The page title counts as the `h1`.",
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    /** `content.check()` or `vitehub content check` could not run, such as for an unknown Source or a commit GitHub does not give. */
    CONTENT_R0069: {
      fix: "Name a Source from `defineContent({ sources })`, pass `sha` only for a `github()` Source, and check that GitHub can serve the commit. In local mode, pass a folder that exists.",
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    /** `content.pages()` or `content.page()` got an argument that is not valid. */
    CONTENT_R0070: {
      fix: "Pass a page path such as `/blog/hello` to `content.page()`, and a whole `offset` of 0 or more and a `limit` from 1 to 1000 to `content.pages()`.",
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    /** `content.sources.previewLinks()` found no pull request with that number, or the Source cannot list its files. */
    CONTENT_R0075: {
      fix: "Check the pull request number on GitHub. A private repository needs `VITEHUB_GITHUB_TOKEN` with read access to pull requests.",
      why: ({ source, pull, reason }: { source: string, pull: number, reason: string }) => `[vitehub] Content source ${JSON.stringify(source)} has no preview links for pull request #${pull}: ${reason}.`,
    },
    /** A publish with `publish: "pr"` opened its pull request, but Content could not sign the preview links of its pages. */
    CONTENT_R0076: {
      fix: "Set `VITEHUB_CONTENT_KEY` to 32 random bytes as base64 or hex, such as from `openssl rand -base64 32`. The pull request is open; `vitehub content previews comment --pr <number>` prints its links later.",
      why: ({ pull, reason }: { pull: number, reason: string }) => `[vitehub] Content opened pull request #${pull} but returned no preview links: ${reason}`,
    },
    /** `vitehub content previews comment --post` has no GitHub token to write the comment with. */
    CONTENT_R0077: {
      fix: "Set `VITEHUB_GITHUB_TOKEN` to a token that can write pull request comments, such as `${{ secrets.GITHUB_TOKEN }}` in a GitHub Action with `pull-requests: write`. Without --post, the command only prints the comment.",
      why: () => "[vitehub] `vitehub content previews comment --post` needs VITEHUB_GITHUB_TOKEN.",
    },
    /** GitHub refused to list, create, or update the preview comment of a pull request. */
    CONTENT_R0078: {
      fix: "Check that the token in `VITEHUB_GITHUB_TOKEN` can write issues and pull requests of the repository, and that the pull request exists.",
      why: ({ repo, pull, status, action }: { repo: string, pull: number, status: number, action: string }) => `[vitehub] GitHub answered ${status} when Content tried to ${action} the preview comment of ${repo}#${pull}.`,
    },
    /** `content.sources.previewLinks()` ran on a runtime without `defineContent({ previews })`, so the links would 404. */
    CONTENT_R0079: {
      fix: "Set `previews: true` in `defineContent()`, with one `github()` Source, so the app serves `/pr/<number>/<path>`.",
      why: () => "[vitehub] content.sources.previewLinks() needs defineContent({ previews: true }): without it, the app serves no /pr/<number> URLs.",
    },
    // Named errors. Keep these codes in alphabetical order.
    CONTENT_ACCESS_INVALID: {
      fix: "Set `defineContent({ access: \"public\" })` to serve Content to everyone, or remove `access`.",
      why: ({ access }: { access: unknown }) => `[vitehub] defineContent({ access }) must be "public" when it is set, received ${JSON.stringify(access)}.`,
    },
    CONTENT_AUTHORIZE_INVALID: {
      fix: "Set `defineContent({ authorize })` to a function that gets `{ user, action }` and returns true to allow.",
      why: () => "[vitehub] defineContent({ authorize }) must be a function.",
    },
    CONTENT_CACHE_KEY_UNKNOWN: {
      why: ({ key }: { key: string }) => `Unknown content cache key ${JSON.stringify(key)}.`,
      fix: "Pass `content.cache` a key that starts with the name of a Content source and a colon, such as `default:<path>`.",
    },
    CONTENT_CAN_INPUT_INVALID: {
      fix: "Pass `content.can()` `{ action: \"read\" }` without `collection` or `id`, or `{ collection, action, id? }` with `read-draft`, `write`, or `publish`. Set `user` to the Auth user or null, and `actor` to an Agent Actor with an `id`.",
      why: ({ problem }: { problem: string }) => `[vitehub] ${problem}`,
    },
    CONTENT_COLLECTIONS_UNDEFINED: {
      fix: "Add `workspace` and `collections` to `defineContent()` in `server/content.ts`, or add `extends: cms` from `vite-hub/cms`.",
      why: ({ method }: { method?: string }) => method === undefined ? "[vitehub] This Content runtime has no collections. Add defineContent({ workspace, collections })." : `[vitehub] content.preview.${method}() needs document collections. Add defineContent({ workspace, collections }).`,
    },
    CONTENT_COLLECTIONS_WORKSPACE_MISSING: {
      fix: "Add `extends: cms` from `vite-hub/cms` to `defineContent()`, or set `workspace` to the name of a Workspace with retained history.",
      why: () => "[vitehub] defineContent({ collections }) requires extends: cms from vite-hub/cms, or workspace: the name of a Workspace with retained history.",
    },
    CONTENT_COLLECTION_DEFINITION_INVALID: {
      fix: "Define the collection with `documents()` or `singleton()` from `@vite-hub/content/collections`.",
      why: ({ name }: { name: string }) => `[vitehub] Content collection ${JSON.stringify(name)} must be defined with documents() or singleton() from @vite-hub/content/collections.`,
    },
    CONTENT_COLLECTION_NAME_TAKEN: {
      fix: "Rename the collection in `defineContent({ collections })` or the Source in `defineContent({ sources })`, so no collection has the name of a Source.",
      why: ({ name }: { name: string }) => `[vitehub] Content collection ${JSON.stringify(name)} has the same name as a Content source.`,
    },
    CONTENT_COLLECTION_PATHS_OVERLAP: {
      fix: "Change the `path` globs of the two collections that the message names, so no file matches both.",
      why: ({ name, path, other, otherPath }: { name: string, path: string, other: string, otherPath: string }) => `[vitehub] Content collection paths ${JSON.stringify(name)} (${path}) and ${JSON.stringify(other)} (${otherPath}) overlap.`,
    },
    CONTENT_COLLECTION_UNKNOWN: {
      fix: "Pass the name of a collection from `defineContent({ collections })`, or add the collection there.",
      why: ({ name }: { name: unknown }) => `[vitehub] Unknown Content collection ${JSON.stringify(name)}. Define it in defineContent({ collections }).`,
    },
    CONTENT_DIGEST_INVALID: {
      fix: "Pass `ifDigest` and `ifPublishedDigest` as the `digest` string of an earlier read, or as null.",
      why: ({ option }: { option: "ifDigest" | "ifPublishedDigest" }) => `[vitehub] Content ${option} must be a digest string or null.`,
    },
    CONTENT_DOCUMENTS_COMPONENTS_INVALID: {
      fix: "Set `components` to a record keyed by lowercase Comark tags, such as `{ alert: { kind: \"block\", props: { type: { type: \"string\" } } } }`.",
      why: ({ problem }: { problem: string }) => `[vitehub] ${problem}`,
    },
    CONTENT_DOCUMENTS_FIELDS_INVALID: {
      fix: "Set `fields` to a record of Standard Schema validators, such as `{ title: z.string() }`, and pass a validator to `optional()`.",
      why: ({ problem }: { problem: string }) => `[vitehub] ${problem}`,
    },
    CONTENT_DOCUMENTS_FIELD_RESERVED: {
      fix: "Rename the `derivedFrom` field: a collection with `locales` keeps that key for the source of each translation.",
      why: ({ path }: { path: string }) => `[vitehub] documents(${JSON.stringify(path)}) has locales, so derivedFrom is the reserved key where a translation records its source. Rename the field.`,
    },
    CONTENT_DOCUMENTS_LABEL_INVALID: {
      fix: "Set `label` to a non-empty string, or to `{ singular, plural }` for `documents()`, and set `titleField` to the name of one of the fields.",
      why: ({ problem }: { problem: string }) => `[vitehub] ${problem}`,
    },
    CONTENT_DOCUMENTS_LOCALES_INVALID: {
      fix: "Set `locales` to a list of different locale tags, such as `['en', 'es']`, and put `{locale}` once in each path as a whole folder before the first wildcard, such as `docs/{locale}/**/*.md`.",
      why: ({ problem }: { problem: string }) => `[vitehub] ${problem}`,
    },
    CONTENT_DOCUMENTS_OPTIONS_INVALID: {
      fix: "Pass `{ path, fields }` to `documents()` or `singleton()`, with `search` as a list of field names and `editing` as `{ lease?: boolean }`.",
      why: ({ problem }: { problem: string }) => `[vitehub] ${problem}`,
    },
    CONTENT_DOCUMENTS_PATH_INVALID: {
      fix: "Set the `documents()` path to relative globs with `*`, `**`, or `?` that end in one shared extension, such as `posts/**/*.md`, and the `singleton()` path to one file, such as `settings.json`.",
      why: ({ problem }: { problem: string }) => `[vitehub] ${problem}`,
    },
    CONTENT_DOCUMENTS_URL_INVALID: {
      fix: "Set `url` to a pattern that starts with `/` and names only `:id`, `:locale`, and fields, such as `/blog/:id`, or to a function that returns such a path or null. Set `markdown` to a function, and only with `url`.",
      why: ({ problem }: { problem: string }) => `[vitehub] ${problem}`,
    },
    CONTENT_DOCUMENT_ID_INVALID: {
      fix: "Pass a document id as a relative path without an extension, such as `hello` or `2026/hello`.",
      why: ({ id }: { id: unknown }) => `[vitehub] Content document id must be a relative path such as "hello" or "2026/hello", received ${JSON.stringify(id)}.`,
    },
    CONTENT_DOCUMENT_OUTSIDE_COLLECTION: {
      fix: "Pass an id that a `path` glob of the collection matches, or add a glob for it in `documents({ path })`.",
      why: ({ id, collection, path }: { id: string, collection: string, path: string }) => `[vitehub] Content document ${JSON.stringify(id)} is outside collection ${JSON.stringify(collection)} (${path}).`,
    },
    CONTENT_EDITOR_FAILED: {
      why: ({ command, code }: { command: string, code: number | null }) => `The editor \`${command}\` exited with code ${code}.`,
      fix: "Set `$VISUAL` or `$EDITOR` to an editor command that waits until you close the file and then exits with code 0, such as `code --wait`. Or pass `--file <path>` to `vitehub content edit`.",
    },
    CONTENT_HISTORY_CURSOR_INVALID: {
      fix: "Pass the `cursor` that the previous `content.history()` call returned, or no cursor for the first page.",
      why: ({ cursor }: { cursor: string }) => `[vitehub] content.history() received the cursor ${JSON.stringify(cursor)}, which is not a cursor of a Source page. Pass the cursor of the previous call.`,
    },
    CONTENT_HISTORY_INPUT_INVALID: {
      fix: "Call `content.history(path, { limit })` with an app path such as `/docs/guide`, an options object, and a whole `limit` from 1 to 100.",
      why: ({ problem }: { problem: string }) => `[vitehub] content.history() ${problem}`,
    },
    CONTENT_LIVE_DOCUMENT_HELD: {
      why: ({ holder }: { holder: string }) => `${holder} is editing this document alone. Live edits save once they stop or someone takes over.`,
      fix: "Wait until the person that the message names stops editing, or take over their edit lease. Then open the live document again.",
    },
    CONTENT_LIVE_INVALID: {
      fix: "Set `defineContent({ live })` to `\"auto\"` or `false`, or remove it.",
      why: () => "[vitehub] defineContent({ live }) must be 'auto' or false.",
    },
    CONTENT_LIVE_ROOM_UNKNOWN: {
      why: ({ documentId }: { documentId: string }) => `No Content Markdown document matches the live room ${JSON.stringify(documentId)}.`,
      fix: "Join the live room of a Markdown document of a Content collection: `<collection>/<id>`, or the collection name of a singleton.",
    },
    CONTENT_LOCALE_UNKNOWN: {
      fix: "Pass a locale from the `locales` of the collection, or no locale when the collection has none.",
      why: ({ collection, locale, locales }: { collection: string, locale: unknown, locales: readonly string[] | undefined }) => locales === undefined ? `[vitehub] Content collection ${JSON.stringify(collection)} has no locales, so it takes no locale. Received ${JSON.stringify(locale)}.` : `[vitehub] Content collection ${JSON.stringify(collection)} has the locales ${JSON.stringify(locales)}, received ${JSON.stringify(locale)}.`,
    },
    CONTENT_PIN_SHA_INVALID: {
      fix: "Pass a full 40-character commit SHA to `content.sources.pin()`. `content.history()` and GitHub show the SHA of each commit.",
      why: ({ sha }: { sha: unknown }) => `[vitehub] content.sources.pin() needs a full 40-character commit SHA, received ${JSON.stringify(sha)}.`,
    },
    CONTENT_PLUGINS_PARSE_PLUGIN: {
      fix: "Move the Comark parse plugin from `defineContent({ plugins })` to `defineContent({ markdown: { plugins } })`.",
      why: ({ name }: { name: string | undefined }) => `[vitehub] ${JSON.stringify(name)} is a Comark parse plugin, and defineContent({ plugins }) takes only Comark Content plugins. Pass it in defineContent({ markdown: { plugins } }).`,
    },
    CONTENT_PRESET_CONFIGURE_INVALID: {
      fix: "Return an options object from the `configure()` function of the Content preset, with `authorize` as a function when it is set.",
      why: ({ preset, returned }: { preset: string, returned: string }) => `[vitehub] Content preset ${JSON.stringify(preset)} must return ${returned} from configure().`,
    },
    CONTENT_PRESET_INVALID: {
      fix: "Set `defineContent({ extends })` to a Content preset, such as `cms` from `vite-hub/cms`, or to a tuple `[cms, { ... }]` whose second item is a plain object.",
      why: ({ reason }: { reason: string }) => reason,
    },
    CONTENT_PRESET_OPTION_UNKNOWN: {
      fix: "Remove the option that the message names from `extends: [preset, { ... }]`, or correct its spelling to an option that the preset declares.",
      why: ({ reason }: { reason: string }) => reason,
    },
    CONTENT_PRESET_WORKSPACE_CONFLICT: {
      fix: "Remove `workspace` from `defineContent()`, and name the Workspace in the preset options, such as `extends: [cms, { workspace: \"content\" }]`.",
      why: () => "[vitehub] defineContent({ extends }) sets workspace. Remove workspace, or name the Workspace in the preset options.",
    },
    CONTENT_PREVIEW_ASYNC_CONTEXT_MISSING: {
      fix: "Run Content on a host with `AsyncLocalStorage`. On Cloudflare Workers, add the `nodejs_als` compatibility flag to the Wrangler configuration.",
      why: () => "[vitehub] Content preview needs an async request context (AsyncLocalStorage). On Cloudflare Workers, enable the nodejs_als compatibility flag.",
    },
    CONTENT_PREVIEW_DOCUMENT_INVALID: {
      fix: "Pass `{ collection, id }` of the one document that the frame previews to `content.preview.sign()`, with a short collection name and id.",
      why: ({ tooLong }: { tooLong: boolean }) => tooLong ? "[vitehub] content.preview.sign() received a collection and id that are too long." : "[vitehub] content.preview.sign() requires { collection, id }: the one document the frame previews.",
    },
    CONTENT_PREVIEW_EVENT_INVALID: {
      fix: "Pass the H3 event of the route, or its `Request`, to the `content.preview` method.",
      why: ({ method }: { method: string }) => `[vitehub] content.preview.${method}() requires an H3 event or a Request.`,
    },
    CONTENT_PREVIEW_MAX_AGE_INVALID: {
      fix: "Pass `maxAge` as whole seconds from 60 to 86400, or omit it.",
      why: ({ option, min, max }: { option: string, min: number, max: number }) => `[vitehub] ${option} must be whole seconds from ${min} to ${max}.`,
    },
    CONTENT_PREVIEW_NITRO_REQUIRED: {
      fix: "Use `defineContentPreviewPlugin()` in a Nitro 3 app, such as Vite with Nitro or Nuxt 5. Elsewhere, wrap reads in `content.preview.run(event, callback)`.",
      why: () => "[vitehub] defineContentPreviewPlugin() needs a Nitro 3 app.",
    },
    CONTENT_PREVIEW_PULL_INVALID: {
      fix: "Pass the pull request number, a whole number from 1, to `content.sources.previewLinks()`.",
      why: ({ pull }: { pull: unknown }) => `[vitehub] content.sources.previewLinks() needs a pull request number, received ${JSON.stringify(pull)}.`,
    },
    CONTENT_PREWARM_HEAD_NOT_VISIBLE: {
      fix: "Retry the prewarm job. If retries keep failing, check that the webhook and the Queue consumer use the same default KV store.",
      why: ({ source, sha, headVersion }: { source: string, sha: string, headVersion: number }) => `[vitehub] Content source ${JSON.stringify(source)} has not read published head ${sha} (version ${headVersion}) from KV.`,
    },
    CONTENT_PUBLIC_SOURCE_UNDECIDED: {
      fix: "Set `defineContent({ authorize })` to decide who reads, or `access: \"public\"` when the Content is public, or turn off the readers that the message names.",
      why: ({ readers, names, route }: { readers: string, names: string, route: boolean }) => `[vitehub] ${readers} would serve the potentially token-backed Source ${names} to everyone, and a github() Source or an opaque registered name, reader, or factory can read a private repository with a token. Set authorize to decide who may read (it gets action: "read"), or access: "public" when the content is public (or pass a direct non-GitHub Source definition).${route ? " route: false removes /api/content/**." : ""}`,
    },
    CONTENT_PUBLISH_PR_UNSUPPORTED: {
      fix: "Set `publish: \"pr\"` only for a Workspace on the GitHub store, such as `extends: [cms, { repo, publish: \"pr\" }]`, or remove it.",
      why: ({ workspace }: { workspace: string }) => `[vitehub] publish: 'pr' needs a Workspace Store with pull requests, but Workspace ${JSON.stringify(workspace)} has none. Use the GitHub store.`,
    },
    CONTENT_READ_REF_CONFLICT: {
      fix: "Pass `ref` or `revision` to the read, not both.",
      why: ({ method }: { method: string }) => `[vitehub] Content ${method}() takes ref or revision, not both.`,
    },
    CONTENT_REF_INVALID: {
      fix: "Pass `ref: \"draft\"` or `ref: \"published\"`, or omit `ref`.",
      why: ({ ref }: { ref: unknown }) => `[vitehub] Content ref must be "draft" or "published", received ${JSON.stringify(ref)}.`,
    },
    CONTENT_RESOLVE_PATH_INVALID: {
      fix: "Pass an app path as a string, such as `/blog/hello`, to `content.resolve()`.",
      why: () => "[vitehub] Content resolve() requires an app path such as \"/blog/hello\".",
    },
    CONTENT_REVISIONS_LIMIT_INVALID: {
      fix: "Pass `limit` as a whole number from 1 to 100 and `scanLimit` from 1 to 1,000 to `revisions()`, or omit them.",
      why: ({ option }: { option: "limit" | "scanLimit" }) => option === "limit" ? "[vitehub] Content revisions() limit must be an integer from 1 to 100." : "[vitehub] Content revisions() scanLimit must be an integer from 1 to 1,000.",
    },
    CONTENT_REVISION_METADATA_INVALID: {
      fix: "Pass `metadata` as a plain object, or omit it.",
      why: () => "[vitehub] Content revision metadata must be an object.",
    },
    CONTENT_ROUTE_INVALID: {
      fix: "Set `defineContent({ route })` to `true` or `false`. To serve Content to everyone, set `access: \"public\"`.",
      why: ({ route }: { route: unknown }) => route === "public" ? '[vitehub] defineContent({ route: "public" }) is now defineContent({ access: "public" }). route only turns /api/content/** on or off.' : `[vitehub] defineContent({ route }) must be true or false, received ${JSON.stringify(route)}.`,
    },
    CONTENT_RUNTIME_EXPORT_INVALID: {
      why: "[vitehub] server/content.ts must default-export the defineContent() runtime.",
      fix: "Default-export the result of `defineContent({ ... })` from `server/content.ts`.",
    },
    CONTENT_SEO_FIELD_INVALID: {
      fix: "Pass an options object to `seo()`, with `image` as a Standard Schema validator, such as `seo({ image: image() })`.",
      why: ({ problem }: { problem: string }) => `[vitehub] ${problem}`,
    },
    CONTENT_SEO_OPTIONS_INVALID: {
      fix: "Change the `defineContent({ seo })` option that the message names to the shape that the message shows, such as `{ site: \"https://example.com\", sitemap: true }`.",
      why: ({ problem }: { problem: string }) => `[vitehub] defineContent({ seo }) ${problem}`,
    },
    CONTENT_SESSION_KIND_INVALID: {
      fix: "Pass `kind: \"edit\"` or `kind: \"live\"` to `content.sessions.acquire()`, and `kind: \"view\"` or `kind: \"edit\"` to `content.sessions.report()`.",
      why: ({ problem }: { problem: string }) => `[vitehub] ${problem}`,
    },
    CONTENT_SESSION_TOKEN_INVALID: {
      fix: "Pass `session` as a token of 8 to 128 letters, digits, `-`, or `_`, such as `crypto.randomUUID()`, one for each tab or client.",
      why: () => "[vitehub] content.sessions requires session: a token of 8 to 128 letters, digits, - or _, one per tab or client.",
    },
    CONTENT_SESSION_USER_INVALID: {
      fix: "Pass `user` as `{ id, name?, image? }` with strings, and an `id` of 1 to 256 characters.",
      why: ({ problem }: { problem: string }) => `[vitehub] ${problem}`,
    },
    CONTENT_SINGLETON_ID_MISMATCH: {
      fix: "Omit the id when you call a singleton method, or pass the id of the singleton.",
      why: ({ name, id, path, received }: { name: string, id: string, path: string, received: unknown }) => `[vitehub] Content singleton ${JSON.stringify(name)} has the id ${JSON.stringify(id)} (${path}). Omit the id, or pass ${JSON.stringify(id)}; received ${JSON.stringify(received)}.`,
    },
    CONTENT_SITE_INVALID: {
      fix: "Pass `site` as an absolute http or https URL, such as `https://example.com`.",
      why: ({ site }: { site: unknown }) => `[vitehub] site must be an absolute http(s) URL such as https://example.com, received ${JSON.stringify(site)}.`,
    },
    CONTENT_SOURCE_CONFLICT: {
      why: "Define either source or sources, not both.",
      fix: "Keep `source` for one Content source, or move it into `sources` beside the others, in `defineContent()`.",
    },
    CONTENT_SOURCE_DIGEST_INVALID: {
      fix: "Pass `sourceDigest` only when you save a translation with its `locale`, and set it to `source.digest` of the `get()` that you translated.",
      why: ({ problem }: { problem: string }) => `[vitehub] ${problem}`,
    },
    CONTENT_SOURCE_HEAD_UNVALIDATED: {
      fix: "Run `vitehub content advance` or call `content.sources.advance()`. `content.sources.head()` shows a rejected commit and the reason.",
      why: ({ source }: { source: string }) => `[vitehub] Content source ${JSON.stringify(source)} has no validated head. Resolve its GitHub commit, then call content.sources.advance().`,
    },
    CONTENT_SOURCE_MISSING: {
      why: ({ name }: { name: string }) => `Content source ${JSON.stringify(name)} is missing.`,
      fix: "Give the source that the message names a value in `defineContent({ sources })`, or remove its key.",
    },
    CONTENT_SOURCE_OPTIONS_INVALID: {
      fix: "Pass `contentSource(input, { url })` a path that starts with `/`, such as `/:id`, or a function, with `label` as text and `seo` and `markdown` as functions. `label`, `seo`, and `markdown` need `url`.",
      why: ({ problem }: { problem: string }) => `[vitehub] ${problem}`,
    },
    CONTENT_SOURCE_REFS_UNSUPPORTED: {
      fix: "Update `@vite-hub/source` to the version that `@vite-hub/content` depends on, such as with `pnpm update @vite-hub/source`.",
      why: ({ source, action }: { source: string, action: "open" | "check" }) => `[vitehub] Content source ${JSON.stringify(source)} cannot ${action} refs. Update @vite-hub/source.`,
    },
    CONTENT_SOURCE_UNKNOWN: {
      why: ({ name }: { name: string }) => `Unknown content source ${JSON.stringify(name)}.`,
      fix: "Pass `content.from()` the name of a source that `defineContent({ sources })` declares, or `default` for `defineContent({ source })`.",
    },
    CONTENT_SOURCE_VIEWS_DISPOSED: {
      fix: "Call `content.sources.at()` before `content.dispose()`, or create a new runtime with `defineContent()`.",
      why: () => "[vitehub] Content source views have been disposed.",
    },
    CONTENT_SOURCE_WITHOUT_HEAD: {
      fix: "Pass the name of a `github()` Source from `defineContent({ sources })`, or omit it for the `default` Source.",
      why: ({ source, heads }: { source: string, heads: string }) => `[vitehub] Content source ${JSON.stringify(source)} has no head. Only github() Sources have one. Sources with a head: ${heads}.`,
    },
    CONTENT_WRITE_LEASE_INVALID: {
      fix: "Pass `lease: \"override\"` to write over the edit lease of another tab, or omit `lease`.",
      why: () => "[vitehub] Content write lease must be 'override' or omitted.",
    },
    CONTENT_WRITE_SESSION_INVALID: {
      fix: "Pass `session` as the `content.sessions` token of the caller, or omit it.",
      why: () => "[vitehub] Content write session must be the content.sessions token of the caller.",
    },
  },
})
