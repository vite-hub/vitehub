---
title: Comments limits and errors
description: Message, mention, attachment, metadata, list, and refresh limits for Comments, and the fix for each error code.
navigation.title: Limits and errors
navigation.order: 8
icon: i-lucide-circle-alert
---

## Handle errors

The [runtime methods](/docs/comments/server-api#runtime-methods) return `[error, data]`. When `error` is set, it has:

- `code`: the failure.
- `why`: what went wrong.
- `fix`: what to do.
- `docs`: a link to the code in [Comments diagnostics](/docs/comments/diagnostics).

```ts [server/api/threads/[id].get.ts] fragment
import { createError, defineEventHandler, getRouterParam } from 'h3'
import { comments } from '../../comments'

export default defineEventHandler(async (event) => {
  const [error, thread] = await comments.get(getRouterParam(event, 'id')!)
  if (error?.code === 'COMMENTS_NOT_FOUND') throw createError({ status: 404, message: error.why })
  if (error) throw error
  return thread
})
```

The [HTTP routes](/docs/comments/server-api#http-routes) return the same object as `{ error }`, with an HTTP status for each code. The overlay shows `why` and `fix` in a message.

Build errors throw when Vite reads the config. When the build cannot pick the Database for the Comments tables, it fails with [`DATABASE_INVALID_CONTRIBUTION_TARGET`](/docs/database/limits-and-errors#database_invalid_contribution_target). See [Choose the Database](/docs/comments/configure#choose-the-database).

## Limits

| Limit | Value |
| --- | --- |
| Message body | 10,000 characters of Markdown after trimming. Empty only with an attachment, or when the subject's `emptyBody` allows it |
| Mentions in one message | 20. Each is the id of a person the text names with `@` and `canMention` allows |
| `@` suggestions | 20 |
| Attachments in one message | 10 keys of up to 500 characters |
| Attachment file | 5 MB. `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/avif`, `application/pdf`, or `text/plain`. No SVG or HTML, because a browser runs their scripts |
| Thread `metadata` | 50 keys of up to 64 characters. Values are strings of up to 4,000 characters, numbers, booleans, or `null` |
| Thread `revision` | A whole number from 0 |
| Threads in one `list()` call | 200 by default, 500 at most |
| Threads in the Console section | The 500 with the newest activity |
| Page path | 1,024 characters, starting with `/` |
| Guest name | 64 characters |
| GitHub sign-in session | 7 days from sign-in |
| GitHub push access | Checked again every 5 minutes |
| GitHub App callback URLs | 10, so one App serves 10 sites |
| Content field address | 512 characters |
| Edited field value | 20,000 characters |
| Thread refresh without presence | On tab focus, and every 30 seconds while visible |
| Cursor updates | One every 80 ms per person |
| Presence rooms with `authority: 'memory'` | One process. See [Realtime limits](/docs/realtime/limits-and-errors#limits). |

## Runtime errors

### COMMENTS_NOT_INSTALLED

The Comments runtime has no Database yet. ViteHub installs it from `server/comments.ts` when the server starts. Call methods from a server route or Nitro plugin, not at import time. When the log shows `Comments has no Database`, turn one on with `vitehub({ database: true })`, or set `defineComments({ database })` to a Database name.

The `comments()` plugin always has a database, so it never returns this code. With no connection, the API returns `500`, and the log shows [`DATABASE_NOT_CONNECTED`](/docs/database/limits-and-errors#database_not_connected) with what it looked for. See [Choose the Database](/docs/comments/configure#choose-the-database).

### COMMENTS_NOT_FOUND

No thread or comment has the id, and deleted threads do not come back. Use an id from `comments.list()`. The HTTP API also returns this code, with status `404`, for an unknown route.

### COMMENTS_INVALID_INPUT

The input of `create()`, `reply()`, or an API request is not valid. `why` names the first issue, such as `body: The comment is empty.` Send a page path that starts with `/`, an anchor from the overlay, and a body and mentions within the [limits](#limits).

### COMMENTS_FORBIDDEN

The `authorize` policy of `defineComments()` denied the action. `why` names it: `read`, `write`, `resolve`, or `delete`. Sign in as a user the policy allows, or change `authorize` in `server/comments.ts`. See [Decide who can comment](/docs/comments/configure#decide-who-can-comment).

The API also returns it for a `POST` or `DELETE` from another origin. Behind a proxy that ends TLS, set `X-Forwarded-Proto` and `X-Forwarded-Host`. See [Proxies that end TLS](/docs/comments/hosts#proxies-that-end-tls).

### COMMENTS_POLICY_MISSING

`server/comments.ts` has no `authorize`, so a production build refused a person signed in with ViteHub Auth or `identify`. Without a policy, only GitHub users who can push to the repository, and, for comment operations, callers that the Console admits to its Comments section, get in. Pass `authorize` to `defineComments()`. The status is `403`, and the log shows `COMMENTS_R0006` once. See [Decide who can comment](/docs/comments/configure#decide-who-can-comment).

### COMMENTS_SIGN_IN_OFF

A request reached `/api/_vitehub/comments/auth/`, but the server has no GitHub OAuth client. Set `VITEHUB_GITHUB_CLIENT_ID` and `VITEHUB_GITHUB_CLIENT_SECRET` on the server. See [Sign in with GitHub](/docs/comments/configure#sign-in-with-github).

### COMMENTS_SIGN_IN_FAILED

GitHub sign-in could not start. Check that the client ID and secret belong to the same GitHub App. In production, `VITEHUB_SECRET` must be set, with at least 32 characters.

When GitHub returns an error, such as for a callback URL the App does not list, sign-in shows `/api/_vitehub/comments/auth/error`. Its `error` query names the cause. Add the site's callback URL to the App.

### COMMENTS_RESOLVED

The thread is resolved and takes no replies. Reopen it with `comments.reopen(id)` or the reopen button on the page, then reply.

## Content edit errors

### COMMENTS_CONTENT_MISSING

Edits in place need Content, but the app has no `server/content.ts` with document collections. Define collections with `defineContent()` there, mark rendered fields with `contentField()`, and restart the dev server.

### COMMENTS_FIELD_INVALID

The `data-content-field` value is not a Content field address, its collection or document is missing, or the document has no draft yet. Write the attribute with `contentField(collection, id, field)` from `vite-hub/content/client` to match a collection in `server/content.ts`. A singleton has no document until its first save, so save it once in the Console.

### COMMENTS_FIELD_NOT_EDITABLE

The field's draft value is not a string, so the page cannot edit it as text. Edit it in the Content section of the Console.

### COMMENTS_FIELD_FORBIDDEN

`content.can()` denied `write` on the document. Sign in as a user that the `authorize` policy of `defineContent()` lets write the collection. See [Content access](/docs/content/configure#access).

### COMMENTS_FIELD_CONFLICT

The document changed after the page read it, for example in the Console or another tab. Open the field again, then repeat the edit.

### COMMENTS_FIELD_LOCKED

Another person holds this document's edit lease in the Console. `why` names them. Wait until they close it. See [Editing together](/docs/content/editing-together).
