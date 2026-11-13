---
title: Forms
layout: landing
navigation.title: Overview
description: Let visitors write to you through a contact, feedback, or "report a problem" form, with a spam guard, validation, an inbox, and email.
navigation.order: 1
icon: i-lucide-inbox
---

::product-hero{tagline="Write the schema of a form. ViteHub checks each message, stores it, emails you, and shows it in the Console." hosts="Node, Docker, Cloudflare, Vercel, Netlify"}
  :hero-figure{name="forms"}
::

::code-tree
```ts [shared/schemas.ts] fragment
import * as v from 'valibot'

export const ContactSchema = v.object({
  email: v.pipe(v.string(), v.email()),
  message: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(5000)),
})
```

```ts [server/forms/contact.ts] fragment
import { defineForm } from 'vite-hub/forms'
import { ContactSchema } from '../../shared/schemas'

// One file is one form, at POST /api/_vitehub/forms/contact
export default defineForm({
  schema: ContactSchema,
  notify: { email: { to: 'you@example.com', replyTo: 'email' } },
})
```

```vue [app/components/ContactForm.vue] fragment
<script setup lang="ts">
import { AutoForm } from 'vite-hub/forms/vue'
import { ContactSchema } from '../../shared/schemas'
</script>

<!-- Labels, inputs, errors, and the honeypot from the same schema -->
<template>
  <AutoForm name="contact" :schema="ContactSchema" />
</template>
```

```bash [terminal]
# Read and close messages from the terminal, or in the Console
vitehub forms list --status open
vitehub forms mark 3f2c... done
```
::

## What you get

| Part | What it does |
| --- | --- |
| Guard | Accepts only `POST`, rejects a present `Origin` unless it is your origin or in `origins`, stops large bodies, answers a filled honeypot field with a fake success, and limits each address to 5 messages a minute. Requests without `Origin` may pass. |
| Validation | Checks each message with your Standard Schema: Valibot, Zod, or ArkType. A bad message gets the error of each field. |
| Inbox | Keeps each message in the `vitehub_form_submissions` table, with its page and the sentence the sender selected. The Console lists them. |
| Notify | Emails you each message through [Email](/docs/email), with a reply that goes to the sender. |
| `onSubmit` | Runs your code before the message is stored, for example to post it to a support tool. |

## Forms or Comments

Does the sender talk with other readers on the page? Then use [Comments](/docs/comments). Does the message go one way to you and stay private? Then use Forms.

## Next

- [Get started](/docs/forms/get-started): add a contact form to a ViteHub app.
- [Server API](/docs/forms/server-api): every option of `defineForm()` and the inbox.
- [Vue](/docs/forms/vue): `AutoForm` and `useFormSubmit()`.
