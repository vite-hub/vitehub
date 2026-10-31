# @vite-hub/cms

[![npm version](https://comark-ui.onmax.me/badge.svg?source=npm-version&package=%40vite-hub%2Fcms&icon=npm)](https://www.npmjs.com/package/@vite-hub/cms)
[![license](https://comark-ui.onmax.me/badge.svg?label=license&value=Apache-2.0)](https://github.com/vite-hub/vitehub/blob/main/LICENSE)
[![docs](https://comark-ui.onmax.me/badge.svg?label=docs&value=vitehub.dev)](https://vitehub.dev/docs)

`@vite-hub/cms` is the CMS of ViteHub. It stores the editable collections of [`@vite-hub/content`](https://www.npmjs.com/package/@vite-hub/content) without wiring: Content is the primitive, collections on a Workspace, and the CMS adds that Workspace and its Database tables.

## Turn it on

```ts
// server/content.ts
import { defineContent, documents } from "vite-hub/content"
import cms from "vite-hub/cms"
import * as v from "valibot"

export const content = defineContent({
  extends: cms,
  collections: { posts: documents({ path: "posts/**/*.md", fields: { title: v.string() } }) },
})
```

[`vite-hub`](https://www.npmjs.com/package/vite-hub) then turns on `workspace`, `database`, and `blob` if you left them unset, and registers `hubCms()`. A setting you pass wins, and `false` keeps a feature off. Without `vite-hub`, import `cms` from `@vite-hub/cms` and add `hubCms()` from `@vite-hub/cms/vite` next to the Workspace, Database, and Blob plugins.

At build time `hubCms()` reads `server/content.ts` without running it, so import the preset from `vite-hub/cms` or `@vite-hub/cms`, pass it as `extends: cms` or `extends: [cms, { ... }]`, and give string literal options. It then:

- writes the Workspace Definition to `.vitehub/content/workspace.mjs` and contributes it as the `content` Workspace (option `workspace`);
- adds the `content-history` tables (Blob + Database store) and the `content-sessions` table to the default or only Database (option `database`);
- adds the `default` Database in `.vitehub/content/database.ts` when the app has no Database Definition;
- checks that Workspace, Database, and Blob are enabled and that the Blob store exists (option `blob`, default `default`);
- restarts the dev server when the selection in `server/content.ts` changes.

## GitHub store

`extends: [cms, { repo: "owner/name" }]` keeps documents in a Git repository. `repo` selects the GitHub store; `store: "github"` without `repo` reads `VITEHUB_WORKSPACE_GITHUB_REPOSITORY` when first used. Published content is on `branch` (default `main`) and drafts on `draftBranch` (default `vitehub/content`), created by the first save. `root` (default `""`, the repository root) is the folder that holds the collection paths. `publish: "commit"` (default) commits to `branch`, and `publish: "pr"` opens a pull request. The GitHub store needs a Database for editor sessions and no Blob store. It cannot schedule publishes, so the Console does not ask for a `content.publishDue()` runner.

## Roles

`@vite-hub/cms/access` (`vite-hub/cms/access`) has the CMS roles for the Better Auth `admin` plugin. It needs `better-auth`; the root entry does not import it.

```ts
// server/auth.ts
import { admin } from "better-auth/plugins"
import { defineAuth } from "vite-hub/auth"
import { cmsAccess } from "vite-hub/cms/access"

export default defineAuth({ plugins: [admin(cmsAccess)] })
```

| Role | Content | Comments |
| --- | --- | --- |
| `user` (default) | None | None |
| `viewer` | `read` | None |
| `commenter` | `read` | `read`, `create`, `resolve` |
| `editor` | `read`, `write` | `read`, `create`, `resolve` |
| `publisher` | `read`, `write`, `publish` | `read`, `create`, `resolve` |
| `admin` | Everything, with the Better Auth admin permissions | Everything |

`user.role` holds one role, or several separated by commas. `cmsCan(user, { content: ["publish"] })` checks it without a request; a missing user or an unknown role is denied. Without `authorize` in `defineContent()`, the `cms` preset uses `cmsContentAuthorize`, so a user without a role, such as every user without the `admin` plugin, is denied. `cmsCommentsAuthorize` and `cmsConsoleAuthorize` give Comments and the Console the same roles. `vitehub cms roles` prints the table.

## Inspect

`usesCms({ projectRoot, serverDirs })` and `cmsStore(...)` from `@vite-hub/cms/vite` read `server/content.ts` the same way, without running it. `vitehub inspect definitions --kind database` lists the tables and the Database that the CMS contributes, with `@vite-hub/cms/vite` as the contributor. `vitehub inspect definitions --kind cms` shows the store, the Workspace, and whether the CMS roles or the app's `authorize` decide access.

## Errors

| Code | Meaning |
| --- | --- |
| `CONTENT_B0001` | The build cannot read the preset selection, or an option is unknown or not valid. |
| `CONTENT_B0002` | The app lacks something the preset needs: Workspace, Database, or Blob is off, the Database choice is ambiguous, or a named Database or Blob store does not exist. |
| `CONTENT_R0006` | An option passed to `defineContent({ extends: [cms, { ... }] })` is not valid at runtime. |

See the [CMS docs](https://vitehub.dev/docs/cms).
