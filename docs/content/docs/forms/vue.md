---
title: Forms in Vue
description: Draw a whole form from its schema with AutoForm, or send your own Formisch form with useFormSubmit().
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
| `honeypot` | `website` | The honeypot field of `defineForm()`. `false` leaves it out. |
| `anchor` | | The selected sentence, sent as `_anchor`. |

The form posts to its route also before the app loads, or without JavaScript. The server sends the browser back with `?form=sent` or `?form=error`, and `AutoForm` shows the result in its status region.

It draws plain elements with `data-*` attributes, so the app owns the styles. Keep inputs at 16px, so iOS does not zoom on focus, and the button at least 44px high, so it is easy to tap:

```css fragment
[data-vitehub-form] [data-field] { display: grid; gap: 0.25rem; }
[data-vitehub-form] :is(input, select, textarea) { font-size: 1rem; }
[data-vitehub-form] button { min-height: 2.75rem; }
[data-vitehub-form] [data-error] { color: crimson; }
```

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
      <textarea v-model="field.input" v-bind="field.props" />
      <p v-if="field.errors">{{ field.errors[0] }}</p>
    </Field>
    <button>Send</button>
    <p v-if="sent">Thanks.</p>
  </Form>
</template>
```

Without Vue, `submitForm(name, values)` from `vite-hub/forms/client` posts the values and returns `[error, data]`. `error.issues` holds the error of each field.
