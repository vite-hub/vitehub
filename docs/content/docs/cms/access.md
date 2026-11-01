---
title: Roles and access
description: Give each user a CMS role with the Better Auth admin plugin. The roles decide who reads drafts, edits, publishes, and comments, and which Console sections each user sees.
navigation.title: Roles and access
navigation.order: 8
icon: i-lucide-shield-check
---

The CMS has four roles. Each role has the permissions of the role before it:

| Role | Content | Comments |
| --- | --- | --- |
| `viewer` | Read drafts | None |
| `commenter` | Read drafts | Read, comment, and resolve |
| `editor` | Read drafts, and save, remove, and restore them | Read, comment, and resolve |
| `publisher` | Everything that `editor` can do, and publish | Read, comment, resolve, and delete threads |

Two roles come from Better Auth. `admin` has every CMS permission and every Better Auth admin permission. `user` is the role of each new user, and it has no CMS permission. So a person who signs up cannot read drafts until you give them a role.

Published documents stay public through `/api/content/**`. The roles control drafts, edits, publishes, and comments.

## Set up the roles

Install the Better Auth [`admin` plugin](https://www.better-auth.com/docs/plugins/admin) with `cmsAccess`:

```ts [server/auth.ts]
import { admin } from 'better-auth/plugins'
import { defineAuth } from 'vite-hub/auth'
import { cmsAccess } from 'vite-hub/cms/access'

export default defineAuth({
  plugins: [admin(cmsAccess)],
})
```

`cmsAccess` gives the plugin the CMS statements (`cmsStatements`), the access control (`cmsAc`), the roles (`cmsRoles`), `defaultRole: 'user'`, and `adminRoles: ['admin']`. The plugin keeps the roles of a user in `user.role`. A user can have several roles, separated by commas, such as `editor,commenter`. An action is allowed when one of the roles allows it.

## Give a user a role

Use the Better Auth admin API from server code. Better Auth checks that the session in the headers belongs to an `admin`:

```ts [server/routes/api/roles.post.ts]
import { defineHandler } from 'h3'
import { auth } from 'vite-hub/auth/server'

export default defineHandler(async (event) => {
  const { userId, role } = await event.req.json()
  return auth.api.setRole({ body: { userId, role }, headers: event.req.headers })
})
```

Or open the Auth section of the [Console](/docs/auth/console), select the user, and change the role.

To give a role when a user signs up, add a Better Auth database hook. Return the role only for the users that you know, so that the plugin gives everyone else `user`:

```ts [server/auth.ts]
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

Set `extends: [cms, { access: 'roles' }]` to make the CMS roles decide every `content.can()` call when you set no `authorize`. The [Console editor](/docs/content/console) and the [Content Agent Capability](/docs/content/agent-capability) use it. An Agent gets the role of the Auth user that its Actor stands for.

With `extends: cms` alone, every action stays denied, even if your app has an unrelated `user.role` field. The role policy requires this explicit opt-in or `authorize: cmsContentAuthorize`. Once enabled, it loads Better Auth only for a user with a string role; a missing or unknown role is denied.

Set `authorize` to use your own policy. It replaces the CMS roles:

```ts [server/content.ts]
import { defineContent } from 'vite-hub/content'
import { cms } from 'vite-hub/cms'
import { cmsCan } from 'vite-hub/cms/access'

export const content = defineContent({
  extends: cms,
  collections: { posts },
  // Agents may draft, but only people publish.
  authorize: ({ user, actor, action }) => cmsCan(user, { content: [action] }) && (actor === undefined || action !== 'publish'),
})
```

`cmsCan(user, permissions)` reads only `user.role`, so it needs no request. A missing user, a user without a role, and an unknown role are denied. `cmsContentAuthorize` is the role policy as a function. Use it with `defineContent({ workspace })`, which has no preset.

## Comments and the Console

`cmsCommentsAuthorize` gives Comments the same roles. `read` needs `comment:read`, `comment` needs `comment:create`, `resolve` needs `comment:resolve`, and `delete` needs `comment:delete`, which only `publisher` and `admin` have. Signed-in authors may delete their own comments with `comment:create`:

```ts [server/comments.ts]
import { defineComments } from 'vite-hub/comments'
import { cmsCommentsAuthorize } from 'vite-hub/cms/access'

export const comments = defineComments({ authorize: cmsCommentsAuthorize })
```

`cmsConsoleAuthorize` decides which [Console sections](/docs/development/console#limit-a-user-to-some-sections) a user sees. `admin` sees every section. A role with `content:read` sees Content, and a role with `comment:read` sees Comments. A user with neither gets `403`.

```ts [server/console-authorize.ts]
import { defineConsoleAuthorize } from 'vite-hub/console/auth'
import { cmsConsoleAuthorize } from 'vite-hub/cms/access'

export default defineConsoleAuthorize(cmsConsoleAuthorize)
```

Set `console: { auth: 'app', authorize: './server/console-authorize.ts' }` in `vitehub()`, so that the Console uses the app's signed-in user.

## Inspect the roles

`vitehub cms roles` prints each role with its Content and Comments actions. `--json` prints the same as JSON.

```bash
pnpm vitehub cms roles
```

`vitehub inspect definitions --kind cms` shows whether access uses the CMS roles, the app's `authorize`, or no policy.

## Later

Organization roles and roles that admins define at runtime are planned. Today the roles are fixed, and they live on the user.
