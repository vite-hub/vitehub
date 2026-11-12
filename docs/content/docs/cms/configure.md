---
title: CMS configuration
description: "Choose the Database, Blob store, and Workspace of the cms preset, keep documents in GitHub, publish through pull requests, and decide who may edit."
navigation.title: Configure
navigation.order: 3
icon: i-lucide-sliders-horizontal
---

The `cms` preset works without options. Pass a tuple to pick another Database, Blob store, Workspace name, or the GitHub store:

```ts [server/content.ts] fragment
import { defineContent } from 'vite-hub/content'
import { cms } from 'vite-hub/cms'

export default defineContent({
  extends: [cms, { database: 'content', blob: 'media', workspace: 'site' }],
  collections: { posts },
})
```

## Options

| Option | Default | Description |
| --- | --- | --- |
| `access` | No policy | `'roles'` turns on the CMS role policy. Your own `authorize` overrides it. |
| `database` | The Database named `default`, else the only Database, else a `default` Database that the preset adds | Database that gets the history tables and the editor sessions table. Required when the app has several Databases and none is named `default`. |
| `blob` | `default` | Blob store for file contents. Not for the GitHub store. |
| `workspace` | `content` | Name and store identity of the Workspace. It must not match a Workspace in `server/workspaces/`. |
| `store` | `github` with `repo`, else `blob-database` | Where documents live. `github` keeps them in a repository ([GitHub store](#github-store)). |
| `repo` | `VITEHUB_WORKSPACE_GITHUB_REPOSITORY` | GitHub store: the repository, as `owner/name`. Setting it picks the GitHub store. |
| `branch` | `main` | GitHub store: the published branch. `content.publish()` commits here. |
| `draftBranch` | `vitehub/content` | GitHub store: the draft branch. The first save creates it from `branch`. It must differ from `branch`. |
| `root` | `''` | GitHub store: the repository folder that collection paths start from. `''` is the root. |
| `publish` | `commit` | GitHub store: how a publish reaches `branch`. `commit` commits to it. `pr` opens a pull request ([Pull request mode](#pull-request-mode)). |

The build reads `server/content.ts` without running it. So import the preset from `vite-hub/cms` or `@vite-hub/cms`, pass it directly as `extends: cms` or `extends: [cms, { ... }]`, and write each option as a string literal. The [Server API](/docs/cms/server-api#option-values) lists the accepted values.

The preset sets `workspace` in `defineContent()`, so do not pass `workspace` next to `extends`.

## Turn the features on

ViteHub needs no settings for the preset. When `server/content.ts` uses it, ViteHub turns on `workspace`, `database`, and `blob` if you left them unset. The GitHub store needs no Blob.

A setting you pass wins. `blob: { stores: { media: ... } }` configures Blob. `workspace: false` keeps Workspace off and fails the build with [`CONTENT_B0002`](/docs/cms/limits-and-errors#errors).

## What the preset adds

| Piece | Value | Inspect it |
| --- | --- | --- |
| Workspace | `content`, on the [Blob + Database Store](/docs/workspace/configure#blob-database-store) with workspace identity `content` | `vitehub inspect definitions` and the Console Workspaces section list it as added by `@vite-hub/cms/vite`. The generated module is `.vitehub/content/workspace.mjs`. |
| Database | Only when the app has no Database Definition: the implicit `default` Database. Its migrations go to `server/databases/default/migrations/`, where `server/databases/default.ts` would keep them. | `vitehub inspect definitions --kind database` lists it with `Definition: Implicit` and names `@vite-hub/cms/vite` as a plugin that needs it. |
| Database tables | `workspaceHistorySchema` from `vite-hub/workspace/blob-database` and `contentSessionsSchema` from `vite-hub/content/database`, added to the `default` Database or the only Database | `vitehub inspect` and the Console Database section show a `Contributed tables` field. |
| Features | `workspace`, `database`, and `blob`, when the ViteHub options leave them unset | The `@vite-hub/workspace/vite`, `@vite-hub/database/vite`, and `@vite-hub/blob/vite` plugins are in the resolved Vite config. |
| Blob store | `default` | Files live under `vitehub/workspace-history/` in that store. |
| `defineContent()` | `workspace: 'content'`. With `access: 'roles'`, also the CMS roles as `authorize` when the app sets none | `content.collection(name)` reads and writes that Workspace. `vitehub inspect definitions --kind cms` shows what decides access. |

The collections work as in [Document collections](/docs/content/configure#document-collections): saves go to the `draft` ref, `publish()` copies documents to `published`, and `/api/content/**` serves only published documents.

## Access

Turn on CMS roles with `extends: [cms, { access: 'roles' }]`. Install the Better Auth `admin` plugin with `admin(cmsAccess)` from `vite-hub/cms/access`, and give each user a role: `viewer`, `commenter`, `editor`, or `publisher`. `admin` can do everything. `user`, the role of new users, can do nothing. Without `access: 'roles'` or `authorize`, every action is denied. [Roles and access](/docs/cms/access) explains the setup.

The [Console editor](/docs/content/console) and the [Content Agent Capability](/docs/content/agent-capability) check access through `content.can()`. To use your own policy instead, set `authorize` in `defineContent()`:

```ts [server/content.ts] fragment
export default defineContent({
  extends: cms,
  collections: { posts },
  // Editors do everything. Other signed-in users read drafts.
  authorize: ({ user, action }) => user?.role === 'editor' || (action === 'read' && Boolean(user)),
})
```

`action` is `read` for drafts, `write` for save, remove, and restore, or `publish`. Published documents stay public through `/api/content/**`.

- [Access](/docs/content/configure#access) lists every field that `authorize` gets, and shows how to give Agents less access than their user.
- [Give editors only the Content section](/docs/content/console#give-editors-only-the-content-section) keeps editors out of other Console sections.

## GitHub store

Set `repo` to keep documents in a Git repository instead of Blob and the Database. Published content and drafts live on separate branches, and a publish is a commit. Use this store when someone edits content files in a checkout, so local and online edits meet in Git. Without `repo`, the Blob + Database store holds the content, not the files on collection paths. It needs no GitHub access.

```ts [server/content.ts]
import { z } from 'zod'
import { cms } from 'vite-hub/cms'
import { defineContent } from 'vite-hub/content'
import { documents } from 'vite-hub/content/collections'

export default defineContent({
  extends: [cms, {
    repo: 'onmax/docs',
    branch: 'main',
    draftBranch: 'vitehub/content',
    root: '',
    publish: 'commit',
  }],
  collections: {
    posts: documents({ path: 'content/posts/**/*.md', fields: { title: z.string() } }),
  },
})
```

Set `VITEHUB_GITHUB_TOKEN` to a token that can read and write the repository. ViteHub reads it at the first request, not at build time. To keep the store off your personal rate limit, use a GitHub App instead: set `VITEHUB_GITHUB_APP_ID`, `VITEHUB_GITHUB_PRIVATE_KEY`, and `VITEHUB_GITHUB_INSTALLATION_ID` ([GitHub Store](/docs/workspace/configure#github-store)).

- `repo`, `branch`, `draftBranch`, `root`, and `publish` work only with the GitHub store. `blob` does not.
- Set `store: 'github'` without `repo` only when the repository comes from `VITEHUB_WORKSPACE_GITHUB_REPOSITORY`.
- The store comes only from these options, never from the environment, so every build reads content from the same place.

### What is stored where

| What | Where |
| --- | --- |
| Published documents | Files on `branch`, at the paths of your collections. |
| Drafts | Files on `draftBranch`. A save is one commit there. |
| Revisions and history | Commits. The commit message holds the Content metadata as a `Vitehub-Metadata:` line. Each draft commit also lists `bases`: for each document the draft changed, its digest when the draft first changed it. About 600 unpublished changed documents fit in the 64 KiB metadata limit. |
| Digests | Git blob shas. `ifDigest` and `publish({ expect })` use them. |
| Editor sessions and leases | The Database table `vitehub_content_sessions`. |
| Schedules | Not supported. |

The preset adds `contentSessionsSchema` to the Database, but not `workspaceHistorySchema`. It needs Workspace and Database, and no Blob. ViteHub generates the Content Workspace with the `github` store, `refs: { published: branch, draft: draftBranch }`, and your Database.

### Reads on serverless hosts

A Content read asks GitHub only for what changed. Branch heads are revalidated with their ETag, and GitHub does not count a `304 Not Modified` against the rate limit. Answers for a commit sha never change, so with [KV](/docs/kv) enabled they stay in KV for 7 days, and a new server instance, such as a new Cloudflare Worker isolate, reads them there ([GitHub Store](/docs/workspace/configure#github-store)). When Content needs many documents of one commit, for example to count issues, it reads one archive of the commit. `updatedAt` walks the branch history only for the documents that a read returns.

On a Worker that just started, with KV, the Console overview of a repository with 413 documents and 450 commits sends 3 GitHub requests. Without KV, it sends 19. Enable KV on Cloudflare Workers and other hosts that start new server instances often.

### Commit mode

- **First save.** The first save of a document creates `draftBranch` from `branch` in the same commit, with no seed commit. Until then, the draft is the published content.
- **Save and remove.** Each is one commit on `draftBranch` that changes one file. A busy draft branch is retried.
- **Draft sync.** Before a write or publish, if `branch` moved since the last merge, Content merges `branch` into `draftBranch`. It uses the GitHub Merges API on a temporary branch, checks the merged files against the Workspace write policy, updates `draftBranch`, and deletes the temporary branch. Reads do not merge.
  - Documents the draft did not change arrive as they are. For a document both sides changed, Git keeps both edits when they touch different lines.
  - If the same lines changed, Content merges the document itself: fields one by one, and the Markdown body word by word. Edits to different fields, or to different words of one paragraph, merge into the draft, which then builds on the `branch` version. A person still sees the result before it is published.
  - A field or words that both sides changed differently, or a delete against an edit, keep the draft's version of that document.
  - When `branch` holds a version the draft once had (its own publish, merged, squashed, or rebased), the draft's newer text wins with no conflict. Otherwise the document is marked as changed on both sides, and `publish()` refuses it.
  - The merge commit records the `branch` revision it brought in. If GitHub or the write policy refuses the merge (permissions, a missing branch, rate limits, or a denied file change), the sync is skipped with one warning and the write continues.
- **Publish.** `content.publish()` copies the documents the draft changed to `branch` in one commit. The commit checks that `draftBranch` did not move. Other repository files stay as they are, and so do documents changed or added only on `branch`.
- **Other files.** The generated Workspace denies every write outside the collection paths, for any `root`. Agents and raw history commits cannot change `package.json` or other files. `main` and `draftBranch` can be written only as `published` and `draft`. With a `root` folder, the Workspace reads and writes only in that folder.

You cannot publish a document that the draft and `branch` both changed until someone reviews the `branch` version ([Changed on both sides](/docs/cms/limits-and-errors#changed-on-both-sides)).

### Pull request mode

With `publish: 'pr'`, `content.publish()` does not touch `branch`. It checks the documents with the commit mode rules (only what the draft changed, whole publish refused on a conflict), then:

1. creates `vitehub/publish/<draft7>-<timestamp>-<uuid>` from the head of `branch` (`<draft7>` is the first 7 characters of the draft revision), and commits the changes there;
2. opens a pull request from that branch into `branch`;
3. returns `{ revision, documents, pullRequest: { number, url }, pending: true }`. `revision` is the commit on the publish branch.

`onPublish` listeners and Comark source refreshes run when `branch` changes, so not for a pending publish. Until the pull request merges, `status()` keeps the document state (`draft` or `changed`) and adds `pullRequest: { number, url }`. When `branch` has the bytes of the publish branch, the document is `published` and the link goes away. A pull request closed without a merge shows nothing, and the draft keeps the change. The Console shows the link in the publish message, and `vitehub content publish` prints it.

It is a normal pull request: review it, wait for checks, and merge it any way. Merge commits, squashes, and rebases all work. If the draft changed since, it keeps its newer text. The token needs permission to create branches and pull requests.

- **One pull request per document.** You cannot publish a document that an open publish pull request already covers. `publish()` throws `CONTENT_R0017` with the link. Merge or close it first. For publishes from several instances at once, read [Pull request reservations](/docs/cms/limits-and-errors#pull-request-reservations).
- **A refused pull request leaves nothing behind.** If GitHub refuses to open it, Content deletes the publish branch and throws GitHub's reason.
- **Publish branches.** Content never deletes a branch after it opens the pull request. Turn on "Automatically delete head branches" in the repository settings, or delete them yourself. `status()` finds pending documents from the `vitehub/publish/` branches and their open pull requests, not from commit messages, so a pull request with a rewritten commit still shows.

## Take over the Database

To set the Database yourself, for example its connection URL or Cloudflare D1 options, add `server/databases/default.ts`. The preset's tables then go to your Definition instead of the implicit `default` Database. It keeps `server/databases/default/migrations/`, so existing migrations still apply.

```ts [server/databases/default.ts]
import { defineDatabase } from 'vite-hub/database'

export default defineDatabase({ schema: {} })
```

## Import existing Markdown

With the Blob + Database store, the Workspace keeps the only copy of each document. Markdown files left in the repository after import are a second copy. Editors change the Workspace, so the files go stale, and a second import can bring back old text. Import the files once, then delete them:

1. Save each file as a draft. Add `--url` to run against the deployed app, or leave it out for the dev server.

   ```bash [commands/import]
   pnpm vitehub content edit posts hello --file ./posts/hello.md --url https://example.com
   ```

2. Publish the drafts. The command lists the changes and pins their digests.

   ```bash [commands/publish]
   pnpm vitehub content publish --url https://example.com
   ```

3. Delete the files from the repository, and any code that reads them.

A new environment then starts with an empty Workspace. To copy documents into it, read each one from the deployed app with `vitehub content show`, then save it with `vitehub content edit --file`. If the repository must stay the source of the documents, use the [GitHub store](#github-store).

## Migrate from manual wiring

With the earlier setup, the app has a Database Definition that lists `workspaceHistorySchema` and a Workspace Definition on `createBlobDatabaseWorkspaceStore()`. To keep your history, point the preset at the same Database, Blob store, and Workspace identity:

1. Remove `workspaceHistorySchema` and `contentSessionsSchema` from the Database Definition. The preset adds them, and listing them twice fails with `DATABASE_DUPLICATE_TABLE`.

   ```ts [server/databases/content/index.ts]
   import { defineDatabase } from 'vite-hub/database'

   export default defineDatabase({ name: 'content', schema: {} })
   ```

2. Delete the Workspace Definition, such as `server/workspaces/site.ts`.
3. Use the preset with the old names. `workspace` must equal the old `createBlobDatabaseWorkspaceStore({ workspace })` identity, because the identity picks the stored history.

   ```ts [server/content.ts] fragment
   export default defineContent({
     extends: [cms, { database: 'content', blob: 'content', workspace: 'site' }],
     collections: { posts },
   })
   ```

4. Run `pnpm vitehub database generate`. The tables are unchanged, so it writes no new migration.

If the old Workspace name and its store identity differ, the preset cannot use both. Keep the manual setup with `defineContent({ workspace })`.
