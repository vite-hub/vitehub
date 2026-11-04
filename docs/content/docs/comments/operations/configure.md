---
title: Configure comments
description: Set the access policy, add subject kinds, react to mentions, and choose the Database.
navigation.title: Configure operations
navigation.order: 22
icon: i-lucide-settings
---

## Access: `authorize`

```ts [server/comments.ts]
export default defineComments({
  authorize: ({ user, actor, action, thread, subject }) => { /* … */ },
})
```

| Field | Meaning |
| --- | --- |
| `user` | The signed-in user, including application fields such as `role`, or `null`. Stored authors and mention suggestions contain only `id`, `name`, and `image`. |
| `actor` | The Agent Actor when an agent acts for `user`. |
| `action` | `read`, `write`, `resolve`, or `delete`. |
| `thread` | The thread, when the action is about one. Not set for `create`, `list`, and `users`. |
| `subject` | What the action is about: the subject of `thread`, the subject that `create` starts a thread on, or the subject that a `list` filters by. Not set for a `list` with no filter and for `users`. |

Return `true` to allow. The policy runs for every operation, on every surface: the Console, the CLI, MCP, agents, and the overlay API.

- `user` is the user that `identify` builds for the request of the call, as in the overlay API. Without `identify`, it is the Console user.
- Without `authorize`, the default policy of [Decide who can comment](/docs/comments/configure#decide-who-can-comment) applies. The operations run only after the Console admitted the call to its Comments section, so, without `identify`, those people may do everything that their grant allows. Anonymous people may only on the dev server, as guests.
- Creating a thread asks `read`, then `write`, with its subject. Mention suggestions ask `read`, then `write`, without a thread or subject.
- Every operation on a thread asks `read` for that thread first. A thread you may not read looks missing: `get` answers `null`, and `reply`, `edit`, `delete`, `resolve`, and `reopen` fail with `COMMENTS_R0002`, the same as for a thread that does not exist.
- People edit their own messages and delete their own messages, once they may read the thread. Nobody else edits a message. An Agent has no such right, even when it acts for the author: `edit` needs `write`, and `delete` needs `delete`.
- `delete` covers the messages of other people. A person deletes a whole thread, or its first message, only when every message in it is theirs; otherwise it needs `delete`.
- `resolve` covers resolving and reopening.
- `list` asks `read` for each thread, with up to 16 checks at once, and drops the threads you may not read.
- `users()` suggests people only to someone who may `write`, and the store looks only at authors of threads you may read.

The operations also sit behind the Console section `comments`, so `console.authorize` decides who reaches them at all.

## Subjects

A thread is about a subject: `{ kind, id }`. `kind` picks the numbering scope.

| Kind | `id` | Scope |
| --- | --- | --- |
| `page` | An app path such as `/pricing` | `site` |
| `content` | `<collection>/<id>` | `site` |

Numbers are unique inside a scope, so `?comment=3` names one thread of the site. Add your own kinds:

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

A message mentions people by id, and its text names each one with `@name`. The server checks three things: the id must belong to a real person, the text must contain `@` and that person's name, and `canMention` must allow them, by default when they may read the thread. Where people come from:

- With `people`, the people that it finds.
- With [Auth](/docs/auth), the Better Auth users. `users()` searches their name, and returns only `id`, `name`, and `image`.
- Without both, the authors that comments know, and only those with a thread that you may read.

`users({ query, threadId?, subject? })` leaves out the people that `canMention` refuses for that thread or subject. See [Mention people](/docs/comments/configure#mention-people).

```ts [server/comments.ts]
export default defineComments({
  authorize: ({ user }) => Boolean(user),
  onMention: async ({ users, message, link }) => {
    await notify(users, link, message.body)
  },
})
```

`onMention` runs once for each saved message, through `waitUntil` where the host has it. A failure is logged and never fails the comment. It receives the people that the message mentions for the first time, and `link`, the app path that opens the thread. `comments.reply` replies to a resolved thread too, and the thread stays resolved: the comment UI keeps a reply box there.

## Overlay

The overlay is the `comments` page tool of [Turn comment mode on and off](/docs/comments/configure#turn-comment-mode-on-and-off). It works without the Console, for guests too when `authorize` allows them. `vitehub({ comments: { overlay: false } })` leaves it out.

## Database

With `server/comments.ts` and no `database` option, `vitehub()` turns the Database on, and Comments use the default Database. When the app has no Database Definition, that is the implicit `default` Database, as for the Content cms preset. Setting `database: false` fails the build with `COMMENTS_B0001`. To choose another Database:

```ts [vite.config.ts]
vitehub({ comments: { database: 'main' } })
```

For Postgres set `comments: { dialect: 'postgresql' }`. To wire the tables yourself, import `commentsSchema` from `vite-hub/comments/database` (SQLite, libSQL, D1) or `commentsPostgresSchema` from `vite-hub/comments/database/postgres`, and add it to your Database Definition.
