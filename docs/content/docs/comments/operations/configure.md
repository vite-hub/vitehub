---
title: Configure comments
description: Set the access policy, add subject kinds, react to mentions, and choose the Database.
navigation.title: Configure operations
navigation.order: 22
icon: i-lucide-settings
---

## Access: `authorize`

```ts [server/comments.ts]
import { defineComments } from 'vite-hub/comments'

export default defineComments({
  authorize: ({ user, actor, action, thread, subject }) => {
    if (action === 'read') return true
    // Agents and guests may not delete. Editors may resolve any thread of a doc.
    if (action === 'delete') return !actor && thread?.author.id === user?.id
    return action !== 'resolve' || (subject?.kind === 'doc' && user?.role === 'editor')
  },
})
```

| Field | Meaning |
| --- | --- |
| `user` | The signed-in user, including application fields such as `role`, or `null`. Stored authors and mention suggestions contain only `id`, `name`, and `image`. |
| `actor` | The Agent Invoker when an agent acts for `user`. |
| `action` | `read`, `write`, `resolve`, or `delete`. |
| `thread` | The thread the action is about. Not set for `create`, `list`, and `users`. |
| `subject` | The subject of `thread`, of the new thread for `create`, or of the `list` filter. Not set for `users` or an unfiltered `list`. |

Return `true` to allow. The policy runs for every operation on every surface: the Console, the CLI, MCP, agents, and the overlay API.

- `user` comes from `identify` for the call's request, as in the overlay API. Without `identify`, it is the Console user.
- Without `authorize`, the default policy of [Decide who can comment](/docs/comments/configure#decide-who-can-comment) applies. Operations run only after the Console admits the call to its Comments section. So without `identify`, those people may do all that their grant allows. Anonymous people may act only on the dev server, as guests.
- Creating a thread asks `read`, then `write`, with its subject. Mention suggestions ask `read`, then `write`, with no thread or subject.
- Each operation on a thread asks `read` first. A thread you may not read looks missing: `get` returns `null`, and `reply`, `edit`, `delete`, `resolve`, and `reopen` fail with `COMMENTS_R0002`.
- People who may read a thread can edit and delete their own messages. Nobody else edits a message. An Agent has no such right, even for the author: `edit` needs `write`, and `delete` needs `delete`.
- `delete` covers other people's messages. Deleting a whole thread, or its first message, needs `delete` unless every message in it is yours.
- `resolve` covers resolving and reopening.
- `list` asks `read` for each thread, up to 16 checks at once, and drops threads you may not read.
- `users()` suggests people only to someone who may `write`, and only from authors of threads you may read.

The operations also sit behind the Console section `comments`, so `console.authorize` decides who reaches them at all.

## Subjects

Each thread is about a subject: `{ kind, id }`. `kind` picks the numbering scope.

| Kind | `id` | Scope |
| --- | --- | --- |
| `page` | An app path such as `/pricing` | `site` |
| `content` | `<collection>/<id>` | `site` |

Numbers are unique in a scope, so `?comment=3` names one thread of the site. Add your own kinds:

```ts [server/comments.ts]
import { defineCommentSubject, defineComments } from 'vite-hub/comments'

export default defineComments({
  authorize: ({ user }) => Boolean(user),
  subjects: [
    // Every version of a drop shares one number sequence.
    defineCommentSubject({ kind: 'drop', scope: id => `drop:${id.split('@')[0]}` }),
  ],
})
```

## Mentions

A message mentions people by id, and its text names each one with `@name`. The server checks that:

- The id belongs to a real person.
- The text contains `@` and that person's name.
- `canMention` allows them. By default, it allows people who may read the thread.

People come from:

- `people`, when set.
- [Auth](/docs/auth) Better Auth users. `users()` searches their name and returns only `id`, `name`, and `image`.
- Otherwise, known comment authors who have a thread you may read.

`users({ query, threadId?, subject? })` leaves out people that `canMention` refuses for that thread or subject. See [Mention people](/docs/comments/configure#mention-people).

```ts [server/comments.ts] fragment
export default defineComments({
  authorize: ({ user }) => Boolean(user),
  onMention: async ({ users, message, link }) => {
    await notify(users, link, message.body)
  },
})
```

`onMention` runs once per saved message, through `waitUntil` where the host has it. A failure is logged and never fails the comment. It gets the people the message mentions for the first time, and `link`, the app path that opens the thread. `comments.reply` also replies to a resolved thread, which stays resolved. The comment UI keeps a reply box there.

## Overlay

The overlay is the `comments` page tool from [Turn comment mode on and off](/docs/comments/configure#turn-comment-mode-on-and-off). It works without the Console, also for guests when `authorize` allows them. `vitehub({ comments: { overlay: false } })` removes it.

## Database

With `server/comments.ts` and no `database` option, `vitehub()` turns the Database on, and Comments use the default Database. Without a Database Definition, that is the implicit `default` Database, as for the Content cms preset. `database: false` fails the build with `COMMENTS_B0001`. To pick another Database:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { comments: { database: 'main' } },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ comments: { database: 'main' } }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ comments: { database: 'main' } })],
})
```
:::
::

For Postgres, set `comments: { dialect: 'postgresql' }`. To wire the tables yourself, add `commentsSchema` from `vite-hub/comments/database` (SQLite, libSQL, D1) or `commentsPostgresSchema` from `vite-hub/comments/database/postgres` to your Database Definition.
