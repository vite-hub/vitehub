---
title: Workspace server API
description: Read, write, diff, snapshot, sync, and run sessions on a Workspace from server code.
navigation.title: Server API
navigation.order: 4
icon: i-lucide-code-2
---

## Public imports

| Import | Use |
| --- | --- |
| `defineWorkspace` from `vite-hub/workspace` | Declare a Workspace Definition. |
| `useWorkspace` from `vite-hub/workspace` | Read, write, diff, snapshot, sync, or start sessions. |
| `file`, `glob`, `github`, `markdown`, `mcpResources`, `fetch`, `custom` from `vite-hub/workspace` | Declare Source Bindings. MCP Resources needs `@modelcontextprotocol/sdk`; see [Source Binding options](/docs/workspace/configure#source-binding-options). |
| `createWorkspaceTools` from `vite-hub/workspace` | Build AI SDK tools for a Workspace. |
| Source resolution, request, and preparation helpers from `vite-hub/workspace/runtime` | Connect resolved Sources and process readiness to runtime facades. |
| `defineWorkspaceFileHandler`, `readWorkspaceFileResponse` from `vite-hub/workspace/server` | Serve Workspace files from a route. `defineWorkspaceFileHandler({ base, workspace, baseURL? })` returns a Fetchable route, `{ fetch(request) }`. For a retained application prefix, pass Nitro's `baseURL`; `base` is the route path within it. The file path is the URL path after this combined prefix. A missing or unsafe path gets a `404` Response. |
| `registerWorkspacePlugin` from `vite-hub/workspace` | [Add rules and hooks](#add-plugins-to-a-workspace) to a Workspace you do not define. |
| `hubWorkspace` from `@vite-hub/workspace/vite` | Add discovery, generated types, assets, and runtime setup. |
| `@vite-hub/workspace/loader`, `@vite-hub/workspace/test` | Add loaders, or register test Workspaces. |

`vite-hub/workspace` exports the definition, Source Binding, rule, hook, store, sync, facade, and session types. `vite-hub/workspace/runtime` exports the Source resolution types.

## Runtime facade

`useWorkspace(name)` returns read access. `useWorkspace(name, { mode: 'write' })` returns write access.

To inspect an existing Workspace without refreshing it, pass `refresh: false`:

```ts
import { useWorkspace } from 'vite-hub/workspace'

const workspace = useWorkspace('docs', { refresh: false })
```

This reuses the saved snapshots of Sources with `materialize: 'startup'` when they are ready and match the current Source config, even if the upstream content changed. Missing or outdated snapshots still materialize. Without `refresh`, or with `true`, startup Sources refresh as normal. Custom Stores without `getMeta` or `setMeta` keep ownership and Source snapshots only while the Store instance lives.

Before build and startup overwrite existing files, they save a pending checkpoint. Cleanup accepts the new owner only after the checkpoint completes, so failed rollback metadata cannot give ownership of restored files after the Store reopens. If completion fails after the file and owner were committed, the operation reports the error and keeps the output. Cleanup keeps that output unless completion was saved. Retry the Source operation to set ownership again.

A Store can return `revision` from `stat()` to identify a file version. This opaque value must change when the file changes or is recreated, even with the same bytes. A write that changes nothing can keep it. Memory and local Stores provide it. Cleanup uses the revision and content digest to retry an interrupted removal. If the Store cannot identify the remaining file, cleanup keeps it and reports the removal as unclear. Inspect it, remove the file yourself if it is still generated output, then retry cleanup.

`refresh: false` works only in read mode. It does not stop refreshes of other Sources or change explicit `sync()` and `materializeSources()` calls on a writable facade.

| Surface | Methods |
| --- | --- |
| `workspace.fs` read mode | `readFile`, `stat`, `exists`, `list`, `glob`, `search` |
| `workspace.fs` write mode | read methods plus `writeFile`, `appendFile`, `mkdir`, `rm`, `movePath`, `copyPath` |
| writable facade | `diff`, `snapshot`, `history.checkpoint`, `history.rebase`, `materializeSources`, `sync`, `startSession`, optional Store metadata methods `getMeta` and `setMeta`, and `tools` |
| tools | default tools, `tools.inspect(options)`, `tools.write(options)`, `tools.none()` |

Workspace shell tools block the limited `curl` by default. To allow requests to visible Source targets, pass `sourceRequests: true` to `createWorkspaceTools(workspace, { sourceRequests: true })` or `workspace.tools.inspect({ sourceRequests: true })`. The Agent `workspaceShell()` Capability turns these requests on.

When the model turn is cancelled, AI SDK tool cancellation reaches the Shell provider and Workspace Session. Provider work and Source requests stop.

### Runtime method options

| Method | Options | Behavior |
| --- | --- | --- |
| `readFile(path, options?)` | `encoding?: 'utf8' \| 'binary'` | UTF-8 text by default. Binary reads return `Uint8Array`. |
| `writeFile(path, content, options?)` | `mediaType?`, `metadata?` | Writes text or binary content, with optional file metadata. |
| `list(path?, options?)` | `recursive?: boolean` | Lists direct children or the full subtree. |
| `glob(pattern, options?)` | `cwd?: string` | Matches one pattern or an array, from an optional directory. Returned paths stay relative to the Workspace root. |
| `search(query)` | `pattern`, `cwd?`, `paths?`, `regex?`, `caseSensitive?`, `limit?` | Searches text. Default: case-insensitive literal pattern, limit `100`. |
| `mkdir(path, options?)` | `recursive?: boolean` | Creates a directory. |
| `rm(path, options?)` | `recursive?: boolean`, `force?: boolean` | Removes a file or directory if the write rules allow it. |
| `movePath(from, to, options?)` | `overwrite?: boolean` | Moves a path. An existing destination fails without `overwrite`. |
| `copyPath(from, to, options?)` | `overwrite?: boolean` | Copies a path. An existing destination fails without `overwrite`. |
| `snapshot(options?)` | `name?: string` | Saves the current tree, with an optional name. |
| `history.rebase(options?)` | `takeRemote?: string[]` | Reloads a remote Store and keeps staged paths. A listed path takes the remote version only when both sides changed. Other overlapping changes stay conflicts. Listed paths must be writable, so a Source path fails. |
| `diff(options?)` | `from?: WorkspaceSnapshot` | Compares the current tree with the given snapshot or the Store baseline. |
| `materializeSources(options?)` | `abortSignal?`, `details?: 'paths'`, `onProgress?`, `sources?`, `path?` | Copies in every Source, or selected Sources or paths, with cancellation and progress. |
| `getMeta(key)` / `setMeta(key, value)` | Store-defined | Reads or writes Store metadata, if the Store supports it. Workspace reserves keys that start with `source:`, `workspace:`, `workspace-file-`, or `loader:`, and `setMeta` rejects them. |

If you wrap a writable facade with your own `fs`, call `forwardWorkspaceFacade(base, wrapped)` from `vite-hub/workspace/runtime` to keep Source Sync working. It forwards Source guards and saved sync metadata without exposing privileged setters. Send public writes to the original facade.

Source cleanup at startup and build tracks ownership by Workspace name. When definitions share a Store, removing or refreshing one keeps the files another one wrote last. A shared path holds the latest write.

File `metadata.source` holds only the name of the Source that owns the file. The local Store rejects other values before it writes bytes or reads a content stream, and keeps the existing content and metadata.

When build Sources share a mount, loaders that write through `ctx.store` must keep the input item's `metadata.source`. For derived output in a Source's mount, set it to that Source's key. An unclear write fails before it stores the file. Later syncs can then remove only that Source's output.

Each materialized Source reports its provider, cache result, revision, duration, and counts of added, updated, unchanged, and removed files. File paths stay out of the result unless you set `details: 'paths'`. Set it only when the caller may see file names.

## Retained folder history

Retained history publishes a full folder and lets you read earlier versions. It needs a Store with `history`, such as the [Blob + Database Store](/docs/workspace/configure#blob-database-store).

```ts
import { useWorkspace } from 'vite-hub/workspace'

const workspace = useWorkspace('drop', { mode: 'write' })
const base = await workspace.history.head()
const revision = await workspace.history.commit({
  ifHead: base?.id ?? null,
  files: {
    'index.html': '<h1>Hello</h1>',
    'assets/data.bin': new Uint8Array([0, 255]),
  },
  message: 'Publish the site',
  metadata: { author: 'maxi' },
})

const version = await workspace.history.open(revision.id)
const html = await version.readFile('index.html')
const bytes = await version.readFile('assets/data.bin', { encoding: 'binary' })
const page = await workspace.history.list({ limit: 20 })
const next = page.cursor
  ? await workspace.history.list({ cursor: page.cursor, limit: 20 })
  : undefined
const usage = await workspace.history.usage()
```

`files` is the full file set. Paths you leave out are deleted from the next version, and earlier versions keep their bytes.

- Path checks, write rules, `maxBytes`, validators, hooks, and Source write grants apply to every addition, change, and deletion.
- Unchanged files keep their MIME type and metadata.
- Validators can change content and file attributes, but cannot rename paths or change operations.
- A file value is content, or `{ content, mediaType?, metadata? }`. Plain content gets its MIME type from the path.
- File and revision metadata must be JSON-safe. The `metadata.source` rule for files does not apply to revision metadata.

### Refs

History has named refs, each with its own head and timeline. Refs share revisions and bytes, so `history.open(id)` opens a revision from any ref, and the same bytes on two refs upload once. Calls without `ref` use `main`. Ref names use letters, numbers, `_`, and `-`, joined by single `.` or `/`, up to 128 characters. Invalid names throw `WORKSPACE_R0071`.

Drafts are the usual reason for a ref. Save each edit to `draft`, then commit the chosen files to `published`:

```ts fragment
const draft = await workspace.history.head({ ref: 'draft' })
const saved = await workspace.history.commit({
  ref: 'draft',
  ifHead: draft?.id ?? null,
  changes: {
    put: { 'posts/hello.md': { content: markdown, metadata: { author: 'maxi' } } },
    delete: ['posts/old.md'],
  },
  message: 'Save hello',
})

const view = await workspace.history.open(saved.id)
const published = await workspace.history.head({ ref: 'published' })
await workspace.history.commit({
  ref: 'published',
  ifHead: published?.id ?? null,
  changes: { put: { 'posts/hello.md': await view.readFile('posts/hello.md') } },
  message: 'Publish hello',
})
```

`changes` patches the head of `ref`. `put` adds or replaces files, `delete` removes them, and other paths stay the same. It uploads only the bytes it adds.

- Deleting a path missing from the head throws `WORKSPACE_NOT_FOUND`.
- A path goes in `put` or `delete`, not both.
- A commit takes `files` or `changes`, never both.

A commit always builds on the head of its own ref. There is no `base` option. To copy files from another ref, open that revision and `put` the files, as in the publish step above. Each ref stays a straight line of revisions that `ifHead` protects.

In both forms, rules, validators, hooks, `maxBytes`, and Source write grants run on every changed path. A `put` with the same content as the head skips them. With `{ content, mediaType, metadata }`, a different MIME type or metadata counts as a change.

### Conflicts

`ifHead` is required: `null` for the first revision on a ref, then a revision id. If the ref head changed, the commit fails with `WORKSPACE_CONFLICT` and `details.ref`, `details.expected`, and `details.actual`. Commits to other refs never conflict. Catch `isWorkspaceConflict(error)` and load the new head before you merge the edits. A conflict changes no ref. After any other error, read the head before you retry, because Database responses and post-write hooks can fail after publication.

| Method | Result |
| --- | --- |
| `history.commit({ ref?, ifHead, files, message?, metadata? })` | A revision with `id`, `ref`, `parentId`, `createdAt`, optional message and metadata, file count `files`, and total `bytes`. |
| `history.commit({ ref?, ifHead, changes: { put?, delete? }, message?, metadata? })` | The same revision, built from the ref head plus the changes. |
| `history.head({ ref? })` | Current revision of the ref, or `null` before its first commit. On the GitHub Store, revisions from `head()` and `list()` have no `files` and `bytes`, because counting them needs one more request per commit. `open(id).revision` has them. |
| `history.list({ ref?, cursor?, limit?, path? })` | `{ revisions, cursor? }` for one ref, newest first. Default limit `20`, maximum `100`. Pass the cursor back unchanged with the same ref. A cursor from another ref throws `WORKSPACE_R0070`. With `path`, only revisions that changed that file or folder. |
| `history.refs()` | `[{ name, head }]` for every ref with at least one revision, sorted by name. |
| `history.open(id)` | Read-only view with `revision`, `list(path?, options?)`, `stat(path)`, and `readFile(path, { encoding? })`. UTF-8 by default. `'binary'` returns `Uint8Array`. On the GitHub Store, `preload(paths)` reads many files in one request first. |
| `history.digest(bytes)` | The Store's digest for file bytes: SHA-256, or the Git blob sha on the [GitHub Store](/docs/workspace/configure#github-store). Compare it with the `digest` of entries from `history.open(id).list()`. |
| `history.usage()` | `{ bytes, objects }` of unique file content in committed revisions on every ref. Excludes manifests, Database storage, Blob metadata, and failed uploads. |

- Read mode has `head`, `list`, `refs`, `open`, and `usage`. `commit` needs write mode.
- `capabilities().retainedHistory` on the writable facade tells you if the Store supports history. Stores without it throw `WORKSPACE_R0069`.
- `history.checkpoint()` and `history.rebase()` work as before and use `main`. A checkpoint does not prove that every Store kept the file bytes.
- History covers the Store file tree, not live Source responses or a running Session. Empty directories are not part of it.
- The working tree follows `main`. A commit to `main` replaces staged `fs` writes. Commits to other refs leave them alone.
- Committed revisions never change until the workspace is deleted.

A commit waits for Definition sync before it checks Source ownership. Sync can publish a Source revision and move the `main` head. The commit then reports `WORKSPACE_CONFLICT`, so read the new head and retry. No ref can change or delete Source-owned files, including materialized files not yet in a revision.

Retained history needs access to the whole Workspace. A facade limited to some paths or Sources throws `WORKSPACE_R0069`, so it cannot expose or replace a full folder outside its scope.

### Work on a ref in a local folder

`vitehub pull` and `vitehub push` keep a folder of your project in sync with one ref, as `git pull` and `git push` do with a branch. Edit the files in your editor or with your Agent, and edit the same ref in the Console. The next pull merges the two.

```bash [Terminal]
pnpm vitehub pull content --dir content --ref draft --url https://docs.example.com
pnpm vitehub pull --dry-run
pnpm vitehub push --message "Fix the install guide"
```

The first pull of a Workspace needs `--dir`, and `--ref` when the ref is not `main`. It writes `vitehub.lock` at the project root. Commit that file: it records the folder, the ref, the remote app, the revision that the folder matches, and the SHA-256 of each file at that revision. Later commands read it, so `pnpm vitehub pull` with no arguments pulls every Workspace in it. Without `--url` and without `remote` in the lock file, the commands use the dev server of the project.

- **Pull.** A file that only the remote changed takes the remote version. A text file that both sides changed is merged by line. Lines that both sides changed get Git conflict markers, with your lines first. A remote edit of a file that you deleted brings the file back. Your edit of a file that the remote deleted stays, and the next push restores it. `--theirs <path>` takes the remote version of one path.
- **Push.** It pulls first, then commits every local change to the ref in one revision with `ifHead` set to the pulled head. When another save lands between the two steps, it pulls and tries again. It refuses while a file has conflict markers. Some Stores start a new ref from the files of another ref. Then the first push to that ref also pulls those files, and `after` in the result lists them.
- **Size.** One push is one `workspace.commit` call of at most 4 MiB, with binary files in base64. Vercel Functions accept request bodies up to 4.5 MB and Cloudflare Workers up to 100 MB, so this limit works on every host. A larger push fails with `WORKSPACE_CHECKOUT_TOO_LARGE` before it calls the app, and names the largest files. A push stays one revision, so it is not split: keep large media in Blob, or add new files in smaller groups. A pull reads all changes since the last pull in one `workspace.changes` response. ViteHub sets no limit on it, but Vercel Functions fail on a response over 4.5 MB, so on Vercel pull often enough that the changes stay below that.
- **Edit leases.** Someone who edits a file in the Console can hold its edit lease, as [Content](/docs/content/editing-together) does for a document. A push that writes a leased file fails with the error of the plugin, such as `CONTENT_LEASE_HELD` and status 409, and saves nothing. Because the push is one revision, one held lease blocks the whole push, and the error names every blocked document. The push does not try again. Wait for the editors to finish, or run `vitehub push --override-lease`: the revision then records `lease: "override"` in its metadata, and the lease plugin lets it through.
- **Binary files.** When both sides change one, the pull keeps your file and lists the path in `conflicts` of the lock file. Run `vitehub resolve <workspace> <path>` to keep your file, or pull with `--theirs <path>`.
- **Status.** `vitehub status` lists the added, modified, deleted, and conflicting files of each checkout folder, without calling the app. `vitehub pull --dry-run` also lists what changed on the ref since the last pull, and writes nothing.

`pnpm vitehub hooks install` adds two Git hooks. Before a commit, `vitehub hooks pre-commit` fails while a checkout folder has conflicts; it works offline. Before a push, `vitehub hooks pre-push` runs `vitehub push` when the Git push updates the default branch (`origin/HEAD`, else `init.defaultBranch`, else `main`), and fails the Git push when the Workspace push fails. When the Workspace push changes `vitehub.lock` or pulls files into a checkout folder, the hook also fails the Git push, because the commits that Git pushes do not contain those changes: commit them, then run `git push` again. The second push has nothing for the Workspace, so it goes through. Other branches push nothing. Without `vitehub.lock`, both hooks do nothing. When Husky, lefthook, pre-commit, simple-git-hooks, or `core.hooksPath` runs the hooks of the repository, `install` writes no file and prints the two commands to add there. It never replaces or removes a hook that differs from the one it writes, so commands that you add to a hook stay. `vitehub hooks uninstall` removes its hooks.

The commands call two operations of the app, which the Console section `workspaces` grants:

| Operation | Kind | Result |
| --- | --- | --- |
| `workspace.changes` `{ workspace, ref?, since?, content? }` | read | `{ head, files }`: each file that differs between revision `since` and the head of `ref`, with its content at the head and at `since`. Without `since`, every file of the head. `content: false` leaves the content out. |
| `workspace.commit` `{ workspace, ref?, ifHead, put?, delete?, message?, lease? }` | write | Request body up to 4 MiB. `{ revision, normalized? }`. `normalized` maps submitted paths to their committed `{ content, encoding }` when validators or hooks changed the bytes. `put` maps paths to `{ content, encoding: "utf8" \| "base64" }`. A replaced file keeps its media type and metadata from `ifHead`, or from the seed revision when the Store starts a missing ref from another ref. The revision metadata records `source` (the surface, such as `cli`) and `author` (`{ id, name, email }` of the signed-in user, as Content records it). Without a signed-in user, such as a local dev server, the revision has no author. Write rules and validators run as for `history.commit()`. A moved head fails with `WORKSPACE_CONFLICT` and status 409. A plugin can refuse the commit, such as an edit lease held on a document. `lease: "override"` passes that lease and is recorded in the revision metadata. On the Agent and MCP surfaces, an override needs `operations({ overrideLeases: true })`, else it fails with `WORKSPACE_FORBIDDEN` and status 403. |

The folder holds the Workspace root. Checkout folders must be separate: they cannot share a folder or contain one another. On Windows and macOS, folder names that differ only in case are one folder. Paths with `.git`, `.vitehub`, `node_modules`, or `.DS_Store` components, in any letter case and with any trailing dots or spaces (Windows opens `node_modules.` as `node_modules`), are excluded from pulls, status, and pushes; their remote files stay unchanged, and `--theirs` cannot select them.

Checkout paths must use portable names on every platform. Before writing remote changes, the checkout checks the incoming paths, tracked paths, and local files and directories together. Two spellings of the same file or directory that differ only in case or Unicode normalization fail with `WORKSPACE_CHECKOUT_PATH`. Names with trailing dots or spaces, Windows device names, and Windows-invalid characters also fail. A pull does not replace a file with a directory or a directory with a file. To apply those transitions, keep local edits elsewhere, remove the lock entry, and pull into a new empty folder.

Top-level files named `__proto__`, `constructor`, or `prototype` fail with the same error because the operation input map cannot carry these keys. Workspace names have no such restriction.

A pull writes each file to a new file in the same folder, then renames it over the old one. A hard link to the old file keeps its content, and a failed write leaves the old file. A command that stops before the rename leaves a file that ends in `.vitehub-tmp`; checkouts exclude these files, so delete them. `vitehub.lock` is written the same way, and a command fails with `WORKSPACE_CHECKOUT_SYMLINK` when it is a symbolic link. Commands can run at the same time in one project: before each write of the lock file, a command creates `vitehub.lock.lock`, reads the lock file again, and replaces only the entries of the Workspaces that it pulled or pushed. A command waits up to 10 seconds for `vitehub.lock.lock`, then fails with `WORKSPACE_LOCK_BUSY`. Lock age does not allow takeover. If a command stopped, check that no command is running before you delete `vitehub.lock.lock`. Each command removes only its own lock acquisition. Two commands on the same Workspace at the same time each write its entry, and the last one wins, so run one at a time per Workspace.

An existing checkout rejects a different `--url` before calling the app. Remove its lock entry and pull into a new folder to change the remote. Push records the committed bytes after validators and hooks run. It updates the local file only if it still contains the submitted bytes; edits made during the call stay as local changes.

Each command fails on a flag that it does not know, before it calls the app. Pull and push accept at most one positional argument, the Workspace name; extra arguments fail before a call. `vitehub push --dry-run` fails and commits nothing: use `vitehub pull --dry-run` or `vitehub status` to see the changes first.

Commands reject existing symbolic links in the checkout folder and its ancestors inside the project. These checks do not isolate files from another process that can replace paths during an operation. Use an OS or container boundary for that isolation.

A push sends whole files, is limited to 4 MiB, and the operation call has a timeout of two minutes, so keep a checkout to text and media of a docs site or a translation catalog, not to large binaries.

#### On the GitHub Store

The commands work the same on the GitHub Store, with these differences:

- A revision id is a commit sha, and the digest of a file is its Git blob sha. `vitehub.lock` still records SHA-256.
- Each instance of the app keeps the head of a ref for up to 5 seconds. A pull right after a commit on GitHub, or through another instance, can report the older head. A push still checks the real head before it commits, so it cannot overwrite that commit. If your push reaches an instance with an older head, the push can first undo the newer commit in your folder and then pull it again. A line that you also changed then gets conflict markers.
- The media type of a file comes from its name. A push keeps the Git mode of an executable file or a symbolic link (`gitMode` metadata). The Store keeps no other file metadata.
- GitHub records the account of the token as the author of each commit, and the revision `author` is that account. The signed-in user is in the `Vitehub-Metadata` trailer of the commit message. Anyone with write access to the repository can write that trailer, so the Store does not report it as the author.
- The first push to a ref that does not exist creates a branch from the published branch when the Store sets `refs.published`, else from the default branch. The push then pulls the files that the new branch has from that branch.
- A pull reads up to two blobs for each changed file: the head version and the version at the last pull. The first pull reads one blob for each file. GitHub allows 5,000 API requests per hour for most tokens, so the first pull of a large Workspace can use a large part of that limit. `vitehub status` and `vitehub pull --dry-run` read no file content.
- A force push can remove the revision that `vitehub.lock` records. A pull then fails with `WORKSPACE_NOT_FOUND`. Move the folder away, remove its entry from `vitehub.lock`, pull again, and copy your changes back.

### Derived files

A derived file, such as a translation, records the file it was made from and the SHA-256 of that file's bytes then. Put `derivedFrom` in the YAML frontmatter of Markdown (`.md`, `.markdown`, `.mdx`), at the top of a YAML file (`.yaml`, `.yml`), or as a top-level key of a JSON file (`.json`). Other files have no lineage:

```md [docs/es/guide.md]
---
title: Guía
derivedFrom:
  path: docs/en/guide.md
  digest: sha256-1a9e…
---
```

When the source changes, the derived file is stale. `vitehub status` lists the stale files of each checkout folder, and the `workspace.stale` operation lists them on a ref:

```bash [Terminal]
pnpm vitehub workspace stale site --ref draft
```

Each changed entry has `sourceDigest`, the digest of the source now. The command prints it in the `SOURCE DIGEST` column. Update the file, then write that value as `derivedFrom.digest`. An entry with `reason: "missing"` names a source that is gone. `lineageDigest(bytes)`, `readDerivedFrom(path, bytes)`, and `staleDerivedFiles(files)` from `vite-hub/workspace/lineage` do the same checks in your code.

To translate when the source changes, start your translator from a `write:after` hook. The hook runs after each commit, also for `vitehub push`. This excerpt uses the app's `translate` Queue Definition:

```ts [server/plugins/translate.ts] fragment
import { registerWorkspacePlugin } from 'vite-hub/workspace'
import { sendQueue } from 'vite-hub/queue'

registerWorkspacePlugin('site', {
  id: 'translate',
  hooks: {
    'write:after': async ({ path, ref }) => {
      if (ref === 'draft' && path.startsWith('docs/en/')) await sendQueue('translate', { path })
    },
  },
})
```

The `translate` Queue job reads `workspace.stale`, translates each stale file with your Agent, and saves it to `draft` with the new `derivedFrom.digest`. ViteHub keeps the record and the check. The translation is your Agent's work.

## Add plugins to a Workspace

`registerWorkspacePlugin(workspace, plugin)` adds a `WorkspacePlugin` with `id`, `rules`, and `hooks` to a Workspace by name. Use it in a package that owns paths in a Workspace it does not define, for example to validate documents before each write:

```ts fragment
import { registerWorkspacePlugin } from 'vite-hub/workspace'

registerWorkspacePlugin('content', {
  id: 'content-schema',
  hooks: {
    'write:validate': (input) => {
      if (input.operation === 'writeFile' && input.path.startsWith('posts/'))
        assertPost(input.content)
    },
  },
})
```

The plugin applies to `fs` writes, Sessions, and history commits on every ref, including facades created earlier. The Workspace does not need to exist yet.

- Registering the same id again replaces the earlier plugin.
- A plugin with the same id in the Workspace Definition wins.
- The call returns a function that removes the registration.

In a history commit, each hook also gets `input.commit`, which is read-only:

| Field | Value |
| --- | --- |
| `message` | The message of the commit. |
| `metadata` | The revision metadata that the caller passed to `history.commit()`, such as `{ lease: 'override' }` from `vitehub push --override-lease`. |
| `paths` | Every path that the commit adds, changes, or deletes, sorted. Check them together to name every problem in one error. |

`input.commit` is the same object for every path of one commit, so a hook can keep one check per commit in a `WeakMap`. Writes to the working tree have no `input.commit`. A hook error with a `status` from 400 to 499, such as `Object.assign(error, { status: 409, fix })`, reaches `workspace.commit` callers with that status, its `fix`, and its `details`.

Rules from several plugins and the Definition do not merge per path. For one path, the most specific pattern wins, and a later rule with the same pattern replaces an earlier one. Hooks from every plugin run in order. Prefer a `write:validate` hook that throws when a contributed check must always run.

## Sync Sources

Source Sync copies selected Source paths into the Workspace Store, if the Source's sync policy allows it.
Only Sources with `sync: true` or a sync policy take part in `workspace.sync()`.

```ts [server/tasks/sync-docs.ts]
import { useWorkspace } from 'vite-hub/workspace'

export async function syncDocs() {
  const workspace = useWorkspace('docs', { mode: 'write' })

  return workspace.sync({
    sources: ['handbook'],
    snapshot: { message: 'Sync handbook source' },
  })
}
```

Build and dev integrations copy in Sources at build time. `sync()` does it while the app runs.

### Source sync policy

| Option | Type | Default | Behavior |
| --- | --- | --- | --- |
| `sync` | `boolean \| WorkspaceSourceSyncPolicy` | `false` | `true` turns sync on with the default policy. An object sets concurrency and stale paths. |
| `sync.concurrency` | `skip \| queue` | `queue` | Waits for an active sync of the same Source, or reports the Source as skipped. |
| `sync.stale` | `keep \| remove` | `keep` | Keeps or removes files the Source no longer returns. Removal changes only paths in the current Source mount. |

### `workspace.sync()` options

| Option | Type | Default | Behavior |
| --- | --- | --- | --- |
| `sources` | `all \| readonly string[]` | required | All Sources with sync on, or a list of Source keys. |
| `details` | `counts \| paths` | `counts` | Counts per Source, or also results per path. |
| `snapshot` | `boolean \| { name?, message? }` | `false` | Takes a snapshot after a successful sync. Without `name`, the message is the name. |
| `publishPartial` | `boolean` | `false` | Applies successful Source plans when another selected Source fails. With `snapshot`, it also takes the snapshot. |

Source Sync needs a Store with metadata support. Without `publishPartial`, one planning error skips all plans, so a sync never applies only part of the selection.

## Use sessions and Shell

Use a Workspace Session when a command needs real files on disk and you want a diff of its changes.
`session.exec()` needs an open Sandbox Session. Workspace copies files in, diffs, commits, and rolls back. Sandbox runs the command and manages its lifecycle.

```ts [server/tasks/test-docs.ts]
import { resolveSandbox } from 'vite-hub/sandbox'
import { useWorkspace } from 'vite-hub/workspace'

export async function testDocs() {
  const sandbox = await resolveSandbox({ runtime: 'trusted-host' }, undefined)
  const host = await sandbox.open()
  const session = await useWorkspace('docs', { mode: 'write' }).startSession({ host })

  try {
    await session.exec('pnpm', ['test'])
    return await session.diff()
  }
  finally {
    await session.close()
    await host.close()
  }
}
```

### Session method options

`startSession(options)` joins Workspace state with an open Sandbox Session:

- `host` is required to run commands.
- `paths` limits what is copied in and committed.
- `target` defaults to `/workspace`.
- `abortSignal` cancels setup. `onProgress` reports copy phases.

Closing the Workspace Session does not close the Sandbox host. Custom hosts copy files one at a time unless they declare a positive `materializationConcurrency` they can safely handle. The local Node host declares `8`.

Control what the Session writes back:

- `writeBack.exclude` lists paths the runtime owns, not the invocation. They stay usable in the host tree, but `diff()` and `commit()` skip them, and `close()` restores their state from before the Session. ViteHub always treats `.agent-runs`, `.git`, and `.vitehub` this way.
- `writeBack: false` keeps the runtime writable but never publishes its changes. It turns off `diff()` and `commit()`, and `close()` restores the Workspace without scanning the runtime tree first. Read-only Agent Workspaces use it automatically.
- `attach: true` is for integrations that already own a live file tree. The Session keeps existing live edits, never copies the whole tree again, and on close rolls back only its own uncommitted changes.
- `disposableTarget: true` is only for a caller that owns `target` and deletes it after `close()`. `close()` and failed setup leave the target as it is. `commit()` does not change. It cannot be combined with `attach`.

| Method | Options | Behavior |
| --- | --- | --- |
| `readFile`, `writeFile`, `mkdir`, `rm`, `list`, `glob`, `search` | Same file options as the Workspace filesystem | Work inside the Session paths. |
| `exec(command, args?, options?)` | `abortSignal?`, `cwd?`, `env?`, `timeout?` | Runs in the given Sandbox Session. `cwd` defaults to the Workspace target. Sessions without a host reject it. |
| `diff()` | none | Returns changes inside the Session paths. |
| `commit(options?)` | `message?: string` | Writes changes back and takes a snapshot, with an optional message. |
| `close()` | none | Rolls uncommitted host changes back to the Workspace state and frees Session resources. |
| `tools?.aiSdk()` | none | Returns runtime-provided AI SDK tools when the Session supports them. |

Workspace stores the file tree and commits. Sandbox and Sandbox Task run commands in separate environments. Provider Agent Drivers copy the selected Workspace into their local working directory.

### Run sessions from the CLI

In local development, `vitehub workspace dev` runs a command in a Workspace Session from the Vite dev server. It copies the Workspace in, runs the command, and commits the changes if it succeeds. If you use `@vite-hub/workspace` instead of `vite-hub`, install `@vite-hub/cli`.

```bash [Terminal]
pnpm vitehub workspace dev --url http://localhost:5173 docs exec pnpm test --filter api
```

`vitehub agent dev` also runs `!` input as a command in the Agent's writable Workspace. Use `!` for shell work in the Workspace the Agent sees. Send a normal message when the Agent must think about the task.

```bash [Terminal]
pnpm vitehub agent dev --agent support !pnpm test --filter api
```
