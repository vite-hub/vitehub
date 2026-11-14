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

Install Forms, Valibot, and the Database packages that store the messages:

```bash [commands/install]
pnpm add @vite-hub/forms valibot @vite-hub/database drizzle-orm
pnpm add -D drizzle-kit
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

Create `server/forms/contact.ts`. The file name is the form name.

```ts [server/forms/contact.ts] fragment
import { defineForm } from 'vite-hub/forms'
import { ContactSchema } from '../../shared/schemas'

export default defineForm({ schema: ContactSchema })
```

The folder `server/forms/` turns the Database on when you did not set `database`. Forms adds its table to the default Database. With `database: false`, a development server keeps messages in memory, and a build fails with `FORMS_B0002` unless each form sets `store: false`. Write and apply the migration:

```bash [commands/migrate]
vitehub database generate
vitehub database migrate
```

::

::tutorial-step{title="Send a message"}
## Send a message

Start the dev server with `pnpm dev`, as in [Installation](/docs/getting-started/installation), then send a message from a second terminal:

```bash [commands/send]
curl -X POST http://localhost:3000/api/_vitehub/forms/contact \
  -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","message":"I want to build a shop."}'
```

The answer is `201` with the id of the message. A message that does not match the schema gets `400` with the error of each field:

```json [output/invalid.json]
{ "message": "Check the form and try again.", "issues": [{ "message": "Enter a valid email.", "path": ["email"] }] }
```

::

::tutorial-step{title="Read it"}
## Read it

Open the Console and go to **Forms**. Or use the CLI:

```bash [commands/list]
vitehub forms list
```

```txt [output/list.txt]
ID                                    FORM     STATUS  SENT AT                   TEXT
72838d15-a93e-481a-9ede-af489f6fff06  contact  open    2026-11-09T09:21:43.285Z  I want to build a shop.
```

Mark it done when you answered it, or spam. `vitehub forms get <id>` shows the whole message, and `--json` prints JSON:

```bash [commands/mark]
vitehub forms mark 72838d15-a93e-481a-9ede-af489f6fff06 done
```

::

::tutorial-step{title="Get an email"}
## Get an email

Turn on [Email](/docs/email), then add `notify`. A reply goes to the address that the sender typed:

```ts [notify/server/forms/contact.ts] fragment
import { defineForm } from 'vite-hub/forms'
import { ContactSchema } from '../../shared/schemas'

export default defineForm({
  schema: ContactSchema,
  notify: { email: { to: 'you@example.com', replyTo: 'email' } },
})
```

The message is stored first. When the email fails, the message stays in the inbox and the server logs the error.

::

::tutorial-step{title="Draw the form"}
## Draw the form

In a Vue app, install `@formisch/vue` and draw the form from the same schema:

```vue [app/components/ContactForm.vue] fragment
<script setup lang="ts">
import { AutoForm } from 'vite-hub/forms/vue'
import { ContactSchema } from '../../shared/schemas'
</script>

<template>
  <AutoForm name="contact" :schema="ContactSchema" />
</template>
```

See [Vue](/docs/forms/vue) to style it or to write your own markup.

::
