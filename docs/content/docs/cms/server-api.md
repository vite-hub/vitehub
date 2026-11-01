---
title: CMS server API
description: The cms preset import, its options and the values they accept, what it sets in defineContent(), and how to use it without vitehub().
navigation.title: Server API
navigation.order: 4
icon: i-lucide-code-2
---

The CMS has one export, the `cms` preset. Pass it to `defineContent({ extends })` in `server/content.ts`. Everything that you call at runtime, such as `content.collection()`, `save()`, and `publish()`, is the [Content server API](/docs/content/server-api).

## Imports

| Import | Use |
| --- | --- |
| `cms` from `vite-hub/cms` | The preset, in an app with `vitehub()`. |
| `cms`, or the default export, from `@vite-hub/cms` | The same preset, for libraries and apps that install the packages one by one. |
| `CmsPresetOptions` type from `vite-hub/cms` or `@vite-hub/cms` | The options of the tuple form. |

```ts [server/content.ts]
import { defineContent, documents } from 'vite-hub/content'
import { cms } from 'vite-hub/cms'
import { z } from 'zod'

export const content = defineContent({
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
| `extends: [cms, { ... }]` | Set some [options](/docs/cms/configure#options). Leave the others out. |

The build reads `server/content.ts` without running it, to add the Workspace and the tables. So the file must:

- import `cms` from `vite-hub/cms` or `@vite-hub/cms`, as a named or a default import;
- pass that binding directly to `extends`, not a value built at runtime;
- write each option as a string literal.

The build follows a re-export of `content` from a relative file, such as `export { content } from './content/index'`. When it cannot read the selection, the build fails with `CONTENT_B0001`. At runtime, `defineContent()` checks the same rules and throws `CONTENT_R0006`.

The preset fills `workspace` in `defineContent()`, so `extends` cannot be combined with `workspace`. With the GitHub store and `publish: 'pr'`, it also selects pull request publishing for `content.publish()`.

## Option values

| Option | Accepts |
| --- | --- |
| `database`, `blob`, `workspace` | A name of letters, numbers, dots, underscores, and dashes that starts with a letter or number. Slashes separate parts, such as `content/main`. |
| `store` | `'blob-database'` or `'github'`. |
| `repo` | A repository as `owner/name`. The owner has letters, numbers, and dashes. The name has letters, numbers, dots, underscores, and dashes, and is not `.` or `..`. |
| `branch`, `draftBranch` | Up to 128 characters: letters, numbers, underscores, and dashes, separated by single dots or slashes, such as `vitehub/content`. |
| `root` | `''` for the repository root, or a folder inside the repository, such as `content`. `.` and `..` parts are not allowed. |
| `publish` | `'commit'` or `'pr'`. |

The options must also fit together:

- `repo`, `branch`, `draftBranch`, `root`, and `publish` need the GitHub store: `repo`, or `store: 'github'`. With `store: 'blob-database'` they fail.
- `blob` does not apply to the GitHub store.
- `draftBranch` must differ from `branch`. The defaults are `vitehub/content` and `main`.
- An option that is not in the table fails.

## Without vitehub()

`vitehub()` turns on the CMS, Workspace, Database, and Blob plugins for the preset. Without it, install `@vite-hub/content` and `@vite-hub/cms`, then add `hubContent()` from `@vite-hub/content/vite` and `hubCms()` from `@vite-hub/cms/vite` next to the Workspace, Database, and Blob plugins. The CMS plugin then adds the Workspace, the tables, and, when the app has none, the Database. See [Public imports](/docs/content/server-api#public-imports) for the other `@vite-hub/content` imports.
