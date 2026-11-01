---
title: CMS configuration
description: Choose the Database, Blob store, and Workspace of the cms preset, keep documents in a GitHub repository, publish through pull requests, and decide who may edit and publish.
navigation.title: Configure
navigation.order: 3
icon: i-lucide-sliders-horizontal
---

The `cms` preset works without options. Pass options as a tuple when you need another Database, Blob store, Workspace name, or the GitHub store:

```ts [server/content.ts]
import { defineContent } from 'vite-hub/content'
import { cms } from 'vite-hub/cms'

export const content = defineContent({
  extends: [cms, { database: 'content', blob: 'media', workspace: 'site' }],
  collections: { posts },
})
```

## Options

| Option | Default | Description |
| --- | --- | --- |
| `access` | No policy | Set `'roles'` to opt into the CMS role policy. Your own `authorize` overrides it. |
| `database` | The Database named `default`, else the only Database, else a `default` Database that the preset adds | Database Definition that receives the history tables and the editor sessions table. Required when the app has several Databases and none is named `default`. |
| `blob` | `default` | Blob store that holds file contents. Not for the GitHub store. |
| `workspace` | `content` | Name and store identity of the Workspace. It must not match a Workspace in `server/workspaces/`. |
| `store` | `github` with `repo`, else `blob-database` | Where documents live. `github` keeps them in a repository. See [GitHub store](#github-store). |
| `repo` | `VITEHUB_WORKSPACE_GITHUB_REPOSITORY` | GitHub store: the repository, as `owner/name`. Setting it selects the GitHub store. |
| `branch` | `main` | GitHub store: the published branch. `content.publish()` commits here. |
| `draftBranch` | `vitehub/content` | GitHub store: the draft branch. The first save creates it from `branch`. It must differ from `branch`. |
| `root` | `''` | GitHub store: the folder of the repository that collection paths start from. `''` is the repository root. |
| `publish` | `commit` | GitHub store: how a publish reaches `branch`. `commit` commits to it, `pr` opens a pull request. See [Pull request mode](#pull-request-mode). |

The build reads `server/content.ts` without running it. Import the preset from `vite-hub/cms` or `@vite-hub/cms`, pass it directly as `extends: cms` or `extends: [cms, { ... }]`, and write each option as a string literal. The [Server API](/docs/cms/server-api#option-values) lists the values that each option accepts.

The preset sets `workspace` in `defineContent()`, so do not pass it next to `extends`.

## Turn the features on

`vitehub()` needs no feature settings for the preset. When `server/content.ts` selects it, `vitehub()` turns on `workspace`, `database`, and `blob` if you left them unset. The GitHub store needs no Blob.

A setting you pass wins. `blob: { stores: { media: ... } }` configures Blob. `workspace: false` keeps Workspace off and fails the build with [`CONTENT_B0002`](/docs/cms/limits-and-errors#errors).

## What the preset adds

| Piece | Value | Inspect it |
| --- | --- | --- |
| Workspace | `content`, on the [Blob + Database Store](/docs/workspace/configure#blob-database-store) with workspace identity `content` | `vitehub inspect definitions` and the Console Workspaces section list it as contributed by `@vite-hub/cms/vite`. The generated module is `.vitehub/content/workspace.mjs`. |
| Database | Only when the app has no Database Definition: the `default` Database, from the generated `.vitehub/content/database.ts`. Its migrations go to `server/databases/migrations/`, where `server/databases/config.ts` would keep them. | `vitehub inspect definitions --kind database` lists it with `Contributed by: @vite-hub/cms/vite` and a `Reason` field naming the cms preset. |
| Database tables | `workspaceHistorySchema` from `vite-hub/workspace/blob-database` and `contentSessionsSchema` from `vite-hub/content/database`, added to the Database named `default`, or to the only Database | `vitehub inspect` and the Console Database section show a `Contributed tables` field. |
| Features | `workspace`, `database`, and `blob` turn on when `vitehub()` leaves them unset | The `@vite-hub/workspace/vite`, `@vite-hub/database/vite`, and `@vite-hub/blob/vite` plugins are in the resolved Vite config. |
| Blob store | `default` | Files are stored under `vitehub/workspace-history/` in that store. |
| `defineContent()` | `workspace: 'content'`, and with `access: 'roles'`, the CMS roles as `authorize` when the app sets none | `content.collection(name)` reads and writes that Workspace. `vitehub inspect definitions --kind cms` shows what decides access. |

The collections behave as described in [Document collections](/docs/content/configure#document-collections): saves go to the `draft` ref, `publish()` copies documents to `published`, and `/api/content/**` serves only published documents.

## Access

Opt into CMS roles with `extends: [cms, { access: 'roles' }]`. Install the Better Auth `admin` plugin with `admin(cmsAccess)` from `vite-hub/cms/access`, and give each user a role: `viewer`, `commenter`, `editor`, or `publisher`. `admin` may do everything, and `user`, the role of new users, may do nothing. With no opt-in or `authorize`, every action stays denied. [Roles and access](/docs/cms/access) explains the setup.

The [Console editor](/docs/content/console) and the [Content Agent Capability](/docs/content/agent-capability) check access through `content.can()`. To use your own policy instead of the roles, set `authorize` in `defineContent()`:

```ts [server/content.ts]
export const content = defineContent({
  extends: cms,
  collections: { posts },
  // Editors do everything. Other signed-in users read drafts.
  authorize: ({ user, action }) => user?.role === 'editor' || (action === 'read' && Boolean(user)),
})
```

`action` is `read` for drafts, `write` for save, remove, and restore, or `publish`. Published documents stay public through `/api/content/**`.

- [Access](/docs/content/configure#access) lists every field that `authorize` gets, and shows how to give Agents less than the user they act for.
- [Give editors only the Content section](/docs/content/console#give-editors-only-the-content-section) keeps editors out of the other Console sections.

## GitHub store

Set `repo` to keep documents in a Git repository instead of Blob and the Database. Published content is on one branch, drafts are on another, and a publish is a commit. Choose this store when someone edits content files in a checkout: local edits and online edits then meet in Git. Without `repo`, files on collection paths are not the content; the Blob + Database store is, and it needs no GitHub access.

```ts [server/content.ts]
export const content = defineContent({
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

Set `VITEHUB_GITHUB_TOKEN` to a token that can read and write the repository. The token is read at the first request, not at build time.

The options `repo`, `branch`, `draftBranch`, `root`, and `publish` work only with the GitHub store. The `blob` option does not work with it. Set `store: 'github'` without `repo` only for a GitHub store that reads the repository from `VITEHUB_WORKSPACE_GITHUB_REPOSITORY`. The store comes only from these options, never from the environment, so every build of the app reads content from the same place.

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
- **Draft sync.** Before a write or a publish, when `branch` moved since the draft last merged it, Content merges `branch` into `draftBranch` with the GitHub Merges API on a temporary branch, validates the merged files through Workspace write policy, then updates `draftBranch` and deletes the temporary branch. Reads do not merge. Documents the draft did not change arrive as they are, and for a document both sides changed the merge keeps both edits when they touch different lines. If the same lines changed, Content merges that document itself: fields one by one, and the Markdown body word by word. Edits to different fields, or to different words of one paragraph, merge into the draft, which then builds on the version of `branch`; a person still sees the result before it is published. A field or words that both sides changed differently, or a delete against an edit, keep the draft's version of that document. When `branch` holds a version that the draft once had (its own publish, merged, squashed, or rebased), the draft's newer text just wins and nothing conflicts; otherwise the document is marked as changed on both sides and `publish()` refuses it. The merge commit records the `branch` revision it brought in. If GitHub or Workspace write policy refuses the merge (permissions, a missing branch, rate limits, or a denied file change), the sync is skipped with one warning and the write goes on.
- **Publish.** `content.publish()` copies the documents that the draft changed to `branch` in one commit. The commit checks that `draftBranch` did not move. Other files of the repository stay as they are, and so do documents that changed or were added only on `branch`.
- **Other files.** The generated Workspace denies every write except to the collection paths, for any `root`. Agents and raw history commits cannot change `package.json` or other files, and `main` and `draftBranch` can be written only as `published` and `draft`. With a `root` folder, the Workspace reads and writes files in that folder only.

A document that the draft and `branch` both changed cannot be published until someone reviews the version on `branch`. See [Changed on both sides](/docs/cms/limits-and-errors#changed-on-both-sides).

### Pull request mode

With `publish: 'pr'`, `content.publish()` does not touch `branch`. It checks the documents with the same rules as commit mode (only what the draft changed, whole publish refused on a conflict), then:

1. creates the branch `vitehub/publish/<draft7>-<timestamp>-<uuid>` from the head of `branch` (`<draft7>` is the first 7 characters of the draft revision), and commits the changes there;
2. opens a pull request from that branch into `branch`;
3. returns `{ revision, documents, pullRequest: { number, url }, pending: true }`. `revision` is the commit on the publish branch.

`onPublish` listeners and Comark source refreshes run when `branch` changes, so they do not run for a pending publish. Until the pull request merges, `status()` keeps the state of the document (`draft` or `changed`) and adds `pullRequest: { number, url }`. When `branch` has the bytes of the publish branch, the document is `published` and the link goes away. A closed pull request that was not merged shows nothing; the draft still has the change. The Console shows the link in the publish message, and `vitehub content publish` prints it.

The pull request is a normal one: review it, wait for checks, and merge it with any method. A merge commit, a squash, and a rebase all work: when the draft has changed since, it keeps its newer text. The token needs permission to create branches and pull requests.

- **One pull request per document.** A document that an open publish pull request already covers cannot be published again: `publish()` throws `CONTENT_R0017` with the pull request link. Merge or close it first. See [Pull request reservations](/docs/cms/limits-and-errors#pull-request-reservations) for publishes from several instances at once.
- **A refused pull request leaves nothing behind.** If GitHub refuses to open the pull request, Content deletes the publish branch and throws the reason GitHub gave.
- **Publish branches.** Turn on "Automatically delete head branches" in the repository settings, or delete them yourself: Content never deletes a branch after it opened the pull request. `status()` finds pending documents from the `vitehub/publish/` branches and their open pull requests, and not from commit messages, so a pull request whose commit was rewritten still shows.

## Take over the Database

To configure the Database yourself, for example its connection URL or Cloudflare D1 options, add `server/databases/config.ts`. The preset then stops adding its own Definition and uses yours. Your Definition keeps `server/databases/migrations/`, so existing migrations still apply.

```ts [server/databases/config.ts]
import { defineDatabase } from 'vite-hub/database'

export default defineDatabase({ schema: {} })
```

## Import existing Markdown

With the Blob + Database store, the Workspace keeps the only copy of each document. Markdown files that stay in the repository after you import them are a second copy. Editors change the Workspace, so the files go out of date, and an import that runs again can restore old text. Import the files once, then delete them:

1. Save each file as a draft. Run the commands against the deployed app with `--url`, or against the dev server without it.

   ```bash [commands/import]
   pnpm vitehub content edit posts hello --file ./posts/hello.md --url https://example.com
   ```

2. Publish the drafts. The command lists the changes and pins their digests.

   ```bash [commands/publish]
   pnpm vitehub content publish --url https://example.com
   ```

3. Delete the files from the repository, and any code that reads them.

A new environment then starts with an empty Workspace. To copy documents into it, read each one from the deployed app with `vitehub content show`, then save it in the new environment with `vitehub content edit --file`. If the repository must stay the source of the documents, use the [GitHub store](#github-store) instead.

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
