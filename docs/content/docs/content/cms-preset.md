---
title: CMS preset
description: Store editable document collections with one preset. ViteHub adds the Workspace and its history tables, and uses your Database and Blob store.
navigation.title: CMS preset
navigation.order: 3.5
icon: i-lucide-newspaper
---

The `cms` preset stores [document collections](/docs/content/configure#document-collections) for you. You write `server/content.ts`. At build time ViteHub adds a Workspace on the [Blob + Database Store](/docs/workspace/configure#blob-database-store) and adds its history tables to your Database. You do not write a Workspace Definition, a schema, or Blob wiring.

## Set up

::steps
### Enable Workspace, Database, and Blob

The preset borrows your Database and Blob store and adds a Workspace, so all three must be on.

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ database: true, blob: true, workspace: true })],
})
```

The app needs a Database Definition. If it has none, add an empty one:

```ts [server/databases/config.ts]
import { defineDatabase } from 'vite-hub/database'

export default defineDatabase({ schema: {} })
```

### Define the collections

```ts [server/content.ts]
import { defineContent, documents } from 'vite-hub/content'
import cms from 'vite-hub/content/presets/cms'
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

### Create the tables and resources

```bash
pnpm vitehub db generate
pnpm vitehub db migrate
```

`db generate` writes a migration with the five `workspace_history_*` tables. `db migrate` applies it to the local Database.

Before a hosted deploy, run `pnpm vitehub provision run --provider cloudflare` or `--provider vercel`. Provision creates the same Database and Blob resources it creates without the preset. On Cloudflare that is a D1 database for a Definition with `cloudflare.databaseName` and an R2 bucket. On Vercel it is a Blob store. The preset creates no resources of its own. See [Provisioning](/docs/development/provisioning).
::

## What the preset adds

| Piece | Value | Inspect it |
| --- | --- | --- |
| Workspace | `content`, on the Blob + Database Store with workspace identity `content` | `vitehub inspect definitions` and the Console Workspaces section list it as contributed by `@vite-hub/content/vite`. The generated module is `.vitehub/content/workspace.mjs`. |
| Database tables | `workspaceHistorySchema` from `vite-hub/workspace/blob-database`, added to the Database named `default`, or to the only Database | `vitehub inspect` and the Console Database section show a `Contributed tables` field. |
| Blob store | `default` | Files are stored under `vitehub/workspace-history/` in that store. |
| `defineContent()` | `workspace: 'content'` | `content.collection(name)` reads and writes that Workspace. |

The collections behave as described in [Document collections](/docs/content/configure#document-collections): saves go to the `draft` ref, `publish()` copies documents to `published`, and `/api/content/**` serves only published documents.

## Options

Pass options as a tuple to use another Database, Blob store, or Workspace name:

```ts [server/content.ts]
export const content = defineContent({
  extends: [cms, { database: 'content', blob: 'media', workspace: 'site' }],
  collections: { posts },
})
```

| Option | Default | Description |
| --- | --- | --- |
| `database` | The Database named `default`, else the only Database | Database Definition that receives the history tables. Required when the app has several Databases and none is named `default`. |
| `blob` | `default` | Blob store that holds file contents. |
| `workspace` | `content` | Name and store identity of the Workspace. It must not match a Workspace in `server/workspaces/`. |

The build reads `server/content.ts` without running it. Import the preset from `vite-hub/content/presets/cms` or `@vite-hub/content/presets/cms`, pass it directly as `extends: cms` or `extends: [cms, { ... }]`, and write each option as a string literal.

## Hosts

The preset works on every host where both [Blob](/docs/blob/hosts) and [Database](/docs/database/hosts) work, such as Node with libSQL or a local SQLite file, Cloudflare with D1 and R2, and Vercel. The Workspace reads its files from the Blob store and its refs from the Database, so every instance sees the same drafts and published documents.

## Errors

| Code | Cause | What to do |
| --- | --- | --- |
| `CONTENT_B0001` | The build cannot read the preset selection: `extends` is missing or built at runtime, the tuple is not `[cms, { ... }]`, an option is unknown, or a value is not a string literal. | Pass `extends: cms` or `extends: [cms, { ... }]` with literal options. |
| `CONTENT_B0002` | The app lacks something the preset needs: Workspace, Database, or Blob is off, the app has no Database Definition, several Databases match and none is `default`, or the named Database or Blob store does not exist. | Follow the message. It names the `vitehub()` setting or the preset option to set. |
| `WORKSPACE_B0003` | Another Workspace already uses the preset's Workspace name. | Rename one, or pass `[cms, { workspace }]`. |
| `DATABASE_B0010` | The Database Definition already lists the history tables. | Remove them from the Definition. See [Migrate from manual wiring](#migrate-from-manual-wiring). |

## Migrate from manual wiring

If you followed the earlier setup, the app has a Database Definition that lists `workspaceHistorySchema` and a Workspace Definition on `createBlobDatabaseWorkspaceStore()`. Keep your existing history by pointing the preset at the same Database, Blob store, and Workspace identity:

1. Remove `workspaceHistorySchema` from the Database Definition. The preset adds the same tables, and listing them twice fails with `DATABASE_B0010`.

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
