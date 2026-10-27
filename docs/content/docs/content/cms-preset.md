---
title: CMS preset
description: Store editable document collections from one file. ViteHub turns on Workspace, Database, and Blob, adds the Workspace and its history tables, and adds a Database when the app has none.
navigation.title: CMS preset
navigation.order: 7
icon: i-lucide-newspaper
---

The `cms` preset stores [document collections](/docs/content/configure#document-collections) for you. You write `server/content.ts`. ViteHub turns on Workspace, Database, and Blob, adds a Workspace on the [Blob + Database Store](/docs/workspace/configure#blob-database-store), and adds its history tables to your Database. If the app has no Database Definition, the preset adds one. You do not write a Workspace Definition, a Database Definition, a schema, or feature settings.

## Set up

::steps
### Define the collections

```ts [server/content.ts]
import { defineContent, documents } from 'vite-hub/content'
import cms from '@vite-hub/content/presets/cms'
import { z } from 'zod'

export const content = defineContent({
  extends: cms,
  collections: {
    posts: documents({ path: 'posts/**/*.md', fields: { title: z.string(), date: z.coerce.date() } }),
  },
  authorize: ({ user, action }) => user?.role === 'editor' || (action === 'read' && Boolean(user)),
})
```

The preset sets `workspace`, so do not pass it. `authorize` decides who may read drafts, write, and publish in the Console editor and the Content Agent Capability. See [Access](/docs/content/configure#access).

`vitehub()` needs no feature settings for the preset:

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ preset: 'node' })],
})
```

When `server/content.ts` selects the preset, `vitehub()` turns on `workspace`, `database`, and `blob` if you left them unset. A setting you pass wins: `blob: { stores: { media: ... } }` configures Blob, and `workspace: false` keeps Workspace off and fails the build with `CONTENT_B0002`.

### Create the tables and resources

```bash
pnpm vitehub db generate
pnpm vitehub db migrate
```

`db generate` writes a migration with the five `workspace_history_*` tables to `server/databases/migrations/`. `db migrate` applies it to the local Database, `.vitehub/data/database/sqlite.db` by default.

Before a hosted deploy, run `pnpm vitehub provision run --provider cloudflare` or `--provider vercel`. Provision creates the same Database and Blob resources it creates without the preset. On Cloudflare that is an R2 bucket, plus a D1 database once you name one, for example with `vitehub({ database: { driver: 'd1', databaseName: 'content' } })`. On Vercel it is a Blob store. The preset creates no resources of its own. See [Provisioning](/docs/development/provisioning).
::

## What the preset adds

| Piece | Value | Inspect it |
| --- | --- | --- |
| Workspace | `content`, on the Blob + Database Store with workspace identity `content` | `vitehub inspect definitions` and the Console Workspaces section list it as contributed by `@vite-hub/content/vite`. The generated module is `.vitehub/content/workspace.mjs`. |
| Database | Only when the app has no Database Definition: the `default` Database, from the generated `.vitehub/content/database.ts`. Its migrations go to `server/databases/migrations/`, where `server/databases/config.ts` would keep them. | `vitehub inspect definitions --kind database` lists it with `Contributed by: @vite-hub/content/vite` and a `Reason` field naming the cms preset. |
| Database tables | `workspaceHistorySchema` from `vite-hub/workspace/blob-database` and `contentSessionsSchema` from `vite-hub/content/database`, added to the Database named `default`, or to the only Database | `vitehub inspect` and the Console Database section show a `Contributed tables` field. |
| Features | `workspace`, `database`, and `blob` turn on when `vitehub()` leaves them unset | The `@vite-hub/workspace/vite`, `@vite-hub/database/vite`, and `@vite-hub/blob/vite` plugins are in the resolved Vite config. |
| Blob store | `default` | Files are stored under `vitehub/workspace-history/` in that store. |
| `defineContent()` | `workspace: 'content'` | `content.collection(name)` reads and writes that Workspace. |

The collections behave as described in [Document collections](/docs/content/configure#document-collections): saves go to the `draft` ref, `publish()` copies documents to `published`, and `/api/content/**` serves only published documents.

## Options

Pass options as a tuple to use another Database, Blob store, Workspace name, or the GitHub store:

```ts [server/content.ts]
export const content = defineContent({
  extends: [cms, { database: 'content', blob: 'media', workspace: 'site' }],
  collections: { posts },
})
```

| Option | Default | Description |
| --- | --- | --- |
| `database` | The Database named `default`, else the only Database, else a `default` Database that the preset adds | Database Definition that receives the history tables. Required when the app has several Databases and none is named `default`. |
| `blob` | `default` | Blob store that holds file contents. |
| `workspace` | `content` | Name and store identity of the Workspace. It must not match a Workspace in `server/workspaces/`. |
| `store` | `blob-database` | Where documents live. `github` keeps them in a repository. See [GitHub store](#github-store). |

The build reads `server/content.ts` without running it. Import the preset from `vite-hub/content/presets/cms` or `@vite-hub/content/presets/cms`, pass it directly as `extends: cms` or `extends: [cms, { ... }]`, and write each option as a string literal.

## GitHub store

Set `store: 'github'` to keep documents in a Git repository instead of Blob and the Database. Published content is on one branch, drafts are on another, and a publish is a commit.

```ts [server/content.ts]
export const content = defineContent({
  extends: [cms, {
    store: 'github',
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

Set `VITEHUB_GITHUB_TOKEN` to a token that can read and write the repository. The token is read at the first request, not at build time.

| Option | Default | Description |
| --- | --- | --- |
| `repo` | `VITEHUB_WORKSPACE_GITHUB_REPOSITORY` | The repository, as `owner/name`. |
| `branch` | `main` | The published branch. `content.publish()` commits here. |
| `draftBranch` | `vitehub/content` | The draft branch. The first save creates it from `branch`. It must differ from `branch`. |
| `root` | `''` | The folder of the repository that collection paths start from. `''` is the repository root. |
| `publish` | `commit` | How a publish reaches `branch`: `commit` commits to it, `pr` opens a pull request. See [Pull request mode](#pull-request-mode). |
| `database` | The default or only Database | Database for editor sessions. |

The options `repo`, `branch`, `draftBranch`, `root`, and `publish` work only with `store: 'github'`. The `blob` option does not work with it.

### What is stored where

| What | Where |
| --- | --- |
| Published documents | Files on `branch`, at the paths of your collections. |
| Drafts | Files on `draftBranch`. A save is one commit there. |
| Revisions and history | Commits. The commit message holds the Content metadata as a `Vitehub-Metadata:` line. Each draft commit also lists, for every document the draft changed, the digest that the document had when the draft first changed it (`bases`). Up to about 600 unpublished changed documents fit in the 64 KiB metadata limit. |
| Digests | Git blob shas. `ifDigest` and `publish({ expect })` use them. |
| Editor sessions and leases | The Database table `vitehub_content_sessions`. |
| Schedules | Not supported. |

The preset adds `contentSessionsSchema` to the Database, but not `workspaceHistorySchema`. It needs Workspace and Database, and no Blob. The Content Workspace is generated for you, with the `github` store, `refs: { published: branch, draft: draftBranch }`, and the Database you chose.

### Commit mode

- **First save.** The first save of a document creates `draftBranch` from `branch` in the same commit. There is no seed commit. Until then the draft is the published content.
- **Save and remove.** Each is one commit on `draftBranch` that changes one file. A busy draft branch is retried.
- **Draft sync.** Before a write or a publish, when `branch` moved since the draft last merged it, Content merges `branch` into `draftBranch` with the GitHub Merges API on a temporary branch, validates the merged files through Workspace write policy, then updates `draftBranch` and deletes the temporary branch. Reads do not merge. Documents the draft did not change arrive as they are, and for a document both sides changed the merge keeps both edits when they touch different lines. If the same lines changed, Content merges everything else with the Git data API and keeps the draft's version of that document. When `branch` holds a version that the draft once had (its own publish, merged, squashed, or rebased), the draft's newer text just wins and nothing conflicts; otherwise the document is marked as changed on both sides and `publish()` refuses it. The merge commit records the `branch` revision it brought in. If GitHub or Workspace write policy refuses the merge (permissions, a missing branch, rate limits, or a denied file change), the sync is skipped with one warning and the write goes on.
- **Publish.** `content.publish()` copies the documents that the draft changed to `branch` in one commit. The commit checks that `draftBranch` did not move. Other files of the repository stay as they are, and so do documents that changed or were added only on `branch`.
- **Other files.** The generated Workspace denies every write except to the collection paths, for any `root`. Agents and raw history commits cannot change `package.json` or other files, and `main` and `draftBranch` can be written only as `published` and `draft`. With a `root` folder, the Workspace reads and writes files in that folder only.

### Limits

- `content.schedule()` throws `CONTENT_R0016`. Use `content.publish()`.
- A document that only `branch` changed or added is never touched by `publish()`: it is not reverted or deleted, and `status()` reports it as `published`. Draft sync brings such documents into the draft; until it runs, the draft keeps its old copy.
- A document that the draft changed and `branch` changed too (or deleted) cannot be published. `publish()` throws `WORKSPACE_CONFLICT` with `ref: 'published'` and the documents, and publishes nothing, not even the other documents you selected. Saving and syncing other documents can continue; publish them separately with `ids` or `expect`. Read the published version with `get(id, { ref: 'published' })`, reapply your edit, then save with `ifPublishedDigest: published?.digest ?? null` and `ifDigest` set to the current draft digest. This one save records the reviewed published version as the new base, even if the draft bytes stay the same. A blind save keeps the original base and cannot clear the conflict.
- Ordinary Git or Workspace commits on the draft keep publish protection: Content recovers the nearest recorded bases and accounts for intervening document changes. If neither Content metadata nor the current published revision is found within 100 draft ancestors, saving and publishing refuse rather than guessing. Preserve those edits, recreate the draft from published, then reapply them through Content.
- Each read and write calls the GitHub API, so GitHub rate limits apply. The head of a branch is cached for 5 seconds.

### Pull request mode

With `publish: 'pr'`, `content.publish()` does not touch `branch`. It checks the documents with the same rules as commit mode (only what the draft changed, whole publish refused on a conflict), then:

1. creates the branch `vitehub/publish/<draft7>-<timestamp>-<uuid>` from the head of `branch` (`<draft7>` is the first 7 characters of the draft revision), and commits the changes there;
2. opens a pull request from that branch into `branch`;
3. returns `{ revision, documents, pullRequest: { number, url }, pending: true }`. `revision` is the commit on the publish branch.

`onPublish` listeners and Comark source refreshes run when `branch` changes, so they do not run for a pending publish. Until the pull request merges, `status()` keeps the state of the document (`draft` or `changed`) and adds `pullRequest: { number, url }`. When `branch` has the bytes of the publish branch, the document is `published` and the link goes away. A closed pull request that was not merged shows nothing; the draft still has the change. The Console shows the link in the publish message, and `vitehub content publish` prints it.

The pull request is a normal one: review it, wait for checks, and merge it with any method. A merge commit, a squash, and a rebase all work: when the draft has changed since, it keeps its newer text. The token needs permission to create branches and pull requests.

- **One pull request per document.** A document that an open publish pull request already covers cannot be published again: `publish()` throws `CONTENT_R0017` with the pull request link. Merge or close it first. Separate runtime instances reserve the selected documents on GitHub before opening the pull request, so simultaneous publishes cannot open overlapping pull requests. A publish already opening for the same document returns `CONTENT_R0017`; retry after it finishes. If the process stops or cleanup fails, its reservation expires after five minutes and a later publish can reclaim it. Other documents are not held back. A pull request retargeted away from the published branch no longer counts as a pending publish.
- **A refused pull request leaves nothing behind.** If GitHub refuses to open the pull request, Content deletes the publish branch and throws the reason GitHub gave.
- **Publish branches.** Turn on "Automatically delete head branches" in the repository settings, or delete them yourself: Content never deletes a branch after it opened the pull request. `status()` finds pending documents from the `vitehub/publish/` branches and their open pull requests, and not from commit messages, so a pull request whose commit was rewritten still shows.

## Hosts

The preset works on every host where both [Blob](/docs/blob/hosts) and [Database](/docs/database/hosts) work, such as Node with libSQL or a local SQLite file, Cloudflare with D1 and R2, and Vercel. The Workspace reads its files from the Blob store and its refs from the Database, so every instance sees the same drafts and published documents. The [GitHub store](#github-store) needs only network access to GitHub and a Database for sessions.

## Errors

| Code | Cause | What to do |
| --- | --- | --- |
| `CONTENT_B0001` | The build cannot read the preset selection: `extends` is missing or built at runtime, the tuple is not `[cms, { ... }]`, an option is unknown, a value is not a string literal or is not valid for its option, or a GitHub option is used without `store: 'github'`. | Pass `extends: cms` or `extends: [cms, { ... }]` with literal options that the message accepts. |
| `CONTENT_R0006` | The same checks fail when `defineContent()` runs. | Fix the option that the message names. |
| `CONTENT_R0016` | `content.schedule()` ran on a Workspace on the GitHub store. | Use `content.publish()`, or the Blob + Database store. |
| `CONTENT_R0017` | `publish()` with `publish: 'pr'` named a document that an open publish pull request already covers. | Merge or close the pull request that the message names, then publish again. |
| `WORKSPACE_R0072` | The GitHub store has no repository or no token at its first request. | Set `repo` or `VITEHUB_WORKSPACE_GITHUB_REPOSITORY`, and `VITEHUB_GITHUB_TOKEN`. |
| `CONTENT_B0002` | The app lacks something the preset needs: Workspace, Database, or Blob (not with `store: 'github'`) is set to `false`, several Databases match and none is `default`, or the named Database or Blob store does not exist. | Follow the message. It names the `vitehub()` setting or the preset option to set. |
| `WORKSPACE_B0003` | Another Workspace already uses the preset's Workspace name. | Rename one, or pass `[cms, { workspace }]`. |
| `DATABASE_B0010` | The Database Definition already lists the history tables. | Remove them from the Definition. See [Migrate from manual wiring](#migrate-from-manual-wiring). |

## Take over the Database

To configure the Database yourself, for example its connection URL or Cloudflare D1 options, add `server/databases/config.ts`. The preset then stops adding its own Definition and uses yours. Your Definition keeps `server/databases/migrations/`, so existing migrations still apply.

```ts [server/databases/config.ts]
import { defineDatabase } from 'vite-hub/database'

export default defineDatabase({ schema: {} })
```

## Migrate from manual wiring

If you followed the earlier setup, the app has a Database Definition that lists `workspaceHistorySchema` and a Workspace Definition on `createBlobDatabaseWorkspaceStore()`. Keep your existing history by pointing the preset at the same Database, Blob store, and Workspace identity:

1. Remove `workspaceHistorySchema` and `contentSessionsSchema` from the Database Definition. The preset adds the same tables, and listing them twice fails with `DATABASE_B0010`.

   ```ts [server/databases/content/config.ts]
   import { defineDatabase } from 'vite-hub/database'

   export default defineDatabase({ name: 'content', schema: {} })
   ```

2. Delete the Workspace Definition, such as `server/workspaces/site.ts`.
3. Select the preset with the old names. `workspace` must equal the old `createBlobDatabaseWorkspaceStore({ workspace })` identity, because the identity selects the stored history.

   ```ts [server/content.ts]
   export const content = defineContent({
     extends: [cms, { database: 'content', blob: 'content', workspace: 'site' }],
     collections: { posts },
   })
   ```

4. Run `pnpm vitehub db generate`. The tables are unchanged, so it writes no new migration.

If the old Workspace name and its store identity differ, the preset cannot use both. Keep the manual wiring with `defineContent({ workspace })` instead.
