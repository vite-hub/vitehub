---
title: Comments configuration
description: Decide who can comment, sign people in with GitHub, let guests in, choose where threads go, mention and notify people, turn comment mode on and off, and mark Content fields for edits in place.
navigation.title: Configure
navigation.order: 4
icon: i-lucide-sliders-horizontal
---

Comments works without configuration. Add `server/comments.ts` when you want to change who may comment, notify people, or post to pull requests. It exports `comments` from `defineComments()`, and every option is optional. The [Server API](/docs/comments/server-api#definecomments-options) lists them in one table.

```ts [server/comments.ts]
// With the comments() plugin. In a ViteHub app, import from 'vite-hub/comments'.
import { defineComments } from '@vite-hub/comments'

export const comments = defineComments({
  authorize: ({ user }) => user?.github?.login !== 'a-bot',
})
```

The `comments()` plugin has one option of its own, [`database`](#choose-the-database). Without `server/comments.ts`, it uses `defineComments()` with no options.

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

Without `authorize`, the person decides:

| Person | Without `authorize` |
| --- | --- |
| Signed in [with GitHub](#sign-in-with-github) | May do everything when they can push to the repository of the build. Nothing otherwise. |
| Signed in another way: `identify`, the Console, or ViteHub Auth | May do everything. |
| Not signed in, on the dev server | May do everything, as a guest under a name they type. |
| Not signed in, in a production build | Nothing. |

The user comes from `identify`, else from the [Console](#comment-as-the-console-team) when the app has one, else from the ViteHub Auth session when the app has [Auth](/docs/auth), else from [Sign in with GitHub](#sign-in-with-github).

Every route of the Comments API checks the policy again. A user that `read` denies gets `403` with [`COMMENTS_FORBIDDEN`](/docs/comments/limits-and-errors#comments_forbidden), and the overlay does not open. Write requests must also come from a page of the same origin.

The [runtime methods](/docs/comments/server-api#runtime-methods), such as `comments.create()`, are trusted server API. They do not call `authorize`. Call `comments.can()` first when a route acts for a user.

### Sign in with GitHub

An app without its own sign-in signs people in with a GitHub App. It is on when both are true:

- The app has neither ViteHub Auth nor the Console, and `server/comments.ts` has no `identify`.
- The server has `VITEHUB_GITHUB_CLIENT_ID` and `VITEHUB_GITHUB_CLIENT_SECRET`.

A person who may not read sees **Sign in with GitHub** in the overlay. GitHub sends them back to the same page, in comment mode. Signed in, they see their picture in the toolbar. Selecting it signs them out.

[Get started](/docs/comments/get-started#let-your-team-sign-in-with-github) shows how to create the GitHub App. One App can do both jobs: when an App already [posts to pull requests](#post-comments-to-the-pull-request), add the callback URL to it, and copy its Client ID and a client secret. Its App ID and private key keep posting. In short:

| GitHub App setting | Value |
| --- | --- |
| Callback URL | `https://<your site>/api/_vitehub/comments/auth/callback/github`, one for each site. A GitHub App takes up to 10. |
| Expire user authorization tokens | Off. When it is on, GitHub's token lasts 8 hours, and Comments cannot store a renewed one in the cookie, so people sign in again. |
| Webhook | Off |
| Permissions | None more than the default. Add **Pull requests: Read and write** to [post as each person](#post-as-each-person). |
| Installed on | The app's repository |

| Server variable | Value |
| --- | --- |
| `VITEHUB_GITHUB_CLIENT_ID` | The App's **Client ID**. |
| `VITEHUB_GITHUB_CLIENT_SECRET` | A client secret of the App. |
| `VITEHUB_SECRET` | The [app secret](/docs/env/app-secret), at least 32 characters and the same on every server. Comments derives the key of its session cookies from it, for Comments alone. The dev server works without it. |

On Cloudflare, Comments reads the variables from the Worker's bindings too.

**Who gets in.** Comments asks GitHub whether the person can push to the repository of the build, and asks again every 5 minutes. It finds the repository the way [pull request posting](#post-comments-to-the-pull-request) does: `GITHUB_REPOSITORY`, the Vercel Git variables, Netlify's `REPOSITORY_URL`, else the GitHub `origin` remote of the checkout when you build. Set `GITHUB_REPOSITORY=owner/name` for the build when it finds none. Without a repository, nobody signed in with GitHub gets in, and the overlay says why.

**What `authorize` gets.** The user has the GitHub account in `user.github`, so you can let in more or fewer people than the default:

```ts [server/comments.ts]
export const comments = defineComments({
  authorize: ({ user, action }) => {
    // Everyone who signs in may read. People who can push may comment and resolve.
    if (user?.github) return action === 'read' || user.github.write
    return false
  },
})
```

| Field | Value |
| --- | --- |
| `user.id` | Stable for the GitHub account, on every sign-in and server. |
| `user.name`, `user.image` | The GitHub name, else the login, and the avatar. |
| `user.github.login` | The GitHub username. |
| `user.github.repository` | The repository of the build, `owner/name`, when Comments knows it. |
| `user.github.write` | Whether they can push to it. |

**The session.** There is no user table and no session table. The session, and the person's GitHub token, are in encrypted cookies whose names start with `vitehub_comments`. They last 7 days from sign-in. You cannot end one session from the server. Signing out removes the cookies from that browser only. To sign everyone out, change `VITEHUB_SECRET`.

**Preview URLs.** GitHub sends people back only to a callback URL that the App lists. A host that gives each deployment its own URL, such as a Vercel or Netlify preview, cannot sign people in on those URLs. Use a stable URL for previews, such as a branch domain, and list it. Or use [your own login](#use-your-own-login).

An OAuth App works too, for public repositories only. Comments asks it for the `read:user` and `user:email` scopes alone, so GitHub hides private repositories from it.

Comments needs no email permission. When GitHub hides a person's email, Comments uses their GitHub noreply address, `<id>+<login>@users.noreply.github.com`.

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
- Threads are numbered 1, 2, 3, … in their scope. `getByNumber('doc:42', 3)` finds "#3".
- `removeScope('doc:42')` deletes every thread of the document, for example when the document goes away.
- The runtime methods are trusted server API, so check access in your route. When you call `comments.can()`, `authorize` gets the `scope` too.

## Choose the Database

Where the threads go depends on the setup. `comments()` keeps them in a SQLite file or in Cloudflare D1, and creates its tables itself, so you install no driver and run no migration. A [ViteHub app](/docs/comments/with-vite-hub) keeps them in a ViteHub Database.

| `database` of `comments()` | Where threads go |
| --- | --- |
| Not set, `vite dev` | `.vitehub/data/comments.sqlite` in the project. The plugin adds a `.gitignore` next to it. |
| Not set, production build | Nowhere. The server log says `Comments has no database in this build`, and the API answers [`COMMENTS_NOT_INSTALLED`](/docs/comments/limits-and-errors#comments_not_installed). |
| `'file:./data/comments.sqlite'`, or a plain path | That file, relative to the directory that the server starts in. The directory is created. |
| `{ d1: 'COMMENTS' }` | The D1 database of the `COMMENTS` binding in `wrangler.jsonc`. `vite dev` uses `.vitehub/data/comments.sqlite` instead. |

### A SQLite file

Comments opens the file with Node's built-in `node:sqlite` and creates its tables when the server starts.

```ts [vite.config.ts]
export default defineConfig({
  plugins: [comments({ database: 'file:./data/comments.sqlite' })],
})
```

Keep the file on a disk that survives deploys and restarts, such as a Docker volume, and run one server process with it. On Cloudflare Workers, use [D1](#cloudflare-d1). Vercel and Netlify have no such disk, so they need a ViteHub Database.

### Cloudflare D1

On Cloudflare Workers, Comments keeps threads in a [D1](https://developers.cloudflare.com/d1/) database. It reads the database from a binding of the Worker, and creates its tables on the first request, so there is no migration to run.

1. Create the database, and add its binding to `wrangler.jsonc`:

   ```bash [commands/d1]
   pnpm add -D wrangler
   pnpm wrangler d1 create comments --binding COMMENTS --update-config
   ```

   Wrangler adds the binding to `d1_databases`:

   ```jsonc [wrangler.jsonc]
   {
     "name": "my-site",
     "compatibility_date": "2026-10-01",
     "d1_databases": [
       { "binding": "COMMENTS", "database_name": "comments", "database_id": "<the id that Wrangler printed>" }
     ]
   }
   ```

2. Give `comments()` the binding name:

   ```ts [vite.config.ts]
   export default defineConfig({
     plugins: [comments({ database: { d1: 'COMMENTS' } })],
   })
   ```

3. Build for Workers and deploy. Nitro copies the bindings of `wrangler.jsonc` into the build, and points Wrangler at it:

   ```bash [commands/deploy]
   NITRO_PRESET=cloudflare_module pnpm vite build
   pnpm wrangler deploy
   ```

4. To [sign in with GitHub](#sign-in-with-github), add the variables as Worker secrets, such as `pnpm wrangler secret put VITEHUB_GITHUB_CLIENT_ID`.

`vite dev` keeps the threads in `.vitehub/data/comments.sqlite`, because the dev server has no binding. To try D1 on your computer, build, then run `pnpm wrangler dev`. Wrangler runs the Worker with a local D1 database in `.wrangler/state`.

Set the preset with `NITRO_PRESET` when you build, not in `vite.config.ts`. With the Cloudflare preset, `vite dev` runs the server in `workerd`, where Comments does not start yet.

When the Worker has no binding of that name, the API answers `500`, and the Worker log says `Comments has no D1 binding "COMMENTS"`. Check the binding name in `wrangler.jsonc`, and see it with `pnpm wrangler tail`.

### A ViteHub Database

In a [ViteHub app](/docs/comments/with-vite-hub), Comments adds two tables, `vitehub_comment_threads` and `vitehub_comments`, to a Database at build time. Without the `database` option, it uses the Database named `default`, else the only Database. `vitehub({ database: true })` gives an app without a Database Definition a `default` Database. The [CMS preset](/docs/content/cms-preset) of Content adds one too.

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

## Post comments to the pull request

On a preview deployment, `forge` posts each thread to the pull request that the preview builds. The people who review the code see what the people who tried the preview said, and an Agent that works on the pull request reads it there.

```ts [server/comments.ts]
import { defineComments } from 'vite-hub/comments'

export const comments = defineComments({
  forge: { provider: 'github' },
})
```

| On the page | On the pull request |
| --- | --- |
| The first thread | A summary comment with every thread: number, first sentence, page, author, and state. Comments edits it when a thread changes. |
| A thread | A comment with the text, the page with the thread open, the element, and what the person saw: route, components, source files, viewport, browser, and build. |
| A reply | A comment of its own. |
| An edit | Edits that comment. |
| Resolve, reopen | Hides the thread's comment as resolved, or shows it again. |
| Delete | Deletes the comments. The summary goes with the last thread. |

Comments finds the pull request from the build that served the page, as `context.build` keeps it:

- The repository is `GITHUB_REPOSITORY`, the Vercel Git variables, Netlify's `REPOSITORY_URL`, else the GitHub `origin` remote of the checkout.
- The pull request is the one the host names (Vercel, Netlify, GitHub Actions), else the open pull request whose head is the build's branch.

Threads without a pull request, such as on production, stay off GitHub. To choose yourself, return the number from `pullRequest(thread)`, and set `repository`.

It posts with a GitHub App installation: set `VITEHUB_GITHUB_APP_ID` and `VITEHUB_GITHUB_PRIVATE_KEY`, and give the App write access to pull requests or issues. `VITEHUB_GITHUB_TOKEN` works too, and posts as that token's user. These are the names that the [Forge capability](/docs/agents/capabilities/forge) reads.

### Post as each person

The App posts a comment with its author's name: "**Ada** commented on the preview:". A person who [signed in with GitHub](#sign-in-with-github) posts as themselves, with no option: Comments uses the token of their sign-in. Give the sign-in App **Pull requests: Read and write**, or their comments go through the posting App. GitHub then shows their account, with the App's badge.

With another sign-in, return their GitHub token from `token(author)`, such as the user token of their GitHub sign-in with [Auth](/docs/auth). `token` replaces the sign-in token.

```ts [server/comments.ts]
import { defineComments } from 'vite-hub/comments'
import { githubToken } from './utils/github'

export const comments = defineComments({
  forge: {
    provider: 'github',
    token: author => githubToken(author.id),
  },
})
```

Guests always post through the App. When a token fails, the App posts the comment instead. Comments keeps the sign-in token in memory for 10 minutes after the person's last request, because the post runs after the request ends. It forgets it when they sign out.

### When GitHub refuses

A change answers before GitHub does. Each thread has `forge` with `state`: `posted`, `pending`, or `failed` with the `error`, and the `url` of its comment. The next change of the thread tries again, and so does `comments.sync(threadId)`.

Comments keeps the GitHub ids in the `vitehub_comment_forge` table, so run `vitehub db generate` and `vitehub db migrate` after you add `forge`. On Cloudflare, the API routes keep the Worker running until GitHub answers. When server code changes threads, pass `comments.flush()` to `waitUntil`.

App mentions and thread numbers stay plain text on GitHub: `@ada` does not notify a GitHub user, and `#3` does not link issue 3.

## Triage in the Console

The Console has a Comments section at `/_vitehub/comments`. It lists the 500 threads with the newest activity: page, first comment, author, replies, status, and last update. A thread's **Open on page** field is its `?comments#comment-<id>` link. Reply and resolve on the page, where the context is.

`vitehub inspect` lists the Comments route, the `comments` Realtime Definition when presence runs, and the tables in the Database.

## Fix comments with an Agent

The Console serves [ViteHub MCP](/docs/development/mcp) at `/_vitehub/mcp`. An Agent that connects to it lists the open threads, reads the page context and source files of each one, then replies and resolves the thread after it changes the code. It acts with your Console access, and `authorize` applies to each call.

An app with its own MCP server can register the same tools: `commentsMcpTools(comments)` from `vite-hub/comments/runtime` returns them with a JSON Schema and a `call(input, { user })` function each.
