# @vite-hub/forms

`@vite-hub/forms` lets site visitors write to the site owner: contact, feedback, "report a problem here". You write the schema of a form. Forms checks every submission, stores it, and tells you about it.

## The server

```ts
import * as v from "valibot"
import { defineForm, handleFormRequest } from "@vite-hub/forms"

export const contact = defineForm({
  // Any Standard Schema: Valibot, Zod, ArkType.
  schema: v.object({
    email: v.pipe(v.string(), v.email()),
    message: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(5000)),
  }),
  notify: { email: { to: "you@example.com", replyTo: "email" } },
})

export default {
  fetch: (request: Request) => handleFormRequest("contact", contact, request, { store, email, rateLimit }),
}
```

For each `POST`, `handleFormRequest()`:

1. Accepts JSON, URL-encoded, and multipart bodies. It answers 415 for other bodies.
2. Answers 403 when the `Origin` is not the app's origin or one of `origins`.
3. Checks `authorize` with the user that `identify` returns. It answers 401 or 403.
4. Asks `rateLimit` with the key `form:<name>`. The default policy is 5 a minute. It answers 429 with `retry-after`.
5. Answers 413 above `maxBytes`, 64 KB by default.
6. Answers 202 and stores nothing when the honeypot field, `website` by default, is filled.
7. Validates the other fields with `schema`. It answers 400 with `{ message, issues: [{ message, path }] }`.
8. Runs `onSubmit`. When it returns a Response, the request gets that Response and nothing is stored.
9. Stores the submission, then sends the email. A stored submission is safe, so an email failure is only logged.
10. Answers 201 with `{ id }`.

A browser form without JavaScript, which sends form data and accepts HTML, gets a 303 back to its page with `?form=sent` or `?form=error`.

Two fields are not form data: `_page`, the app path of the form (default: the `Referer`), and `_anchor`, the part of the page that the sender pointed at: `{ selector, exact, prefix, suffix }`, the same text quote as a Comments text anchor, so `anchorRange()` from `@vite-hub/comments/client` finds the sentence again.

## Services

`handleFormRequest()` reads, writes, and sends only through the services that you pass. A framework integration passes them for you.

| Service | Does | Without it |
| --- | --- | --- |
| `store` | Keeps submissions. `createDrizzleFormsStore(db)` from `@vite-hub/forms/database`, or `createMemoryFormsStore()`. | Nothing is stored. |
| `email` | Sends `notify.email`. | A stored submission is kept; without `store` the request gets 503. |
| `rateLimit` | Decides each request. | No rate limit. |
| `identify` | Returns the signed-in user. | Every sender is anonymous. |
| `waitUntil` | Sends the email after the response. | The response waits for the email. |
| `log` | Reports failures that do not change the response. | They are silent. |

## The Database

`@vite-hub/forms/database` has the `vitehub_form_submissions` table as `formsSchema`, the same table as SQL in `formsTables`, and `createDrizzleFormsStore(db)`. Each row keeps the form name, the validated data as JSON, the page, the anchor, the user, a status (`open`, `done`, or `spam`), and the times. A change to a form schema needs no migration.

`createFormsInbox(store)` lists submissions and changes their status. Each call returns `[error, data]`.

## The client

```ts
import { submitForm } from "@vite-hub/forms/client"

const [error, sent] = await submitForm("contact", { email, message })
if (error) showFieldErrors(error.issues)
```

`submitForm()` posts JSON to `/api/_vitehub/forms/<name>` with the current page. Pass `url` for another route, `base` for an app base, and `anchor` for a selected sentence.
