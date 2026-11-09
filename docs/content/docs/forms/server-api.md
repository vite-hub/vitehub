---
title: Forms server API
description: Every option of defineForm(), the route of a form, the inbox, and guardRequest().
navigation.title: Server API
navigation.order: 4
icon: i-lucide-code
---

## `defineForm()`

`server/forms/<name>.ts` default-exports `defineForm()`. The name is lowercase letters, digits, and dashes. The route is `POST <base>api/_vitehub/forms/<name>`.

| Option | Default | Does |
| --- | --- | --- |
| `schema` | required | A Standard Schema of the fields. |
| `authorize` | anyone | `({ request, user }) => boolean`. The user comes from [Auth](/docs/auth) when the app has it. |
| `rateLimit` | `{ limit: 5, window: "1m" }` | A budget for each sender address. `false` turns it off. |
| `honeypot` | `"website"` | A field that bots fill. A filled field gets `202` and is not stored. `false` turns it off. |
| `maxBytes` | 64 KB | The largest body. |
| `origins` | the app's origin | Other origins that may post. |
| `store` | `true` | Keep messages in the Database. With `false`, set `notify` or `onSubmit`. |
| `notify.email` | none | `{ to, from?, subject?, replyTo? }`. `replyTo` names the field that holds the sender's email. |
| `onSubmit` | none | Runs after validation and before the message is stored. Return a `Response` to answer with it and store nothing. |

```ts [server/forms/report.ts] fragment
export default defineForm({
  schema: ReportSchema,
  // Reject a report about a page that does not exist
  onSubmit: async ({ data }) => (await pageExists(data.target)) ? undefined : new Response('Not found', { status: 404 }),
})
```

## The request

The route takes JSON, URL-encoded, or multipart bodies. Two fields are not form data:

- `_page`: the app path of the form. Default: the `Referer`, when it is on your origin.
- `_anchor`: `{ selector, exact, prefix, suffix }`, the sentence that the sender selected. It is the text anchor of [Comments](/docs/comments), so `anchorRange()` finds the sentence again.

| Answer | When |
| --- | --- |
| `201 { id }` | The message is stored, or sent with `store: false`. |
| `202` | The honeypot is filled. |
| `303` | A browser form without JavaScript: back to the page with `?form=sent` or `?form=error`. |
| `400 { message, issues }` | The body does not match the schema. Each issue has `message` and `path`. |
| `401`, `403` | `authorize` refused, or another origin. |
| `413`, `415`, `429` | Too large, not a form body, or over the rate limit. |

The rate limit counts in each server process. On Cloudflare Workers, each isolate counts alone.

## The inbox

Each message is a row of `vitehub_form_submissions`: the form, the data as JSON, the page, the anchor, the user, a status (`open`, `done`, or `spam`), and the times. A change to a schema needs no migration.

The `forms.list`, `forms.get`, and `forms.mark` operations read and change it. The Console, `vitehub forms`, and MCP call them. Access to the Forms section of the Console decides who may.

In server code, `installedForms()` from `vite-hub/forms/runtime` returns the inbox. Each call returns `[error, data]`:

```ts [server/routes/open-messages.get.ts] fragment
import { installedForms } from 'vite-hub/forms/runtime'

export default {
  async fetch() {
    const [error, messages] = await installedForms()!.inbox.list({ form: 'contact', status: 'open' })
    if (error) throw error
    return Response.json(messages)
  },
}
```

## `guardRequest()`

`@vite-hub/forms/guard` exports the checks of the route for other public writes. It returns `[response]` when a check stops the request, else the fields:

```ts fragment
import { guardRequest } from '@vite-hub/forms/guard'

const [stopped, guarded] = await guardRequest(request, { key: 'votes', rateLimit: { limit: 10, window: '1h' } })
if (stopped) return stopped
guarded.body // the fields, without _page, _anchor, and the honeypot
```
