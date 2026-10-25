---
title: Configure comments
description: Set the access policy, add subject kinds, react to mentions, and choose the Database.
navigation.title: Configure
navigation.order: 3
icon: i-lucide-settings
---

## Access: `authorize`

```ts [server/comments.ts]
export default defineComments({
  authorize: ({ user, actor, action, thread }) => { /* … */ },
})
```

| Field | Meaning |
| --- | --- |
| `user` | The signed-in user, or `null`. |
| `actor` | The Agent Actor when an agent acts for `user`. |
| `action` | `read`, `write`, `resolve`, or `delete`. |
| `thread` | The thread, when the action is about one. Not set for `create`, `list`, and `users`. |

Return `true` to allow. The policy runs for every operation, on every surface: the Console, the CLI, MCP, and agents.

- Without `authorize`, nobody can read or write. Calls fail with `COMMENTS_R0006`, and the Console section says **No policy**.
- Authors always edit their own messages and delete their own messages. Nobody else edits a message.
- `delete` covers the comments of other people. `resolve` covers resolving and reopening.
- `list` asks `read` once without a thread, and again for each thread, and drops the threads you may not read.

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

A message mentions people by id, and its text names each one with `@name`. The server checks both: the id must belong to a real person, and the text must contain `@` and that person's name. Where people come from:

- With [Auth](/docs/auth), `users()` and the mention check read the Better Auth users.
- Without Auth, they are the authors that comments know.

```ts [server/comments.ts]
export default defineComments({
  authorize: ({ user }) => Boolean(user),
  onMention: async ({ thread, message, mentioned }) => {
    await notify(mentioned, `/pricing?comment=${thread.n}`, message.body)
  },
})
```

`onMention` runs after the comment is saved, through `waitUntil` where the host has it. A failure is logged and never fails the comment. It receives only the people that the message mentions for the first time.

## Database

`vitehub({ database: true })` gives comments the default Database. To choose another:

```ts [vite.config.ts]
vitehub({ database: true, comments: { database: 'main' } })
```

For Postgres set `comments: { dialect: 'postgresql' }`. To wire the tables yourself, import `commentsSchema` from `vite-hub/comments/database` (SQLite, libSQL, D1) or `commentsPostgresSchema` from `vite-hub/comments/database/postgres`, and add it to your Database Definition.
