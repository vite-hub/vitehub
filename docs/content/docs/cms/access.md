---
title: Roles and access
description: "Give each user a CMS role with the Better Auth admin plugin. Roles decide who reads drafts, edits, publishes, and comments, and which Console sections they see."
navigation.title: Roles and access
navigation.order: 8
icon: i-lucide-shield-check
---

The CMS has four roles. Each role has the permissions of the one above it:

| Role | Content | Comments |
| --- | --- | --- |
| `viewer` | Read `/api/content/**` and drafts | None |
| `commenter` | Read `/api/content/**` and drafts | Read, comment, and resolve |
| `editor` | All `viewer` actions, and save, remove, and restore drafts | Read, comment, and resolve |
| `publisher` | All `editor` actions, and publish | Read, comment, resolve, and delete threads |

Two roles come from Better Auth:

- `admin` has every CMS and Better Auth admin permission.
- `user` is the role of each new user. It has no CMS permission, so a new user cannot read drafts until you give them a role.

The role policy also decides `read`, the [`/api/content/**` route](/docs/content/configure#public-access), so a visitor without a role gets `401`. When visitors read that route, set `access: 'public'`. The roles still decide drafts, writes, and publishing:

```ts [server/content.ts] fragment
export default defineContent({
  extends: [cms, { access: 'roles' }],
  collections: { posts },
  access: 'public',
})
```

## Set up the roles

Install the Better Auth [`admin` plugin](https://www.better-auth.com/docs/plugins/admin) with `cmsAccess`:

```ts [server/auth.ts]
import { admin } from 'better-auth/plugins'
import { defineAuth } from 'vite-hub/auth'
import { authDatabase } from 'vite-hub/auth/database'
import { cmsAccess } from 'vite-hub/cms/access'

export default defineAuth({
  database: authDatabase(),
  plugins: [admin(cmsAccess)],
})
```

`cmsAccess` gives the plugin the CMS statements (`cmsStatements`), access control (`cmsAc`), roles (`cmsRoles`), `defaultRole: 'user'`, and `adminRoles: ['admin']`. The plugin stores a user's roles in `user.role`, separated by commas, such as `editor,commenter`. An action is allowed when any role allows it.

## Give a user a role

Call the Better Auth admin API from server code. Better Auth checks that the session in the headers is an `admin`:

```ts [server/routes/api/roles.post.ts]
import { defineHandler, readValidatedBody } from 'h3'
import * as v from 'valibot'
import { auth } from 'vite-hub/auth/server'

const body = v.object({
  userId: v.string(),
  role: v.picklist(['user', 'viewer', 'commenter', 'editor', 'publisher', 'admin']),
})

export default defineHandler(async (event) => {
  const { userId, role } = await readValidatedBody(event, body)
  return auth.api.setRole({ body: { userId, role }, headers: event.req.headers })
})
```

Or open the Auth section of the [Console](/docs/auth/console), select the user, and change the role.

To give a role at sign-up, add a Better Auth database hook. Return a role only for users you know, so everyone else gets `user`:

```ts [server/auth.ts] fragment
export default defineAuth({
  plugins: [admin(cmsAccess)],
  databaseHooks: {
    user: {
      create: {
        before: async user => ({ data: user.email === 'lead@example.com' ? { ...user, role: 'publisher' } : user }),
      },
    },
  },
})
```

## Opt into the role policy

Set `extends: [cms, { access: 'roles' }]` so the CMS roles decide every `content.can()` call when you set no `authorize`. The [Console editor](/docs/content/console) and the [Content Agent Capability](/docs/content/agent-capability) use it. An Agent gets the role of the Auth user that it acts for.

> [!NOTE]
> With `extends: cms` alone, every action is denied, even if your app has an unrelated `user.role` field. Turn on the role policy with `access: 'roles'` or `authorize: cmsContentAuthorize`. It then loads Better Auth only for a user with a string role. A missing or unknown role is denied.

Set `authorize` to use your own policy. It replaces the CMS roles:

```ts [server/content.ts] fragment
import { defineContent } from 'vite-hub/content'
import { cms } from 'vite-hub/cms'
import { cmsCan } from 'vite-hub/cms/access'

export default defineContent({
  extends: cms,
  collections: { posts },
  // Agents may draft, but only people publish.
  authorize: ({ user, actor, action }) => cmsCan(user, { content: [action] }) && (actor === undefined || action !== 'publish'),
})
```

`cmsCan(user, permissions)` reads only `user.role`, so it needs no request. It denies a missing user, a user without a role, and an unknown role. `cmsContentAuthorize` is the role policy as a function. Use it with `defineContent({ workspace })`, which has no preset.

## Comments and the Console

`cmsCommentsAuthorize` gives Comments the same roles:

- `read` needs `comment:read`.
- `comment` needs `comment:create`.
- `resolve` needs `comment:resolve`.
- `delete` needs `comment:delete`, which only `publisher` and `admin` have. Signed-in authors can delete their own comments with `comment:create`.

```ts [server/comments.ts]
import { defineComments } from 'vite-hub/comments'
import { cmsCommentsAuthorize } from 'vite-hub/cms/access'

export const comments = defineComments({ authorize: cmsCommentsAuthorize })
```

`cmsConsoleAuthorize` decides which [Console sections](/docs/console/access#what-authorize-returns) a user sees. `admin` sees all. `content:read-draft` shows Content, and `comment:read` shows Comments. A user with neither gets `403`.

```ts [server/console-authorize.ts]
import { defineConsoleAuthorize } from 'vite-hub/console/auth'
import { cmsConsoleAuthorize } from 'vite-hub/cms/access'

export default defineConsoleAuthorize(cmsConsoleAuthorize)
```

Set `console: { authorize: './server/console-authorize.ts' }` in `vitehub()`. The Console signs the person who calls, and `authorize` gets that user.

## Inspect the roles

`vitehub cms roles` prints each role with its Content and Comments actions. Add `--json` for JSON.

```bash
pnpm vitehub cms roles
```

`vitehub inspect definitions --kind cms` shows whether access uses the CMS roles, the app's `authorize`, or no policy.

## Later

Organization roles and roles that admins define at runtime are planned. Today the roles are fixed and live on the user.
