---
title: Send ViteHub events
description: Send a form submit, a finished upload, a Content publish, or an Auth event to a webhook from the callback of each primitive.
navigation.title: Send events
navigation.order: 8
icon: i-lucide-send
---

Webhooks has no event bus. You call `sendWebhook()` in the callback that each primitive already has. The `event` option is a label that the receiver gets in `x-vitehub-event`.

The examples on this page send to one webhook:

```ts [server/webhooks/team.ts]
import { defineWebhook } from 'vite-hub/webhooks'

export default defineWebhook({
  url: 'TEAM_WEBHOOK_URL',
  secret: 'TEAM_WEBHOOK_SECRET',
})
```

The webhook has no `debounce`, so the receiver gets each event. A debounce keeps only the last body of the window. Use it when the receiver needs the last state, as in [Comments to a T3 Code thread](/docs/webhooks/t3-code-thread), not when each event matters.

## Comments: a new comment

See [Comments to a T3 Code thread](/docs/webhooks/t3-code-thread). `onComment` gets `{ thread, message, mentions }`.

## Forms: a submit

`onSubmit` runs after validation and before Forms stores the message:

```ts [server/forms/contact.ts]
import * as v from 'valibot'
import { defineForm } from 'vite-hub/forms'
import { sendWebhook } from 'vite-hub/webhooks'

export default defineForm({
  schema: v.object({ email: v.pipe(v.string(), v.email()), message: v.string() }),
  onSubmit: async (submission) => {
    const [error] = await sendWebhook('team', { form: submission.form, page: submission.page, data: submission.data }, { event: 'forms.submit' })
    if (error) console.error(error)
  },
})
```

Return nothing, so Forms stores the message and answers as usual. See [Forms server API](/docs/forms/server-api#defineform).

## Blob: a finished upload

`onCompleted` of `handleUpload()` runs after each file is stored:

```ts [server/api/files.post.ts]
import { defineEventHandler } from 'h3'
import { blob } from 'vite-hub/blob'
import { sendWebhook } from 'vite-hub/webhooks'

export default defineEventHandler(async (event) => {
  // Authorize the request here. The route decides who may upload.
  const [error, result] = await blob.handleUpload(event, {
    onCompleted: async (object) => {
      const [sendError] = await sendWebhook('team', { pathname: object.pathname, size: object.size, contentType: object.contentType }, { event: 'blob.upload' })
      if (sendError) console.error(sendError)
    },
  })
  if (error) throw error
  return result
})
```

A client can send `complete` of a [direct upload](/docs/blob/server-api#direct-uploads) again, so the receiver can get the same file twice.

## Content: a publish

Content has no publish callback. Send after `content.publish()` returns a new revision:

```ts [server/content.ts]
import { defineContent } from 'vite-hub/content'
import { documents } from 'vite-hub/content/collections'
import { z } from 'zod'

export default defineContent({
  collections: {
    posts: documents({ path: 'posts/**/*.md', fields: { title: z.string() } }),
  },
})
```

```ts [server/utils/publish-posts.ts]
import { sendWebhook } from 'vite-hub/webhooks'
import content from '../content'

/** Publishes the drafts, then tells the team which documents changed. */
export async function publishPosts() {
  const published = await content.publish({ message: 'Publish posts' })
  if (!published.revision || published.pending) return published
  const documents = published.documents.map(document => ({ collection: document.collection, id: document.id }))
  const [error] = await sendWebhook('team', { revision: published.revision.id, documents }, { event: 'content.publish' })
  if (error) console.error(error)
  return published
}
```

With `publish: 'pr'`, `pending` is `true` until the pull request merges, so the code above sends nothing then.

## Auth: an Auth event

`events.onEvent` gets each event that the [event log](/docs/auth/events) records. Send only the types that the receiver needs:

```ts [server/databases/auth/index.ts]
import { defineDatabase } from 'vite-hub/database'

export default defineDatabase({ name: 'auth', schema: {} })
```

```ts [server/auth.ts]
import { createDatabaseAuthEventStore, defineAuth } from 'vite-hub/auth'
import { authDatabase } from 'vite-hub/auth/database'
import { useDatabase } from 'vite-hub/database'
import { sendWebhook } from 'vite-hub/webhooks'

export default defineAuth(() => ({
  database: authDatabase('auth'),
  emailAndPassword: { enabled: true },
  events: {
    store: createDatabaseAuthEventStore({ db: useDatabase('auth').db }),
    onEvent: async (event) => {
      if (event.type !== 'user.signed_up' && event.type !== 'user.role_changed') return
      const [error] = await sendWebhook('team', event, { event: `auth.${event.type}` })
      if (error) console.error(error)
    },
  },
}))
```

Webhooks keeps its table in the Default Database. Here, Auth uses a second Database named `auth`, so the app also needs the Default Database.
