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
| `honeypot` | `"website"` | A field that bots fill. A filled field gets a fake success and is not stored. `false` turns it off. |
| `maxBytes` | 64 KB | The largest body. |
| `origins` | the app's origin | Other origins that may post an HTML form. The route sends no CORS headers, so `fetch` works only from the app's origin. Behind a TLS proxy, the app's origin comes from `X-Forwarded-Proto` and `X-Forwarded-Host`. |
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
- `_anchor`: `{ selector, exact, prefix, suffix }`, the sentence that the sender selected. It is the text anchor of [Comments](/docs/comments), so `resolveAnchor({ kind: "text", ...anchor })` of `@vite-hub/comments/client` finds the sentence again.

| Answer | When |
| --- | --- |
| `201 { id }` | A JSON response: the message is stored, or sent with `store: false`. |
| `202` | A JSON response: the honeypot is filled. |
| `303` | A URL-encoded or multipart form that accepts HTML: back to the page with `?form=<name>.sent` after success or a filled honeypot, or `?form=<name>.error` after a size, access, rate-limit, parsing, or validation failure. |
| `400 { message, issues }` | A JSON response: the body does not match the schema. Each issue has `message` and `path`. |
| `401`, `403` | A JSON response: `authorize` refused. A rejected `Origin` always gets `403` JSON. Requests without `Origin` may pass. |
| `413`, `415`, `429` | A JSON response: too large, not a form body, or over the rate limit. An unsupported content type always gets `415` JSON. |

The method, content type, and origin checks run before HTML redirects are enabled. A response returned by `onSubmit` is sent as it is.

The rate limit counts in each server process. On Cloudflare Workers, each isolate counts alone.

## The inbox

Each message is a row of `vitehub_form_submissions`: the form, the data as JSON, the page, the anchor, the user, a status (`open`, `done`, or `spam`), and the times. A change to a schema needs no migration.

The `forms.list`, `forms.get`, and `forms.mark` operations read and change it. The Console, `vitehub forms`, and MCP call them. Access to the Forms section of the Console decides who may.

In server code, `installedForms()` from `vite-hub/forms/runtime` returns the inbox. Each call returns `[error, data]`. The inbox checks no access, so do not return it from a public route:

```ts [server/utils/open-messages.ts] fragment
import { installedForms } from 'vite-hub/forms/runtime'

/** The open messages of the contact form, such as for a daily digest. */
export async function openMessages() {
  const [error, messages] = await installedForms()!.inbox.list({ form: 'contact', status: 'open' })
  if (error) throw error
  return messages
}
```

## `guardRequest()`

`@vite-hub/forms/guard` exports the checks of the route for other public writes. It returns `[response]` when a check stops the request, else the fields:

```ts fragment
import { guardRequest } from '@vite-hub/forms/guard'

const [stopped, guarded] = await guardRequest(request, {
  key: 'votes',
  rateLimit: { limit: 10, window: '1h' },
  // Runs before the rate limit and the body, with a copy of the request. Return a status and a message to stop it.
  check: async request => await signedIn(request) ? undefined : { status: 401, message: 'Sign in to vote.' },
}, { rateLimit: countRequests })
if (stopped) return stopped
guarded.body // the fields, without _page, _anchor, and the honeypot
```

The guard counts requests only with the `rateLimit` service of its third argument: `(request, key, policy) => Promise<{ allowed, retryAfter? }>`. Without it, `rateLimit` has no effect. The Forms route passes its own.
