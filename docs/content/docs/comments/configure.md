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
| `comment` | Start threads, reply, and delete your own comments. |
| `resolve` | Resolve and reopen any thread, and delete any thread or comment. |

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

The server does not check a guest name or a guest id. Show them, but do not use them for access or notifications. A guest can pose as another guest, and so can delete that guest's comments.

## Comments in your own UI

The overlay and the Console show threads of the `pages` scope: the ones people pin on the app's pages. App code can also keep comments on its own records, such as a document, and show them in its own UI. Give those threads a scope of their own. The overlay, the Console, and [ViteHub MCP](/docs/development/mcp) never show or change them.

```ts [server/api/docs/[id]/comments.post.ts]
import { defineEventHandler, getRouterParam, readBody } from 'h3'
import { comments } from '../../../comments'
import { canComment, requireUser } from '../../../utils/docs'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = getRouterParam(event, 'id')!
  if (!await canComment(user, id)) throw new Error('You cannot comment on this document.')
  const { body, quote } = await readBody<{ body: string, quote: string }>(event)
  const [error, thread] = await comments.create({
    scope: `doc:${id}`,
    page: `/docs/${id}`,
    metadata: { kind: 'text', quote },
    body,
    author: { id: user.id, name: user.name },
  })
  if (error) throw error
  return thread
})
```

- `metadata` keeps what your UI needs, such as where the comment sits in the document: at most 50 keys with string, number, boolean, or `null` values.
- Threads are numbered 1, 2, 3, … in their scope. Deleting threads or a whole scope never reuses those numbers. `getByNumber('doc:42', 3)` finds "#3".
- `removeScope('doc:42')` deletes every thread of the document, for example when the document goes away.
- The runtime methods are trusted server API, so check access in your route. When you call `comments.can()`, `authorize` gets the `scope` too.

## Choose the Database

Comments adds three tables, `vitehub_comment_threads`, `vitehub_comments`, and `vitehub_comment_scope_counters`, to a Database at build time. Without the `database` option, it uses the Database named `default`, else the only Database. `vitehub({ database: true })` gives an app without a Database Definition a `default` Database. The [CMS preset](/docs/content/cms-preset) of Content adds one too.

To use another Database, give its name:

```ts [server/comments.ts]
export const comments = defineComments({
  database: 'team',
})
```

ViteHub reads the name from the file without running it, so write it as a string literal. The build fails with `DATABASE_INVALID_CONTRIBUTION_TARGET` when the named Database does not exist, or when the app has several Databases and none is named `default`. The tables use SQLite, so the Database must be SQLite, libSQL, or D1.

Run `vitehub db generate` and `vitehub db migrate` after you add `server/comments.ts` or change `database`. See [Apply migrations](/docs/database/configure#apply-migrations).

## Upgrade existing Comments

Fresh databases can apply the generated Comments schema directly. Existing databases need a data migration before the new unique index is created. Schema generation cannot infer this backfill.

1. Stop Comments writes while you migrate, including writes from older app instances. Back up the database.
2. Run `vitehub db generate --name comments_scopes`. Edit the new SQL migration in the Database's migrations directory before applying it. Keep the generated snapshot and journal.
3. If the migration adds `scope` and `number`, place this backfill **after both `ALTER TABLE` statements and before `CREATE UNIQUE INDEX vitehub_comment_threads_number`**. Keep Drizzle's `--> statement-breakpoint` separators. Skip this backfill if the database already has numbered threads; those numbers must not change.

```sql [scope-number-backfill.sql]
UPDATE `vitehub_comment_threads`
SET `number` = (
  SELECT count(*) FROM `vitehub_comment_threads` AS `earlier`
  WHERE `earlier`.`scope` = `vitehub_comment_threads`.`scope`
    AND (`earlier`.`created_at` < `vitehub_comment_threads`.`created_at`
      OR (`earlier`.`created_at` = `vitehub_comment_threads`.`created_at`
        AND `earlier`.`id` <= `vitehub_comment_threads`.`id`))
);
--> statement-breakpoint
```

4. The generated migration also creates `vitehub_comment_scope_counters`. After that table exists and thread numbers are filled, append this statement. This step also applies to apps that already have scoped, numbered threads and are adding the counter table.

```sql [scope-counter-backfill.sql]
INSERT INTO `vitehub_comment_scope_counters` (`scope`, `last_number`)
SELECT `scope`, max(`number`) FROM `vitehub_comment_threads` GROUP BY `scope`
ON CONFLICT (`scope`) DO UPDATE SET `last_number` = max(`last_number`, excluded.`last_number`);
--> statement-breakpoint
```

5. Run `vitehub db migrate --dry-run` to check the order, then `vitehub db migrate` against the app's Database before starting the new app version. Verify that every existing thread has a positive number and that `(scope, number)` is unique.

The counter survives thread deletion and `removeScope()`. Do not delete its rows when deleting application records. If an older scoped version already deleted its highest-numbered threads, their numbers cannot be recovered from the remaining rows. Before reopening writes, restore each affected counter to at least the highest number ever issued from your backup or audit history.

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

## Fix comments with an Agent

The Console serves [ViteHub MCP](/docs/development/mcp) at `/_vitehub/mcp`. An Agent that connects to it lists the open threads, reads the page context and source files of each one, then replies and resolves the thread after it changes the code. It acts with your Console access, and `authorize` applies to each call.

An app with its own MCP server can register the same tools: `commentsMcpTools(comments)` from `vite-hub/comments/runtime` returns them with a JSON Schema and a `call(input, { user })` function each.

Your server must authenticate `user` before calling a tool; pass `null` for an anonymous caller. Without an event, the tools use this user even when Comments defines `identify`. To use request-based Comments identity, pass `call(input, { user, event })` with the H3 request event. Then `identify` takes precedence; without `identify`, the session reader in `commentsMcpTools(comments, { session })` is used, or `user` when no reader is supplied.
