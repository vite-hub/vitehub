# @vite-hub/forms

`@vite-hub/forms` lets site visitors write to the site owner: contact, feedback, "report a problem here". You write the schema of a form. Forms checks every submission, stores it, and tells you about it.

## The server

```ts fragment
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
2. Answers 403 when the `Origin` is not the app's origin or one of `origins`. Behind a proxy that ends TLS, the app's origin comes from `X-Forwarded-Proto` and `X-Forwarded-Host`. `origins` is for HTML forms on other sites: the route sends no CORS headers, so `fetch` works only from the app's own origin.
3. Reads at most `maxBytes`, 64 KB by default. It answers 413 above the limit, before `identify` or `authorize` can read the body.
4. Checks `authorize` with the user that `identify` returns. It answers 401 or 403. A refused request uses no rate budget.
5. Asks `rateLimit` with the key `form:<name>`. The default policy is 5 a minute. It answers 429 with `retry-after`.
6. Answers 202 and stores nothing when the honeypot field, `website` by default, is filled.
7. Validates the other fields with `schema`. It answers 400 with `{ message, issues: [{ message, path }] }`. Schema output must be JSON data: plain objects, arrays, strings, finite numbers, booleans, or `null`. Transforms that return `Date`, `Map`, `bigint`, `undefined`, or cycles get 400 before `onSubmit`, email, or storage. Convert these values in the schema, for example a date to an ISO string. Accepted output uses its JSON representation in every step.
8. Runs `onSubmit`. When it returns a Response, the request gets that Response and nothing is stored.
9. Stores the submission, then sends the email. A stored submission is safe, so an email failure is only logged.
10. Answers 201 with `{ id }`.

A browser form without JavaScript, which sends form data and accepts HTML, gets a 303 back to its page with `?form=<name>.sent` or `?form=<name>.error`, such as `?form=contact.sent`.

For Valibot object schemas, form data is decoded before validation: number inputs and numeric select choices become numbers, checked boolean fields become `true`, and omitted boolean fields become `false`. Empty number inputs and select placeholders become `undefined`. JSON keeps its input types.

Two fields are not form data: `_page`, the app path of the form (default: the `Referer`), and `_anchor`, the part of the page that the sender pointed at: `{ selector, exact, prefix, suffix }`, the same text quote as a Comments text anchor, so `resolveAnchor({ kind: "text", ...anchor })` from `@vite-hub/comments/client` finds the sentence again.

## Services

`handleFormRequest()` reads, writes, and sends only through the services that you pass. A framework integration passes them for you.

| Service | Does | Without it |
| --- | --- | --- |
| `store` | Keeps submissions. `createDrizzleFormsStore(db)` from `@vite-hub/forms/database`, or `createMemoryFormsStore()`. | The request gets 503 before `onSubmit` or email, unless the form sets `store: false`. With `store: false`, set `onSubmit` or `notify` to handle submissions. |
| `email` | Sends `notify.email`. | A stored submission is kept; without `store` the request gets 503. |
| `rateLimit` | Decides each request. | No rate limit. |
| `identify` | Returns the signed-in user. | Every sender is anonymous. |
| `waitUntil` | Sends the email after the response. | The response waits for the email. |
| `log` | Reports failures that do not change the response. | They are silent. |

## The Database

`@vite-hub/forms/database` has the `vitehub_form_submissions` table as `formsSchema`, the same table as SQL in `formsTables`, and `createDrizzleFormsStore(db)`. Each row keeps the form name, the validated data as JSON, the page, the anchor, the user, a status (`open`, `done`, or `spam`), and the times. A change to a form schema needs no migration.

`createFormsInbox(store)` lists submissions and changes their status. Each call returns `[error, data]`.

## The client

```ts fragment
import { submitForm } from "@vite-hub/forms/client"

const [error, sent] = await submitForm("contact", { email, message })
if (error) showFieldErrors(error.issues)
```

`submitForm()` posts JSON to `/api/_vitehub/forms/<name>` with the current page. Pass `url` for another route, `base` for an app base, and `anchor` for a selected sentence.

## Vue

`@vite-hub/forms/vue` needs `vue` and `@formisch/vue`. `AutoForm` draws a whole form from the Valibot object schema of the form: a label and a control for each field, the help text of `v.description()`, the honeypot, the error of each field, and the message after it is sent. It draws plain elements with `data-*` attributes, so the app styles them.

```vue fragment
<script setup lang="ts">
import { AutoForm } from "@vite-hub/forms/vue"
import { ContactSchema } from "#shared/schemas"
</script>

<template>
  <AutoForm name="contact" :schema="ContactSchema" />
</template>
```

A string becomes a text, email, or url input, or a textarea when it is long or named like `message`. A number becomes a number input, a boolean a checkbox, and a picklist a select. `v.title()` sets the label.

For your own markup, use Formisch and `useFormSubmit()`. It sends the values and puts each server issue under its field:

```vue fragment
<script setup lang="ts">
import { Field, Form, useForm } from "@formisch/vue"
import { useFormSubmit } from "@vite-hub/forms/vue"

const form = useForm({ schema: ContactSchema })
const { send, sent } = useFormSubmit("contact", form)
</script>

<template>
  <Form :of="form" @submit="() => send()">
    <Field v-slot="field" :of="form" :path="['message']">
      <textarea v-model="field.input" v-bind="field.props" />
      <p v-if="field.errors">{{ field.errors[0] }}</p>
    </Field>
    <button>Send</button>
    <p v-if="sent">Thanks.</p>
  </Form>
</template>
```
