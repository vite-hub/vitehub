---
title: CMS server API
description: The cms preset import, its options and the values they accept, what it sets in defineContent(), and how to use it without vitehub().
navigation.title: Server API
navigation.order: 5
icon: i-lucide-code-2
---

The CMS gives you the `cms` preset and roles. Pass the preset to `defineContent({ extends })` in `server/content.ts`. What you call at runtime, such as `content.collection()`, `save()`, and `publish()`, is the [Content server API](/docs/content/server-api).

## Imports

| Import | Use |
| --- | --- |
| `cms` from `vite-hub/cms` | The preset, in an app with `vitehub()`. |
| `cms`, or the default export, from `@vite-hub/cms` | The same preset, for libraries and apps that install each package. |
| `CmsPresetOptions` type from `vite-hub/cms` | The options of the tuple form. |
| `cmsAccess`, `cmsCan`, `cmsContentAuthorize`, `cmsCommentsAuthorize`, and `cmsConsoleAuthorize` from `vite-hub/cms/access` | The CMS roles for the Better Auth `admin` plugin, and policies built on them ([Roles and access](/docs/cms/access)). `cmsStatements`, `cmsAc`, and `cmsRoles` are the parts of `cmsAccess`. |

```ts [server/content.ts]
import { defineContent } from 'vite-hub/content'
import { documents } from 'vite-hub/content/collections'
import { cms } from 'vite-hub/cms'
import { z } from 'zod'

export default defineContent({
  extends: [cms, { workspace: 'site' }],
  collections: {
    posts: documents({ path: 'posts/**/*.md', fields: { title: z.string() } }),
  },
})
```

## Select the preset

`extends` takes the preset alone or a tuple with options:

| Form | Use |
| --- | --- |
| `extends: cms` | Every option at its default. |
| `extends: [cms, { ... }]` | Set only the [options](/docs/cms/configure#options) you need. |

The build reads `server/content.ts` without running it, to add the Workspace and tables. So the file must:

- import `cms` from `vite-hub/cms` or `@vite-hub/cms`, as a named or default import;
- pass that import directly to `extends`, not a value built at runtime;
- write each option as a string literal.

The build follows a re-export of the default export from a relative file, such as `export { default } from './content/index'`. When it cannot read the selection, the build fails with `CONTENT_B0001`. At runtime, `defineContent()` checks the same rules and throws `CONTENT_R0006`.

The preset fills `workspace` in `defineContent()`, so you cannot use `extends` with `workspace`. It also:

- fills `authorize` with the CMS role policy when you set `access: 'roles'` and no `authorize`. Without either, every action is denied.
- uses pull request publishing for `content.publish()` with the GitHub store and `publish: 'pr'`.

## Option values

| Option | Accepts |
| --- | --- |
| `access` | `'roles'` to turn on the CMS role policy. |
| `database`, `blob`, `workspace` | Letters, numbers, dots, underscores, and dashes, starting with a letter or number. Slashes separate parts, such as `content/main`. |
| `store` | `'blob-database'` or `'github'`. |
| `repo` | A repository as `owner/name`. The owner has letters, numbers, and dashes. The name has letters, numbers, dots, underscores, and dashes, and is not `.` or `..`. |
| `branch`, `draftBranch` | Up to 128 characters: letters, numbers, underscores, and dashes, separated by single dots or slashes, such as `vitehub/content`. |
| `root` | `''` for the repository root, or a folder in it, such as `content`. No `.` or `..` parts. |
| `publish` | `'commit'` or `'pr'`. |

Options must fit together:

- `repo`, `branch`, `draftBranch`, `root`, and `publish` need the GitHub store (`repo` or `store: 'github'`). They fail with `store: 'blob-database'`.
- `blob` does not apply to the GitHub store.
- `draftBranch` must differ from `branch`. The defaults are `vitehub/content` and `main`.
- An unknown option fails.

## Without vitehub()

`vitehub()` turns on the CMS, Workspace, Database, and Blob plugins for the preset. Without it, install `@vite-hub/content` and `@vite-hub/cms`. Then add `hubContent()` from `@vite-hub/content/vite` and `hubCms()` from `@vite-hub/cms/vite` next to the Workspace, Database, and Blob plugins. The CMS plugin adds the Workspace, the tables, and a Database if the app has none. [Public imports](/docs/content/server-api#public-imports) lists the other `@vite-hub/content` imports.
