---
title: Comments configuration
description: Decide who can comment, let guests in, choose the Database, mention and notify people, turn comment mode on and off, and mark Content fields for edits in place.
navigation.title: Configure
navigation.order: 3
icon: i-lucide-sliders-horizontal
---

All options go to `defineComments()` in `server/comments.ts`. Every option is optional. The [Server API](/docs/comments/server-api#definecomments-options) lists them in one table.

## Decide who can comment

`authorize` gets the user and the action. Return `false` to deny.

```ts [server/comments.ts]
import { defineComments } from 'vite-hub/comments'

export const comments = defineComments({
  authorize: ({ user, action, thread }) => {
    if (!user) return false
    if (action === 'resolve') return user.role === 'editor' || thread?.createdBy.id === user.id
    return true
  },
})
```

| Action | Allows |
| --- | --- |
| `read` | See pins and threads, join the presence room of the page, and get `@` suggestions. |
| `comment` | Start threads and reply. Signed-in authors can also delete their own comments. |
| `resolve` | Resolve and reopen any thread. Signed-in users can also delete any thread or comment. |

`thread` is the thread that the action changes. It is `undefined` for reads and for new threads.

Without `authorize`, signed-in users may do everything and anonymous requests may do nothing. The user comes from `identify`, else from the [Console](#comment-as-the-console-team) when the app has one, else from the ViteHub Auth session when the app has [Auth](/docs/auth).

Every route of the Comments API checks the policy again. A user that `read` denies gets `403` with [`COMMENTS_FORBIDDEN`](/docs/comments/limits-and-errors#comments_forbidden), and the overlay does not open. Write requests must also come from a page of the same origin.

The [runtime methods](/docs/comments/server-api#runtime-methods), such as `comments.create()`, are trusted server API. They do not call `authorize`. Call `comments.can()` first when a route acts for a user.

### Comment as the Console team

When the app has the [Console](/docs/development/console), the people of Comments are the people that the Console lets use its **Comments** section. Visitors and app users without Console access get `null`, so the toolbar never opens for them. `authorize` still runs after that check, with the Console user.

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ auth: true, console: { auth: 'app', authorize: './server/console-authorize.ts' } })],
})
```

See [Console sign-in](/docs/development/console) for `console-authorize.ts`. To limit Comments to some Console users, return the sections from it, such as `{ sections: ['comments', 'content'] }`.

When a person opens the Console, it calls `GET /api/_vitehub/comments/session`. That sets the comment mode cookie, so the app's pages show the Comments toolbar from then on. Nobody else gets the cookie, so their pages have no Comments script.

| Console sign-in | Comment author |
| --- | --- |
| `auth: 'app'` or a Console Auth config | The signed-in Console user |
| `provider: 'cloudflare-access'` | The email that Cloudflare Access checked |
| `auth: false`, or the dev server without sign-in | A guest. The overlay asks for a display name. |

### Use your own login

When the app does not use ViteHub Auth, return the user from `identify`. Return `null` for an anonymous request.

```ts [server/comments.ts]
import { getCookie } from 'h3'
import { defineComments } from 'vite-hub/comments'
import { findSession } from './utils/session'

export const comments = defineComments({
  identify: async ({ event }) => {
    const session = await findSession(getCookie(event, 'sid'))
    return session ? { id: session.userId, name: session.name, image: session.avatar } : null
  },
})
```

The user must have a string `id`. Comments shows `name`, else `email`, else "Someone", and `image` when it is a string. `identify` also sets the person that the presence room shows, so a signed-in person cannot show under another name.

### Let guests comment

Return `true` for `user: null` to let people without an account comment. The overlay asks for a display name once and keeps it in the browser's `localStorage`. Their comments show the name with "(guest)".

```ts [server/comments.ts]
export const comments = defineComments({
  // Guests may read and comment. Only editors resolve.
  authorize: ({ user, action }) => action !== 'resolve' || user?.role === 'editor',
})
```

The server does not verify a guest name or ID. They are display data, never proof of ownership. Guests cannot delete comments or threads, even when the policy allows `resolve`. Sign in to delete your own comments, or ask a signed-in moderator with `resolve` permission.

## Choose the Database

Comments adds two tables, `vitehub_comment_threads` and `vitehub_comments`, to a Database at build time. Without the `database` option, it uses the Database named `default`, else the only Database. `vitehub({ database: true })` gives an app without a Database Definition a `default` Database. The [CMS preset](/docs/content/cms-preset) of Content adds one too.

To use another Database, give its name:

```ts [server/comments.ts]
export const comments = defineComments({
  database: 'team',
})
```

ViteHub reads the name from the file without running it, so write it as a string literal. The build fails with `DATABASE_INVALID_CONTRIBUTION_TARGET` when the named Database does not exist, or when the app has several Databases and none is named `default`. The tables use SQLite, so the Database must be SQLite, libSQL, or D1.

Run `vitehub db generate` and `vitehub db migrate` after you add `server/comments.ts` or change `database`. See [Apply migrations](/docs/database/configure#apply-migrations).

## Mention people

Type `@` in a comment to mention someone. Without `people`, the list shows the authors of earlier comments. Return your own list to suggest the team:

```ts [server/comments.ts]
import { defineComments } from 'vite-hub/comments'
import { team } from './utils/team'

export const comments = defineComments({
  people: ({ query }) => team
    .filter(person => person.name.toLowerCase().includes(query.toLowerCase()))
    .map(person => ({ id: person.id, name: person.name })),
})
```

`query` is the text after `@`, and can be empty. Comments filters the result by name again and returns at most 20 people. A comment keeps at most 20 mentions.

## Notify mentioned people

`onComment` runs after each new thread and each reply saves. Compose it with [Email](/docs/email) to tell people that someone mentioned them:

```ts [server/comments.ts]
import { defineComments } from 'vite-hub/comments'
import { email } from 'vite-hub/email/server'
import { team } from './utils/team'

export const comments = defineComments({
  people: () => team.map(person => ({ id: person.id, name: person.name })),
  onComment: async ({ thread, comment, mentions }) => {
    for (const mention of mentions) {
      // Mentions come from the browser. Look each person up in your own list.
      const person = team.find(member => member.id === mention.id)
      if (!person) continue
      const [error] = await email.send({
        from: 'comments@example.com',
        to: person.email,
        subject: `${comment.author.name} mentioned you on ${thread.page}`,
        text: `${comment.body}\n\nhttps://example.com${thread.page}?comments#comment-${thread.id}`,
      })
      if (error) console.error(error.why)
    }
  },
})
```

The link `<page>?comments#comment-<thread id>` opens the page in comment mode with the thread open.

The API waits for `onComment` before it answers the browser. Keep it short, or send the work to a [Queue](/docs/queue). Comments logs an error that `onComment` throws and still returns the saved comment.

## Turn comment mode on and off

Comment mode starts when a person opens the [Console](#comment-as-the-console-team), or on any page with the `?comments` query, such as `https://example.com/pricing?comments`. The overlay asks the server for the session. When `authorize` allows `read`, the server sets the `vitehub-comments` cookie for 30 days, so every other page of the site opens in comment mode too. When it denies `read`, the server clears the cookie. The cookie is only a hint. Every API request checks access again.

The close button in the toolbar ends comment mode. It clears the cookie and removes the query.

| Key | Action |
| --- | --- |
| <kbd>C</kbd> | Turn **Comment** on or off. While it is on, a click anywhere starts a thread. |
| <kbd>E</kbd> | Turn **Edit** on or off, when the app has Content. |
| <kbd>Esc</kbd> | Close the open thread, or turn **Comment** and **Edit** off. |
| <kbd>⌘</kbd> <kbd>Enter</kbd> | Send the comment. |

Without the hint, the server returns each page unchanged: no script, no request, and no extra cache variant. With the hint, it adds one `<script type="module">` before `</body>` of HTML responses and sends them with `cache-control: private, no-store`. Paths under `/_vitehub` and `/api` never get the overlay.

- Nitro 3 apps get the script from the server response. Nuxt 4 apps get it through Nitro's `render:html` hook.
- A single-page app whose `index.html` Vite builds gets a short inline check instead. The check loads the overlay in the browser when it finds the query or the cookie.
- A page that a CDN serves from its cache or as a static file never reaches the server, so it does not get the overlay. Use the query on a page that the server renders.

The overlay is a custom element with its own shadow root. Your CSS does not change it, and its CSS does not change your page.

## Mark Content fields

Edit mode lets people change Content text on the page. Each editable element needs the address of its field. `contentField()` from `vite-hub/content/client` writes it as a `data-content-field` attribute. In Vue, spread it with `v-bind`:

```vue [src/pages/Customers.vue]
<script setup lang="ts">
import { contentField } from 'vite-hub/content/client'

defineProps<{
  about: { hero: { title: string } }
  customers: { id: string, data: { name: string } }[]
}>()
</script>

<template>
  <!-- A singleton: collection and field -->
  <h1 v-bind="contentField('about', 'hero.title')">{{ about.hero.title }}</h1>
  <ul>
    <!-- A document collection: collection, document id, and field -->
    <li v-for="customer in customers" :key="customer.id">
      <span v-bind="contentField('customers', customer.id, 'name')">{{ customer.data.name }}</span>
    </li>
  </ul>
</template>
```

| Collection | Call | Attribute value |
| --- | --- | --- |
| `singleton()` | `contentField('about', 'hero.title')` | `about#hero.title` |
| `documents()` | `contentField('customers', 'acme', 'name')` | `customers:acme#name` |

The field is a dot path into the document fields, such as `hero.title` or `cards.0.title`. Without Vue, write the attribute yourself, or build its value with `formatContentField({ collection, id, field })`.

- Put the attribute on the element that holds only the field text. An edit replaces the text of the element, so other elements inside it go away until the page renders again.
- A field is editable on the page when its draft value is a string. For other fields and for the Markdown body, the overlay links to the Console editor.
- An edit needs `comment` from Comments and `write` from the [Content `authorize`](/docs/content/configure#access) policy for that document. Guests can edit only when the Content policy allows `user: null`.
- <kbd>Enter</kbd> or leaving the field saves. <kbd>Esc</kbd> cancels.

A save writes the whole document to `draft` with the message `Edit <field> on the page`. If the document changed after the page read it, the save fails with [`COMMENTS_FIELD_CONFLICT`](/docs/comments/limits-and-errors#comments_field_conflict). If someone holds the [edit lease](/docs/content/editing-together) in the Console, it fails with [`COMMENTS_FIELD_LOCKED`](/docs/comments/limits-and-errors#comments_field_locked).

In edit mode, the overlay marks the fields you edited with **Draft**. After a reload, the page shows the published text again and the mark is gone. Publish in the [Console](/docs/content/console), where review and approval rules apply. Comment mode does not turn on [draft preview](/docs/content/preview).

A pin on an element with a Content field, or inside one, stores the field address. The pin stays with that text when the layout changes.

## Triage in the Console

The Console has a Comments section at `/_vitehub/comments`. It lists the 500 threads with the newest activity: page, first comment, author, replies, status, and last update. A thread's **Open on page** field is its `?comments#comment-<id>` link. Reply and resolve on the page, where the context is.

`vitehub inspect` lists the Comments route, the `comments` Realtime Definition when presence runs, and the tables in the Database.
