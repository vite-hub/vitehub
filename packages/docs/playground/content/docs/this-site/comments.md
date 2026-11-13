---
title: Leave a comment
description: Pin a comment to a part of a page, reply to it, and resolve it in the Console or from your agent.
navigation.order: 3
icon: i-lucide-message-square-plus
---

Signed-in users with a CMS role can comment on every page of this site. The comments are in the `content` Database, a D1 database next to the CMS history. Users and sessions are in the `users` Database.

::steps{level="3"}
### Turn on comments

Open the pill and select **Comments**. The pill gets the **Comment** and **Edit** modes, and a window lists the open threads of the page.

### Pin a comment

Select **Comment** in the pill, or press `C`, and select a part of the page, such as a heading or a code block. Write the comment and press `Ctrl+Enter` (`⌘ Enter` on a Mac). Other editors see the pin on the same element.

### Resolve it

Open the thread and select **Resolve**. The Comments section of the Console, at [`/_vitehub/comments`](/_vitehub/comments), lists every thread, open and resolved.
::

::tip
An agent with the Console MCP server reads the open comments with `comments_list_threads` and answers them with `comments_reply`. Ask it: "Read the open comments on /docs/guides/ci and fix them."
::
