---
title: Forms in Vue
description: Draw a whole form from its schema with AutoForm, send your own native form with useFormAction(), or a Formisch form with useFormSubmit().
navigation.title: Vue
navigation.order: 8
icon: i-lucide-panels-top-left
---

`vite-hub/forms/vue` needs `vue` and `@formisch/vue`:

```bash [terminal]
pnpm add @formisch/vue
```

## `AutoForm`

`AutoForm` draws a form from a Valibot object schema:

| Schema | Control |
| --- | --- |
| `v.string()` | text input |
| `v.pipe(v.string(), v.email())` | email input |
| `v.pipe(v.string(), v.url())` | url input |
| a string named like `message`, or longer than 200 | textarea |
| `v.number()` | number input |
| `v.boolean()` | checkbox |
| `v.picklist()`, `v.enum()` | select |

`v.title()` sets the label, and `v.description()` the help text. An optional field is not required.

```vue [app/components/ContactForm.vue] fragment
<template>
  <AutoForm name="contact" :schema="ContactSchema" submit-label="Send message" @sent="id => track(id)">
    <template #sent>Thanks. I answer in a day.</template>
  </AutoForm>
</template>
```

| Prop | Default | What it does |
| --- | --- | --- |
| `name` | | The form: the file `server/forms/<name>.ts`. |
| `schema` | | The Valibot object schema, the same that the server uses. |
| `base` | `/` | The base path of the app, when it is not at the root. |
| `submit-label` | `Send` | The text of the button. |
| `sent-message` | `Thanks. Your message was sent.` | The text after a send. The `sent` slot replaces it. |
| `error-message` | `The message was not sent. Check the form and try again.` | The text after a post without JavaScript that the server refused. |
| `result` | | The `form` query of the page after a post without JavaScript, such as `contact.sent`. A result of another form is ignored. |
| `honeypot` | `website` | The honeypot field of `defineForm()`. `false` leaves it out. |
| `anchor` | | The selected sentence, sent as `_anchor`. |

The Console shows the text of a message from the first of these fields: `message`, `feedback`, `details`, `description`, `comment`, `body`, `text`, `notes`, `note`, or `workflow`. Give the long field of a form one of these names. `vitehub forms get` shows every field.

The form posts to its route also before the app loads, or without JavaScript. The server sends the browser back with `?form=<name>.sent` or `?form=<name>.error`, so two forms on one page keep their results apart. Pass that query as `result`, so a server-rendered page shows the result before JavaScript runs. Without `result`, `AutoForm` reads the query when it mounts, which needs JavaScript. It then removes the query, so a reload does not show the result again:

```vue [app/pages/contact.vue] fragment
<script setup lang="ts">
const route = useRoute()
// AutoForm keeps only `contact.sent` and `contact.error`.
const result = computed(() => typeof route.query.form === 'string' ? route.query.form : undefined)
</script>

<template>
  <AutoForm name="contact" :schema="ContactSchema" :result="result" />
</template>
```

It draws plain elements with `data-*` attributes, so the app owns the styles. Keep inputs at 16px, so iOS does not zoom on focus, and the button at least 44px high, so it is easy to tap:

```css fragment
[data-vitehub-form] [data-field] { display: grid; gap: 0.25rem; }
[data-vitehub-form] :is(input, select, textarea) { font-size: 1rem; }
[data-vitehub-form] button { min-height: 2.75rem; }
[data-vitehub-form] button[aria-busy] { opacity: 0.6; cursor: progress; }
[data-vitehub-form] [data-error] { color: crimson; }
```

## `useFormAction()`

For your own markup, use a native `<form>` and `useFormAction()`. It sends the controls of the form by their `name`, and the server decodes them to the types of the schema. A 400 puts the error of each field in `errors`, under the control's `name`, and moves focus to the first field with an error after it renders. A success resets the form. Nuxt imports it for you.

With [ui-sdk](https://ui-sdk.dev), a `Field` shows the error of its control. `:invalid` shows the server's error, and `clear()` removes it when the person edits the field, so the browser's own checks run again:

```vue [app/components/ContactForm.vue] fragment
<script setup lang="ts">
import { Field, FieldError, FieldLabel } from '@ui-sdk/vue/field'
import { Input } from '@ui-sdk/vue/input'
import { formRoute, useFormAction } from 'vite-hub/forms/vue'

const { submit, errors, sent, error, pending, clear } = useFormAction('contact')
</script>

<template>
  <!-- `method` and `action` post the form before the app loads, or without JavaScript -->
  <form method="post" :action="formRoute('contact')" @submit="submit">
    <Field name="email" :invalid="errors.email ? true : undefined">
      <FieldLabel>Email</FieldLabel>
      <Input type="email" required @value-change="clear('email')" />
      <FieldError v-if="errors.email" match>{{ errors.email }}</FieldError>
    </Field>
    <!-- The rate limit, a server failure, or a network error -->
    <p v-if="error && !Object.keys(errors).length" role="alert">{{ error.message }}</p>
    <button :aria-busy="pending || undefined">Send</button>
    <p role="status">{{ sent ? 'Thanks.' : '' }}</p>
  </form>
</template>
```

| Returns | What it is |
| --- | --- |
| `submit(event)` | The `submit` handler of the form. A second submit while it sends is ignored. |
| `errors` | The server error of each field, by `name`. |
| `sent` | The id of the stored message after a success. |
| `error` | The last failure. `error.message` is the message for the whole form. |
| `pending` | `true` while the form sends. |
| `clear(name?)` | Removes the error of one field, or of every field. |

`vite-hub/forms/vue` also loads `@formisch/vue` for `AutoForm`, so install it as above.

## `useFormSubmit()`

For your own markup, use Formisch and `useFormSubmit()`. It sends the input of the form, puts each server error under its field, and resets the form after a success. Nuxt imports it for you.

```vue [app/components/FeedbackForm.vue] fragment
<script setup lang="ts">
import { Field, Form, useForm } from '@formisch/vue'
import { useFormSubmit } from 'vite-hub/forms/vue'

const form = useForm({ schema: FeedbackSchema })
const { send, sent } = useFormSubmit('feedback', form)
</script>

<template>
  <Form :of="form" @submit="() => send()">
    <Field v-slot="field" :of="form" :path="['message']">
      <label for="feedback-message">Message</label>
      <textarea id="feedback-message" v-model="field.input" v-bind="field.props" :aria-invalid="field.errors ? 'true' : undefined" :aria-describedby="field.errors ? 'feedback-message-error' : undefined" />
      <!-- Formisch focuses the field before its error renders, so the error announces itself -->
      <p v-if="field.errors" id="feedback-message-error" role="alert">{{ field.errors[0] }}</p>
    </Field>
    <!-- The rate limit, a server failure, or a network error -->
    <p v-if="form.errors" role="alert">{{ form.errors[0] }}</p>
    <button>Send</button>
    <!-- Always in the page, so screen readers announce the text when it appears -->
    <p role="status">{{ sent ? 'Thanks.' : '' }}</p>
  </Form>
</template>
```

Without Vue, `submitForm(name, values)` from `vite-hub/forms/client` posts the values and returns `[error, data]`. `values` is an object, or the `FormData` of a form. `error.issues` holds the error of each field, and `fieldErrors(error)` gives them by field name.
