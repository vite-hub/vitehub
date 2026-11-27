---
title: Add a contact form
description: Add a contact form to a ViteHub app, send a message, and read it in the Console.
layout: tutorial
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

You need a ViteHub app from [Installation](/docs/getting-started/installation). Run the commands from its root.

::tutorial-step{title="Install Forms"}
## Install Forms

Install Forms, Valibot, and the Database packages that store messages:

```bash [commands/install]
pnpm add @vite-hub/forms valibot @vite-hub/database drizzle-orm@1.0.0-rc.6
pnpm add -D drizzle-kit@1.0.0-rc.6
```

::

::tutorial-step{title="Write the form"}
## Write the form

Write the schema in `shared/schemas.ts`, so the server and, later, the page use the same one:

```ts [shared/schemas.ts] fragment
import * as v from 'valibot'

export const ContactSchema = v.object({
  email: v.pipe(v.string(), v.email('Enter a valid email.')),
  message: v.pipe(v.string(), v.trim(), v.minLength(10, 'Tell me a little more.'), v.maxLength(5000)),
})
```

Create `server/forms/contact.ts`. The filename becomes the form name.

```ts [server/forms/contact.ts] fragment
import { defineForm } from 'vite-hub/forms'
import { ContactSchema } from '../../shared/schemas'

export default defineForm({ schema: ContactSchema })
```

The `server/forms/` folder turns on the default Database when you did not set `database`. Forms adds its table to the default Database. With `database: false`, the development server keeps messages in memory, and a build fails with `FORMS_B0002` unless each form sets `store: false`. Generate and run the migration:

```bash [commands/migrate]
vitehub database generate
vitehub database migrate
```

::

::tutorial-step{title="Send a message"}
## Send a message

Start the dev server with `pnpm dev`, as in [Installation](/docs/getting-started/installation), then send a message from a second terminal:

```bash [commands/send]
curl -X POST http://localhost:3000/_vitehub/forms/contact \
  -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","message":"I want to build a shop."}'
```

A valid message gets `201` with the message ID. A message that does not match the schema gets `400` with the error of each field:

```json [output/invalid.json]
{ "message": "Check the form and try again.", "issues": [{ "message": "Enter a valid email.", "path": ["email"] }] }
```

::

::tutorial-step{title="Read it"}
## Read it

Open the Console and go to **Forms**, or use the CLI:

```bash [commands/list]
vitehub forms list
```

```txt [output/list.txt]
ID                                    FORM     STATUS  SENT AT                   TEXT
72838d15-a93e-481a-9ede-af489f6fff06  contact  open    2026-11-09T09:21:43.285Z  I want to build a shop.
```

Mark a message `done` when you answered it, or `spam`. `vitehub forms get <id>` shows the full message, and `--json` prints JSON:

```bash [commands/mark]
vitehub forms mark 72838d15-a93e-481a-9ede-af489f6fff06 done
```

::

::tutorial-step{title="Get an email"}
## Get an email

Enable [Email](/docs/email) and add `notify`. Replies go to the sender's address:

```ts [notify/server/forms/contact.ts] fragment
import { defineForm } from 'vite-hub/forms'
import { ContactSchema } from '../../shared/schemas'

export default defineForm({
  schema: ContactSchema,
  notify: { email: { to: 'you@example.com', replyTo: 'email' } },
})
```

Forms stores the message first. If the email fails, the message stays in the inbox and the server logs the error.

::

::tutorial-step{title="Draw the form"}
## Draw the form

In a Vue app, render the form from the same schema:

```vue [app/components/ContactForm.vue] fragment
<script setup lang="ts">
import { AutoForm } from 'vite-hub/forms/vue'
import { ContactSchema } from '../../shared/schemas'
</script>

<template>
  <AutoForm name="contact" :schema="ContactSchema" />
</template>
```

See [Vue](/docs/forms/vue) to style it or write custom markup.

::
