---
title: Add a contact form
description: Add a contact form to a ViteHub app, send a message, and read it in the Console.
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

You need a ViteHub app from [Installation](/docs/getting-started/installation). Install Forms and Valibot:

```bash [terminal]
pnpm add @vite-hub/forms valibot
```

## Write the form

Create `server/forms/contact.ts`. The file name is the form name.

```ts [server/forms/contact.ts] fragment
import * as v from 'valibot'
import { defineForm } from 'vite-hub/forms'

export default defineForm({
  schema: v.object({
    email: v.pipe(v.string(), v.email('Enter a valid email.')),
    message: v.pipe(v.string(), v.trim(), v.minLength(10, 'Tell me a little more.'), v.maxLength(5000)),
  }),
})
```

The folder `server/forms/` turns the Database on when you did not set `database`. Forms adds its table to the default Database. Write and apply the migration:

```bash [terminal]
vitehub db generate
vitehub db migrate
```

## Send a message

Start the dev server and send a message:

```bash [terminal]
curl -X POST http://localhost:5173/api/_vitehub/forms/contact \
  -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","message":"I want to build a shop."}'
```

The answer is `201` with the id of the message. A message that does not match the schema gets `400` with the error of each field:

```json
{ "message": "Check the form and try again.", "issues": [{ "message": "Enter a valid email.", "path": ["email"] }] }
```

## Read it

Open the Console and go to **Forms**. Or use the CLI:

```bash [terminal]
vitehub forms list
vitehub forms mark <id> done
```

## Get an email

Turn on [Email](/docs/email), then add `notify`. A reply goes to the address that the sender typed:

```ts [server/forms/contact.ts] fragment
export default defineForm({
  schema: ContactSchema,
  notify: { email: { to: 'you@example.com', replyTo: 'email' } },
})
```

The message is stored first. When the email fails, the message stays in the inbox and the server logs the error.

## Draw the form

In a Vue app, install `@formisch/vue` and draw the form from the same schema. Put the schema in `shared/` so the client and the server import it:

```vue [app/components/ContactForm.vue] fragment
<script setup lang="ts">
import { AutoForm } from 'vite-hub/forms/vue'
import { ContactSchema } from '#shared/schemas'
</script>

<template>
  <AutoForm name="contact" :schema="ContactSchema" />
</template>
```

See [Vue](/docs/forms/vue) to style it or to write your own markup.
