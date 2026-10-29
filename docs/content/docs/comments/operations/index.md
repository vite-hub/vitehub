---
title: Comments
navigation.title: Overview
description: Store the comment threads of your running app, check who may read and write them, and read them from the Console, the CLI, and agents.
navigation.order: 1
icon: i-lucide-message-square
---

Comments let a signed-in team member leave a numbered note on any spot of your own running app, and let the team reply. This package is the server half: tables, access rules, and the `comments.*` [operations](/docs/development/operations). The browser half is in [UI comments](/docs/ui/comments).

```ts [server/comments.ts]
import { defineComments } from 'vite-hub/comments'

export default defineComments({
  authorize: ({ user }) => Boolean(user),
})
```

Add the file and ViteHub does the rest:

- It adds the `vitehub_comment_threads`, `vitehub_comment_messages`, and `vitehub_comment_counters` tables to your Database.
- It adds the operations `comments.list`, `get`, `create`, `reply`, `edit`, `delete`, `resolve`, `reopen`, and `users`. The Console, `vitehub comments list`, the [MCP endpoint](/docs/development/mcp), and the browser client call the same code.
- It adds a **Comments** section to the [Console](/docs/development/console) that lists the threads the signed-in user may read, with filter chips and a link to the page.

Comments are private. Without an `authorize` policy nobody can read or write them, and the Console says so.

## Next steps

- [Get started](/docs/comments/operations/get-started) adds comments to an app.
- [Configure](/docs/comments/operations/configure) covers `authorize`, subjects, mentions, and the Database.
- [Server API](/docs/comments/operations/server-api) lists the operations and the browser transport.
- [Limits and errors](/docs/comments/operations/limits-and-errors) lists the limits and the error codes.
