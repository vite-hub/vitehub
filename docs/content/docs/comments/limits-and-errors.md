---
title: Comments limits and errors
description: Comment, mention, list, and refresh limits for Comments, and the fix for each error code.
navigation.title: Limits and errors
navigation.order: 8
icon: i-lucide-circle-alert
---

## Handle errors

The [runtime methods](/docs/comments/server-api#runtime-methods) return `[error, data]`. When `error` is set, `error.code` names the failure, `error.why` tells what went wrong, `error.fix` tells what to do, and `error.docs` links to the code on this page.

```ts [server/api/threads/[id].get.ts]
import { createError, defineEventHandler, getRouterParam } from 'h3'
import { comments } from '../../comments'

export default defineEventHandler(async (event) => {
  const [error, thread] = await comments.get(getRouterParam(event, 'id')!)
  if (error?.code === 'COMMENTS_NOT_FOUND') throw createError({ status: 404, message: error.why })
  if (error) throw error
  return thread
})
```

The HTTP routes answer with the same error object as `{ error }`, and an HTTP status for each code. See [HTTP routes](/docs/comments/server-api#http-routes). The overlay shows `why` and `fix` in a message.

Build errors throw when Vite reads the config. When the build cannot choose the Database for the Comments tables, it fails with [`DATABASE_INVALID_CONTRIBUTION_TARGET`](/docs/database/limits-and-errors#database_invalid_contribution_target). See [Choose the Database](/docs/comments/configure#choose-the-database).

## Limits

| Limit | Value |
| --- | --- |
| Comment body | 1 to 4,000 characters of plain text, after trimming |
| Mentions in one comment | 20 |
| `@` suggestions | 20 |
| Threads in one `list()` call | 200 by default, 500 at most |
| Threads in the Console section | The 500 with the newest activity |
| Page path | 1,024 characters, starting with `/` |
| Guest name | 64 characters |
| GitHub sign-in session | 7 days from sign-in |
| GitHub push access | Checked again every 5 minutes |
| GitHub App callback URLs | 10, so 10 sites can sign people in with one App |
| Content field address | 512 characters |
| Edited field value | 20,000 characters |
| Thread refresh without presence | On tab focus, and every 30 seconds while the tab is visible |
| Cursor updates | One every 80 ms for each person |
| Presence rooms with `authority: 'memory'` | One process. See [Realtime limits](/docs/realtime/limits-and-errors#limits). |

## Runtime errors

### COMMENTS_NOT_INSTALLED

The Comments runtime has no Database yet. ViteHub installs it from `server/comments.ts` when the server starts. Call the method from a server route or a Nitro plugin, not at import time. When the server log shows `Comments has no Database`, turn on a Database with `vitehub({ database: true })`, or set `defineComments({ database })` to a Database name.

The `comments()` plugin always has a database, so it does not return this code. When it finds no connection, the API answers `500`, and the server log shows [`DATABASE_NOT_CONNECTED`](/docs/database/limits-and-errors#database_not_connected) with what it looked for. See [Choose the Database](/docs/comments/configure#choose-the-database).

### COMMENTS_NOT_FOUND

No thread or comment has the id. A deleted thread does not come back. List the threads with `comments.list()` and use one of their ids. The HTTP API also returns this code, with status `404`, for a route that does not exist.

### COMMENTS_INVALID_INPUT

The input of `create()` or `reply()`, or the body of an API request, is not valid. `why` names the first issue, such as `body: The comment is empty.` Send a page path that starts with `/`, an anchor from the overlay, and a body of 1 to 4,000 characters, with at most 20 mentions.

### COMMENTS_FORBIDDEN

The `authorize` policy of `defineComments()` denied the action for this user. `why` names the action: `read`, `comment`, or `resolve`. Sign in as a user that the policy allows, or change `authorize` in `server/comments.ts`. See [Decide who can comment](/docs/comments/configure#decide-who-can-comment).

The API also returns this code for a `POST` or `DELETE` from another origin. Behind a proxy that ends TLS, set `X-Forwarded-Proto` and `X-Forwarded-Host`. See [Proxies that end TLS](/docs/comments/hosts#proxies-that-end-tls).

### COMMENTS_SIGN_IN_OFF

A request reached `/api/_vitehub/comments/auth/` on a server without the GitHub OAuth client. Set `VITEHUB_GITHUB_CLIENT_ID` and `VITEHUB_GITHUB_CLIENT_SECRET` on the server. See [Sign in with GitHub](/docs/comments/configure#sign-in-with-github).

### COMMENTS_SIGN_IN_FAILED

GitHub sign-in could not start. Check that the client ID and secret belong to the same GitHub App, and that `VITEHUB_SECRET` is set and at least 32 characters in production.

When GitHub sends the person back with an error, such as a callback URL that the App does not list, the sign-in shows an error page at `/api/_vitehub/comments/auth/error`. Its `error` query names the cause. Add the site's callback URL to the App.

### COMMENTS_RESOLVED

The thread is resolved, so it takes no new replies. Reopen it with `comments.reopen(id)`, or with the reopen button on the page, then reply.

## Content edit errors

### COMMENTS_CONTENT_MISSING

Edits in place need Content, and the app has no `server/content.ts` with document collections. Define collections with `defineContent()` in `server/content.ts`, mark rendered fields with `contentField()`, and restart the dev server.

### COMMENTS_FIELD_INVALID

The `data-content-field` value is not a Content field address, or its collection or document does not exist, or the document has no draft yet. Write the attribute with `contentField(collection, id, field)` from `vite-hub/content/client`, so the address matches a collection of `server/content.ts`. A singleton has no document until its first save. Save it once in the Console.

### COMMENTS_FIELD_NOT_EDITABLE

The draft value of the field is not a string, so the page cannot edit it as text. Edit the field in the Console Content editor.

### COMMENTS_FIELD_FORBIDDEN

`content.can()` denied `write` on the document for this user. Sign in as a user that the `authorize` policy of `defineContent()` lets write the collection. See [Content access](/docs/content/configure#access).

### COMMENTS_FIELD_CONFLICT

The document changed after the page read it, for example in the Console or in another tab. Open the field again to read the current draft, then repeat the edit.

### COMMENTS_FIELD_LOCKED

Another person holds the edit lease of this document in the Console. `why` names them. Wait until they close the document, or edit it together with them in the Console. See [Editing together](/docs/content/editing-together).
