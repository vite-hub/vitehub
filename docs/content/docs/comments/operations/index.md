---
title: Comments operations
navigation.title: Operations overview
description: Store the comment threads of your running app, check who may read and write them, and read them from the Console, the CLI, and agents.
navigation.order: 20
icon: i-lucide-message-square
---

Comments let your team pin numbered notes on your running app and reply to them. This package is the server half: tables, access rules, and the `comments.*` [operations](/docs/console/operations). The browser half is [UI comments](/docs/ui/comments).

```ts [server/comments.ts]
import { defineComments } from 'vite-hub/comments'

export default defineComments({
  authorize: ({ user }) => Boolean(user),
})
```

Add this file, and ViteHub:

- Adds the `vitehub_comment_threads`, `vitehub_comment_messages`, and `vitehub_comment_counters` tables to your Database.
- Adds the operations `comments.list`, `get`, `create`, `reply`, `edit`, `delete`, `resolve`, `reopen`, and `users`. The Console, `vitehub comments list`, the [MCP endpoint](/docs/console/mcp), and the browser client all call this code.
- Adds a **Comments** section to the [Console](/docs/console). It lists the threads you may read, with filter chips and a page link. A row opens the thread in a side panel, where you reply, resolve, reopen, and `@`-mention people.

Only the people that `authorize` allows can see comments. Without a policy, people that the Console admits to its Comments section may read and write. On the dev server, anonymous people may too.

## Next steps

- [Get started](/docs/comments/operations/get-started): add comments to an app.
- [Configure](/docs/comments/operations/configure): `authorize`, subjects, mentions, and the Database.
- [Server API](/docs/comments/operations/server-api): the operations and the browser transport.
- [Limits and errors](/docs/comments/operations/limits-and-errors): limits and error codes.
