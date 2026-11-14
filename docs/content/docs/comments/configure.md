---
title: Comments configuration
description: "Decide who can comment, sign people in with GitHub, choose where threads go, notify mentions, attach files, and mark Content fields for edits in place."
navigation.title: Configure
navigation.order: 4
icon: i-lucide-sliders-horizontal
---

Comments works without configuration. Add `server/comments.ts` to change who may comment, notify people, or post to pull requests. It exports `comments` from `defineComments()`. All options are optional and listed in the [Server API](/docs/comments/server-api#definecomments-options).

```ts [server/comments.ts]
// With the comments() plugin. In a ViteHub app, import from 'vite-hub/comments'.
import { defineComments } from '@vite-hub/comments'

export const comments = defineComments({
  authorize: ({ user }) => user?.github?.login !== 'a-bot',
})
```

The `comments()` plugin has one option of its own, [`database`](#choose-the-database). Without `server/comments.ts`, it uses `defineComments()` with no options.

## Turn Comments on in a ViteHub app

In a ViteHub app, `server/comments.ts` turns Comments on. `vitehub({ comments: true })` does it without the file, with `defineComments()` and no options. The [Console](/docs/development/console) alone does not. Comments turns the Database on when `database` is unset, and adds the Comments section to the Console. An object also turns Comments on, and sets the Database, SQL dialect, or `overlay: false`:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: 'node',
    console: true,
    comments: { database: 'team' },
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      host: 'node',
      console: true,
      comments: { database: 'team' },
    }),
    nitro(),
  ],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      host: 'node',
      console: true,
      comments: { database: 'team' },
    }),
  ],
})
```
:::
::

Do not add the `comments()` plugin next to `vitehub()`. The dev server and the build fail with `COMMENTS_B0003`.

`comments: false` turns Comments off. These combinations fail the build:

- `comments: false` with a `server/comments.ts` fails with `VITE_HUB_B0019`. Remove one of them.
- Comments on with `database: false` fails with `VITE_HUB_B0018`, because threads live in the Database. Remove `database: false` or set `comments: false`.

[Docs sites](/docs/docs-site/configure#comments) on `vite-hub/nuxt` have Comments on by default. Turn it off with `docs: { comments: false }`.

## Decide who can comment

`authorize` gets the user, the action, and the `thread`, or the `subject` of a new thread. Return `true` to allow. Any other value denies.

```ts [server/comments.ts]
import { defineComments } from 'vite-hub/comments'

export const comments = defineComments({
  authorize: ({ user, action, thread }) => {
    if (!user) return false
    if (action === 'resolve') return user.role === 'editor' || thread?.author.id === user.id
    return true
  },
})
```

| Action | Allows |
| --- | --- |
| `read` | See pins and threads, join the page's presence room, and get `@` suggestions. |
| `write` | Start threads, reply, and attach files. Signed-in authors can also edit and delete their own messages. |
| `resolve` | Resolve and reopen any thread. |
| `delete` | Signed-in users can delete any thread or message. |

`thread` is `undefined` for lists and new threads, which have `subject`. The same policy runs for the overlay, the [comment operations](/docs/comments/operations/configure), the Console, MCP, and Agents.

Without `authorize`, a production build lets in only people that a sign-in already checked. Anyone may be able to sign up to an app, so ViteHub Auth and `identify` users need a policy:

| Person | Without `authorize` |
| --- | --- |
| Signed in [with GitHub](#sign-in-with-github) | Everything when they can push to the build's repository. Otherwise nothing, also on the dev server. |
| A caller of comment operations through the [Console](#comments-through-the-console), the CLI, or MCP, with the Comments section, in an app without `identify` | Everything the Console grant allows. The overlay on pages does not use this check. |
| Signed in with a `comments-` role, which [Site access](#roles-from-site-access) gives | What the roles allow. |
| Signed in with ViteHub Auth or `identify`, in a production build | Nothing. The API returns [`COMMENTS_POLICY_MISSING`](/docs/comments/limits-and-errors#comments_policy_missing), and the log shows `COMMENTS_R0006` once. |
| Anyone on the dev server | Everything. People not signed in comment as guests under a typed name. |
| Not signed in, in a production build | Nothing. |

The dev server follows Vite's serve/build command, never the server's `NODE_ENV`. `defaultPolicy(user, { development, console }, action)` from `vite-hub/comments` is this table as a function, for your policy to fall back to.

On pages, the user comes from the first of: `identify`, the ViteHub [Auth](/docs/auth) session, the [Site access](#roles-from-site-access) cookie of an app without Auth, or [Sign in with GitHub](#sign-in-with-github). Comment operations through the Console, the CLI, and MCP use `identify`, else the [Console caller](#comments-through-the-console).

Every Comments API route checks the policy again. A user that `read` denies gets `403` with [`COMMENTS_FORBIDDEN`](/docs/comments/limits-and-errors#comments_forbidden), and no overlay. Writes must come from a same-origin page.

The [runtime methods](/docs/comments/server-api#runtime-methods), such as `comments.create()`, are trusted server API and do not call `authorize`. When a route acts for a user, call `comments.can()` first. The methods still check mentions, `metadata`, and limits.

### Sign in with GitHub

An app without its own sign-in can sign people in with a GitHub App. This is on when:

- The app has neither ViteHub Auth nor the Console, and `server/comments.ts` has no `identify`.
- The server has `VITEHUB_GITHUB_CLIENT_ID` and `VITEHUB_GITHUB_CLIENT_SECRET`.

A person who may not read sees **Sign in with GitHub** in the overlay. GitHub returns them to the page in comment mode, with their picture in the toolbar. Selecting it signs them out.

[Get started](/docs/comments/get-started#let-your-team-sign-in-with-github) shows how to create the GitHub App. An App that already [posts to pull requests](#post-comments-to-the-pull-request) can also sign people in: add the callback URL, and copy its Client ID and a client secret. Its App ID and private key keep posting. In short:

| GitHub App setting | Value |
| --- | --- |
| Callback URL | `https://<your site>/api/_vitehub/comments/auth/callback/github`, one per site. A GitHub App takes up to 10. |
| Expire user authorization tokens | Off. When on, GitHub's token lasts 8 hours, and Comments cannot store a renewed one in the cookie, so people must sign in again. |
| Webhook | Off |
| Permissions | Only the default. Add **Pull requests: Read and write** to [post as each person](#post-as-each-person). |
| Installed on | The app's repository |

| Server variable | Value |
| --- | --- |
| `VITEHUB_GITHUB_CLIENT_ID` | The App's **Client ID**. |
| `VITEHUB_GITHUB_CLIENT_SECRET` | A client secret of the App. |
| `VITEHUB_SECRET` | The [app secret](/docs/env/app-secret): at least 32 characters, the same on every server. Comments derives its own session cookie key from it. The dev server works without it. |

On Cloudflare, Comments also reads the variables from the Worker's bindings.

**Who gets in.** People who can push to the build's repository. Comments asks GitHub, and asks again every 5 minutes. It finds the repository like [pull request posting](#post-comments-to-the-pull-request): `GITHUB_REPOSITORY`, the Vercel Git variables, Netlify's `REPOSITORY_URL`, else the checkout's GitHub `origin` remote at build time. If none is found, set `GITHUB_REPOSITORY=owner/name` for the build. Without a repository, no GitHub user gets in, and the overlay says why.

**What `authorize` gets.** `user.github` holds the GitHub account, so you can widen or narrow the default:

```ts [server/comments.ts]
import { defineComments } from 'vite-hub/comments'

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
| `user.github.repository` | The build's repository, `owner/name`, when known. |
| `user.github.write` | Whether they can push to it. |

**The session.** There is no user or session table. The session and GitHub token live in encrypted cookies whose names start with `vitehub_comments`. They last 7 days from sign-in.

::warning
You cannot end one session from the server. Signing out clears the cookies in that browser only. To sign everyone out, change `VITEHUB_SECRET`.
::

**Preview URLs.** GitHub returns people only to callback URLs the App lists, so per-deployment URLs, such as Vercel or Netlify previews, cannot sign people in. List a stable preview URL, such as a branch domain, or use [your own login](#use-your-own-login).

An OAuth App works for public repositories only. Comments asks only for the `read:user` and `user:email` scopes, so GitHub hides private repositories.

Comments needs no email permission. When GitHub hides a person's email, Comments uses their noreply address, `<id>+<login>@users.noreply.github.com`.

### Comments through the Console

Comment operations from the [Console](/docs/development/console), the CLI, and the [ViteHub MCP](/docs/development/mcp) need Console access to the **Comments** section. In an app without `identify`, the Console caller is the author, and `authorize` runs after the Console check. With `identify`, the Console has no say: see [Use your own login](#use-your-own-login).

The overlay on the app's pages does not read Console access. On pages, people get in through `identify`, through ViteHub Auth with `authorize`, or through [Sign in with GitHub](#sign-in-with-github), which an app with the Console also gets.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { auth: true, console: { authorize: './server/console-authorize.ts' } },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ auth: true, console: { authorize: './server/console-authorize.ts' } }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ auth: true, console: { authorize: './server/console-authorize.ts' } })],
})
```
:::
::

See [Limit a user to some sections](/docs/development/console#limit-a-user-to-some-sections) for `console-authorize.ts`. To limit Comments to some Console users, return the sections from it, such as `{ sections: ['comments', 'content'] }`.

A `comments:read` grant allows reading threads and joining page presence. Creating, replying, resolving, reopening, deleting, and Content field edits need the full `comments` grant and the Comments policy.

| Caller | Comment author |
| --- | --- |
| The Console, or an agent on the ViteHub MCP | The person signed in to the Console |
| The CLI, `auth: false`, or the dev server without a `console` option | A guest (`user: null` in policies). |

### Use your own login

To use your own login, return the user from `identify`, or `null` when anonymous. `identify` names the user, and `authorize` decides what they may do. Comments then ignores the Auth session and Console access, so members, guests, and share link readers can comment in an app with the Console. Comment operations from the Console, the CLI, and the ViteHub MCP also call `identify` with the call's request. An agent's call has no request, so it has no user.

::warning
Without `authorize`, a production build lets in nobody that `identify` names. Write the policy.
::

```ts [server/comments.ts] fragment
import { defineComments } from 'vite-hub/comments'
import { findSession } from './utils/session'

export const comments = defineComments({
  // `event` is the Request of the call or its server event. `event['~standard'].req` is the Request, with its cookies.
  identify: async ({ event }) => {
    const session = await findSession(event['~standard'].req)
    return session ? { id: session.userId, name: session.name, image: session.avatar } : null
  },
})
```

The user needs a string `id`. Comments shows `name`, else `email`, else "Someone", and a string `image`. `identify` also sets the person in the presence room, so nobody can pose as someone else.

### Let guests comment

Return `true` for `user: null` to let people without an account comment. The overlay asks for a display name once, keeps it in `localStorage`, and shows it with "(guest)".

```ts [server/comments.ts]
import { defineComments } from 'vite-hub/comments'

export const comments = defineComments({
  // Guests may read and comment. Only editors resolve.
  authorize: ({ user, action }) => action !== 'resolve' || user?.role === 'editor',
})
```

::warning
The server does not verify a guest name or ID. They are display data, never proof of ownership.
::

A guest id starts with `guest:`, so it never matches a signed-in person's id. Guests cannot delete messages or threads, even when the policy allows `delete`, and nobody can mention a guest. To delete your messages, sign in, or ask a signed-in moderator with `delete`.

### Roles from Site access

[Site access](/docs/development/console#give-browsers-site-access) in the Console signs members and invited guests in to the app, with roles of Better Auth's `admin()` plugin, or, in an app without Auth, roles in its sealed `vitehub_site` cookie: `comments-read`, `comments-write`, `comments-resolve`, and `comments-delete`. Any of the last three also lets the person read. Members get all four. A guest gets the ones the member picked, and comments under the name the member gave them.

Without `authorize`, these roles decide. With `authorize`, your policy decides, so check the roles there with `commentsRoleAllows()` from `vite-hub/comments`:

```ts [server/comments.ts]
import { commentsRoleAllows, defineComments } from "vite-hub/comments"

export const comments = defineComments({
  authorize: ({ user, action }) => commentsRoleAllows(user, action) || user?.role === "admin",
})
```

## Comments in your own UI

The overlay and the Console show threads on `page` subjects, pinned on the app's pages. To keep comments on your own records, such as a document, and show them in your UI, define a subject kind. The overlay, the Console section, and the [ViteHub MCP](/docs/development/mcp) never show or change these threads.

```ts [server/comments.ts]
import { defineCommentSubject, defineComments } from 'vite-hub/comments'

export const comments = defineComments({
  subjects: [
    defineCommentSubject({
      kind: 'doc',
      // Every version of a document shares one number sequence: "#3" names one thread.
      scope: id => `doc:${id}`,
      // A suggestion keeps its text in metadata, so its message may be empty.
      emptyBody: ({ metadata }) => typeof metadata?.suggestion === 'string',
      // onMention gets this as `link`.
      link: thread => `/docs/${thread.subject.id}?comment=${thread.n}`,
    }),
  ],
})
```

The route below uses two helpers of the app: the signed-in user, and the app's own rule for who may comment on a document.

```ts [server/utils/docs.ts]
import { createError } from 'h3'
import { auth } from 'vite-hub/auth/server'
import type { H3Event } from 'h3'

export async function requireUser(event: H3Event) {
  const session = await auth.api.getSession({ headers: event.req.headers })
  if (!session) throw createError({ status: 401 })
  return session.user
}

// Archived documents take no new comments.
export async function canComment(user: { id: string }, documentId: string) {
  return !documentId.startsWith('archive/')
}
```

```ts [server/api/docs/[id]/comments.post.ts]
import { defineEventHandler, getRouterParam, readValidatedBody } from 'h3'
import * as v from 'valibot'
import { comments } from '../../../comments'
import { canComment, requireUser } from '../../../utils/docs'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = getRouterParam(event, 'id')!
  if (!await canComment(user, id)) throw new Error('You cannot comment on this document.')
  const { body, quote, version } = await readValidatedBody(event, body => v.parse(v.object({ body: v.string(), quote: v.string(), version: v.number() }), body))
  const [error, thread] = await comments.create({
    subject: { kind: 'doc', id },
    revision: version,
    metadata: { kind: 'text', quote },
    body,
    author: { id: user.id, name: user.name },
  })
  if (error) throw error
  return thread
})
```

- `metadata` keeps what your UI needs, such as where the comment sits: at most 50 keys with string, number, boolean, or `null` values.
- `revision` is the subject version the thread starts on. `comments.list({ subject, revision: { lte: 3 } })` lists threads of version 3 and earlier, so a comment stays until someone resolves it.
- A message with attachments may have no text. On other subjects, `emptyBody` decides.
- Threads are numbered 1, 2, 3, … in their subject's scope. Numbers are never reused, even after deletes. `getByNumber('doc:42', 3)` finds "#3".
- `removeScope('doc:42')` deletes every thread of the document, for example when the document is deleted.
- The runtime methods are trusted server API, so check access in your route. `comments.can()` passes the `thread` or `subject` to `authorize`.

## Choose the Database

`comments()` keeps threads in the database you point it to, and creates its tables there on first use. No migration, no Database to define. The tables start with `vitehub_comment`, so they sit next to your app's tables. A [ViteHub app](/docs/comments/with-vite-hub) uses a ViteHub Database instead.

Give `database` a string that names a variable or binding, so the URL and token stay out of the build:

| `database` | Where threads go |
| --- | --- |
| Not set | The first one the server finds at runtime: `DATABASE_URL`, `TURSO_DATABASE_URL`, then the Cloudflare D1 binding `DB`. A Postgres `DATABASE_URL` is skipped. |
| `'d1:COMMENTS'` | The Cloudflare D1 binding `COMMENTS`. Comments adds the binding to the build. |
| `'env:COMMENTS_DATABASE_URL'` | The libSQL URL in that variable, such as Turso. The token is in the URL or `COMMENTS_AUTH_TOKEN`. |
| `'file:./data/comments.sqlite'` | A SQLite file on Node, relative to the server's start directory. |
| `'libsql://…'` | That libSQL URL. A token in it ends up in the build, so use `env:` instead. |

On Node, the runtime variables can also hold a `file:` location. Comments picks the connector at runtime, so the path stays out of the build. Workers support D1 and remote libSQL. A static `file:` or `:memory:` location fails the Worker build with `DATABASE_UNSUPPORTED_URL`.

On `vite dev`, threads go to `.vitehub/data/comments.sqlite`, with a `.gitignore` next to it, so local threads stay out of your app's database. A `file:` path, or a set `env:` variable, replaces it.

With a Nitro Cloudflare preset, such as `NITRO_PRESET=cloudflare_module`, `vite dev` runs the server in workerd, which cannot open that file. Threads then go to the `database` option when set, else to a local D1 binding `COMMENTS` that Miniflare keeps in `.wrangler/state`. An unset `env:` variable also falls back to it. To keep the file, set Nitro's `devServer.runner` to `node-worker`.

With no database found, the API returns `500`, and the log shows [`DATABASE_NOT_CONNECTED`](/docs/database/limits-and-errors#database_not_connected) with what it looked for. A string Comments cannot use, such as a Postgres URL, fails the build with [`DATABASE_UNSUPPORTED_URL`](/docs/database/limits-and-errors#database_unsupported_url). Postgres support comes in a later version.

### Turso and other libSQL databases

Set the URL and token on the server. Comments finds them without an option:

```bash [.env]
TURSO_DATABASE_URL=libsql://comments-acme.turso.io
TURSO_AUTH_TOKEN=...
```

When your app uses `DATABASE_URL` or `TURSO_DATABASE_URL` for another database, give Comments its own variable: `comments({ database: 'env:COMMENTS_DATABASE_URL' })`.

### Cloudflare D1

```ts [vite.config.ts]
import { comments } from '@vite-hub/comments/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [comments({ database: 'd1:COMMENTS' })],
})
```

Build for Workers and deploy:

```bash [commands/deploy]
pnpm add -D wrangler
NITRO_PRESET=cloudflare_module pnpm vite build
pnpm wrangler deploy
```

Comments adds the `COMMENTS` binding, without a database id, to the build's Wrangler config, and `wrangler deploy` creates the D1 database. If `wrangler.jsonc` has a binding with that name, Comments uses yours, with its id. Name a binding `DB` to leave out `database`.

To try the Worker locally, run `pnpm wrangler dev` after the build, or `NITRO_PRESET=cloudflare_module pnpm vite dev` during development. Both keep a local D1 database in `.wrangler/state`.

Add the [Sign in with GitHub](#sign-in-with-github) variables as Worker secrets, such as `pnpm wrangler secret put VITEHUB_GITHUB_CLIENT_ID`.

### A SQLite file

```ts [vite.config.ts]
import { comments } from '@vite-hub/comments/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [comments({ database: 'file:./data/comments.sqlite' })],
})
```

Comments opens the file with Node's built-in `node:sqlite`, so you need no driver. Keep it on a disk that survives deploys and restarts, such as a Docker volume, and run one server process.

### A ViteHub Database

In a [ViteHub app](/docs/comments/with-vite-hub), Comments adds four tables to a Database at build time: `vitehub_comment_threads`, `vitehub_comment_messages`, `vitehub_comment_counters`, and `vitehub_comment_forge`. By default, it uses the Database named `default`, else the only one. `vitehub({ database: true })` or the [CMS](/docs/cms) gives an app without a Database Definition a `default` Database.

To use another Database, give its name:

```ts [server/comments.ts]
import { defineComments } from 'vite-hub/comments'

export const comments = defineComments({
  database: 'team',
})
```

ViteHub reads the name without running the file, so write it as a string literal. The build fails with `DATABASE_INVALID_CONTRIBUTION_TARGET` when the named Database does not exist, or when there are several Databases and none is named `default`. The tables use SQLite, so the Database must be SQLite, libSQL, or D1.

`vitehub({ comments: { database: 'team' } })` names it without the file. Run `vitehub database generate` and `vitehub database migrate` after you add `server/comments.ts`, turn on the `comments` option, or change `database`. See [Apply migrations](/docs/database/configure#apply-migrations).

## Upgrade to one model

The overlay and the comment operations used to have separate tables. The overlay's live-site model used `vitehub_comment_threads` (with `number`, `page`, and `created_by`), `vitehub_comments`, and `vitehub_comment_scope_counters`. Now both share one model, so a Database with live-site tables must move them once, in place:

1. It renames the old threads table to `vitehub_comment_threads_live`.
2. It creates any missing `vitehub_comment_threads`, `vitehub_comment_messages`, `vitehub_comment_counters`, and `vitehub_comment_forge` tables.
3. It copies every thread and comment, and deletes nothing. `vitehub_comment_threads_live`, `vitehub_comments`, and `vitehub_comment_scope_counters` stay for you to check. Drop them yourself later.

All statements run in one batch or transaction, so a failure changes nothing.

| Live-site field | One model |
| --- | --- |
| `number` | `n`, the same number, unless a legacy `site` scope already gave out numbers. Then page numbers start after that scope's highest number, and its own numbers stay. |
| scope `pages` and `page` | subject `{ kind: 'page', id: page }`, scope `site` |
| scope `kind:id`, such as `drop:42` | subject `{ kind: 'drop', id: '42' }`, scope `drop:42`. Define the kind with `defineCommentSubject({ kind: 'drop', scope: id => \`drop:${id}\` })` so new threads take the same scope. The thread's `page` stays only in the backup table. |
| other scopes | subject `{ kind: scope, id: page }` |
| `anchor` | an `element` anchor with the same `field`, `label`, `page`, and `viewport` hints; `{ kind: 'page' }` when it was `null` |
| `created_by`, `resolved_by` | `author`, `resolvedBy`. Guests keep their `guest:` ids. |
| `comments[]` | `messages[]`, with the same ids, so pull request links in `vitehub_comment_forge` follow |
| `mentions: { id, name }[]` | `mentions: id[]` |
| `metadata`, `context` | the same |
| `vitehub_comment_scope_counters` | `vitehub_comment_counters`: numbers continue after each scope's highest |

::warning
Stop comment writes while you migrate, also from older app instances, and back up the Database first.
::

**A ViteHub Database.** The migration must go in the migration history, so that `vitehub database generate` does not try to change the old table itself:

1. Run `vitehub database generate --custom --schema-snapshot --name comments_one_model`. It writes an empty SQL migration and the snapshot of the new tables. Without `--schema-snapshot`, the snapshot is a copy of the previous one, and the next `vitehub database generate` tries to move the tables again.
2. Print the SQL and put it in that file, one statement before each `--> statement-breakpoint`:

```bash
node --input-type=module -e "import { commentsMigrationSql } from 'vite-hub/comments/database'; console.log(commentsMigrationSql({ from: 'live' }).join(';\n--> statement-breakpoint\n') + ';')"
```

3. Run `vitehub database migrate --dry-run`, then `vitehub database migrate`.

A Database that already has the comment operations' tables gets the new `metadata`, `context`, `revision`, and `request_id` columns and the `vitehub_comment_forge` table from a normal `vitehub database generate`.

Until the tables move, every Comments request fails with [`COMMENTS_R0019`](/docs/comments/operations/limits-and-errors) and status `503`. Its `fix` names this migration. Comments checks the tables once per server process, so the next request after `vitehub database migrate` works without a restart.

**A Database that `comments()` opens itself.** Comments owns the SQLite file, `env:` libSQL URL, and D1 binding of `comments()`, so it moves them itself. Before each server process's first query, it runs `migrateComments()` and creates missing tables. Requests wait for the move. To move the tables before a deploy, run `migrateComments(db)` with a Drizzle database. A second run does nothing:

```ts [scripts/migrate-comments.ts]
import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { migrateComments } from '@vite-hub/comments/database'

const db = drizzle({ client: createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN }) })
console.log(await migrateComments(db))
// { from: 'live', statements: [...], backup: 'vitehub_comment_threads_live' }
```

For Cloudflare D1, you can also write the SQL to a file and run `wrangler d1 execute COMMENTS --remote --file comments-one-model.sql`.

`migrateComments(db, { dialect: 'postgresql' })` adds the new columns to the comment operations' Postgres tables. The live-site model had no Postgres tables.

## Mention people

Type `@` in a comment to mention someone. The server checks that the id is a real person, the text names them with `@`, and `canMention` allows them. People come from:

| App | `@` suggests |
| --- | --- |
| With `people` | The people `people` finds. |
| With [ViteHub Auth](/docs/auth) | Auth users. |
| Neither | Authors of earlier comments in threads the writer may read. |

By default, a person may be mentioned only in a thread they may read: `authorize({ action: 'read', user: person, thread })`. Suggestions leave out others, and mentioning one fails with `COMMENTS_INVALID_INPUT`. Change this with `canMention`:

```ts [server/comments.ts] fragment
import { defineComments } from 'vite-hub/comments'
import { foldName } from 'vite-hub/comments/client'
import { team } from './utils/team'

export const comments = defineComments({
  people: {
    search: query => team.filter(person => foldName(person.name).includes(foldName(query))),
    byIds: ids => team.filter(person => ids.includes(person.id)),
  },
  // Only people of the same team, whatever they may read.
  canMention: ({ user, person }) => person.team === user?.team,
})
```

`people.search` gets the text after `@` and returns at most 20 people. Return full records for `canMention` and `authorize`; the browser gets only `id`, `name`, and `image`. A message keeps at most 20 mentions, as ids.

Suggestions keep a person whose name holds the text after `@` when accents and case do not count, so `@jose` keeps José. `foldName()` removes accents and case in the same way. Auth users and earlier authors are found with a database search that does not remove accents, so there `@jose` finds only names written without them. Give `people` to find them all.

## Notify mentioned people

`onMention` runs once per saved message that mentions people, with those people. An edit runs it only for added people. It runs after the response, through `waitUntil` where available. A failure is logged and never fails the comment. Use it with [Email](/docs/email):

```ts [server/comments.ts] fragment
import { defineComments } from 'vite-hub/comments'
import { email } from 'vite-hub/email'
import { findUserEmail } from './utils/users'

export const comments = defineComments({
  onMention: async ({ users, message, thread, link }) => {
    for (const user of users) {
      const to = await findUserEmail(user.id)
      if (!to) continue
      const [error] = await email.send({
        from: 'comments@example.com',
        to,
        subject: `${message.author.name ?? 'Someone'} mentioned you`,
        text: `${message.body}\n\nhttps://example.com${link ?? thread.subject.id}`,
      })
      if (error) console.error(error.why)
    }
  },
})
```

The server has checked each person in `users`. `link` is the app path that opens the thread, such as `/pricing?comment=3` for a page, or what the [subject's `link`](#comments-in-your-own-ui) returns.

`onComment({ thread, message, mentions })` runs after each new thread or reply saves, before the response. Keep it short, or send the work to a [Queue](/docs/queue). Comments logs its errors and still returns the saved comment.

## Attach files

A message can keep files, with keys in `attachments`. The `comments.upload` operation, or `POST /api/_vitehub/comments/attachments`, stores a file and returns `{ key, name, type, size }`. Pass the key in `attachments` of `comments.create` or `comments.reply`. A message with attachments may have no text. Uploads need `write` on the subject.

By default, files go to the app's [Blob](/docs/blob) store, under `comments/<id>/<name>`. To store them yourself, return the key from `storeAttachment`:

```ts [server/comments.ts] fragment
import { defineComments } from 'vite-hub/comments'
import { saveImage } from './utils/images'

export const comments = defineComments({
  storeAttachment: async (file, { user, subject }) => {
    // file: { name, type, size, data: Uint8Array }, already checked
    return await saveImage({ owner: user?.id, subject, ...file })
  },
  // Pairs with storeAttachment: the file of a key, as a Blob with its media type, or null.
  readAttachment: async (key, { user, thread }) => await readImage(key),
})
```

Comments checks size and type before it calls `storeAttachment`: at most 5 MB of PNG, JPEG, GIF, WebP, AVIF, PDF, or plain text. See [Limits](/docs/comments/limits-and-errors#limits). Without Blob or `storeAttachment`, uploads fail with `COMMENTS_R0014`.

**Show attachments.** `GET /api/_vitehub/comments/attachments/<key>` returns the file to people who may read a thread with a message that lists the key. Others, and unlisted keys, get `404` with `COMMENTS_R0020`. It reads with `readAttachment`, else from Blob. With `storeAttachment` and no `readAttachment`, it returns `COMMENTS_R0021`. Use `transport.attachmentUrl(key)` of [`createRestTransport()`](/docs/comments/server-api#rest-transport), or `commentAttachmentUrl(key)`, as a thumbnail `src`. For the CLI, the `comments.attachment` operation returns the file in Base64.

The response keeps a browser from running the file:

| Header | Value |
| --- | --- |
| `Content-Type` | The stored type, when Comments attaches that type. Other types, such as SVG or HTML from your own `storeAttachment`, are sent as `application/octet-stream`. |
| `Content-Disposition` | `inline` for PNG, JPEG, GIF, WebP, and AVIF. `attachment` with the file name for PDF, text, and all other types. |
| `X-Content-Type-Options` | `nosniff` |
| `Content-Security-Policy` | `default-src 'none'; sandbox` |
| `Cache-Control` | `private, max-age=300` |

::warning
A key gives read access through any thread that lists it, so keep keys hard to guess.
::

Blob store keys carry a random id. Without `readAttachment`, Comments reads only its own uploads. It saves an ownership record at `comments/<uuid>/.upload.json` with the exact key and a SHA-256 digest, and checks both before it returns the file. A message that lists an app file, even at a matching `comments/<uuid>/<name>` path, gets `COMMENTS_R0020`. An upload replaced with other contents also becomes unreadable.

Copy the ownership records with the files when you back up Blob storage. Uploads from versions without records must be uploaded again, or read through a `readAttachment` hook that checks access.

## Turn comment mode on and off

Comments is a ViteHub page tool, a tool that runs on your app's pages. Comment mode starts after a person signs in with ViteHub Auth, or on a page with the `?vitehub` query, such as `https://example.com/pricing?vitehub`. `?vitehub=comments` does the same.

1. The page loads the page tools loader, which calls `GET /_vitehub/page/session`.
2. That route runs each page tool's visitor check. Comments allows the overlay when `authorize` allows `read`, or to offer GitHub sign-in or account switching. The sign-in prompt grants no access to threads.
3. The route sets `vitehub-tools=1` for 30 days, so other pages open in comment mode too. When no tool allows the person, it sets `vitehub-tools=0`, and the loader stops.

The cookie is only a hint. Every API request checks access again.

The Comments toolbar is one segment of the ViteHub tools pill at the bottom of the page. The pill's **×** button, **Turn off ViteHub tools**, turns all page tools off: it sets `vitehub-tools=0` and removes the query and the pill.

The Comments segment works like the one in Drop. **Comments** shows the number of open threads. For people who may comment, it turns comment mode on and then says **Click anywhere**. Beside it, **Whole page** starts a comment on the page itself, **All comments** opens the list of the page's threads, and **×** turns comment mode off. For people who may only read, **Comments** opens the list.

| Key | Action |
| --- | --- |
| <kbd>C</kbd> | Turn comment mode on or off, as **Comments** does. While it is on, a click anywhere starts a thread, and the segment shows **Whole page**, **All comments**, and **×**. |
| <kbd>B</kbd> | Turn **Highlight** on or off. While it is on, a drag draws with the marker. With another tip in hand, <kbd>B</kbd> takes the marker. |
| <kbd>P</kbd>, <kbd>A</kbd>, <kbd>T</kbd> | With **Highlight** on, take the pen, the arrow, or the text tip. |
| <kbd>E</kbd> | Turn **Edit** on or off, when the app has Content. |
| <kbd>Esc</kbd> | Close the open thread, or turn comment mode, **Highlight**, and **Edit** off. In a label, put the label down. |
| <kbd>Enter</kbd> | Send the comment. <kbd>Shift</kbd> <kbd>Enter</kbd> starts a new line. With **Highlight** on, comment on the ink. In a label, put the label down. |

**Highlight** works like the Marker in Drop. Pick a tip and one of four colors, draw on the page, and select **Done**. The overlay takes a picture of the screen with the ink on it, and opens a comment on the area that the ink covers with the picture attached. The ink stays on the page while you write. The page does not scroll while you draw, and <kbd>Cmd</kbd> <kbd>Z</kbd> or <kbd>Ctrl</kbd> <kbd>Z</kbd> takes back the last stroke or label. The picture uploads like any attachment, so it needs attachments: the Blob store of the app or a [`storeAttachment`](#attach-files) hook. When the page cannot be drawn as a picture, for example because an image from another origin blocks it, the comment marks the area without one.

| Tip | What a drag or a click does |
| --- | --- |
| Marker | A see-through stroke. The words under it stay dark. <kbd>Shift</kbd> keeps the stroke on its line. |
| Pen | A thin solid line. <kbd>Shift</kbd> draws it straight. |
| Arrow | An arrow from where the drag starts to where it ends. Its shaft bows a little, and <kbd>Shift</kbd> draws it straight. |
| Text | A click types a label there. A click on a label edits it, a drag moves it, and a label with no words goes. <kbd>Cmd</kbd> <kbd>Enter</kbd> or <kbd>Ctrl</kbd> <kbd>Enter</kbd> puts the label down and comments on the ink. |

Every HTML page gets the page tools bootstrap, a short inline script before `</body>`. It is the same for every visitor, so the page keeps its cache headers. It loads the loader only with a hint: the `?vitehub` query, `vitehub-tools=1`, or the [Auth session marker](/docs/auth/configure#session-marker-cookie) of someone who just signed in. Without a hint, the page makes no request. With the hint, the server instead adds `<script type="module" src="/_vitehub/page/assets/loader.js?v=14">` and sends `cache-control: private, no-store`. The loader imports the overlay only for people the session route allows. With an application base such as `/portal/`, the loader and session URLs start with `/portal/_vitehub/page/`. Paths under `/_vitehub` and `/api` never get the page tools.

- Nitro 3 apps, including Nuxt 5, get the script from the server response.
- A single-page app whose `index.html` Vite serves or builds gets the bootstrap in `index.html`.
- Prerendered pages get the bootstrap at render time, so static hosting and CDNs still show the overlay. The server never adds a second script.

### Apps below a base path

With a Vite `base`, such as `base: '/docs/'`, or a Nuxt `app.baseURL`, Comments and the page tools follow it. The session route is `/docs/_vitehub/page/session`, the loader is `/docs/_vitehub/page/assets/loader.js`, and the Comments API is `/docs/api/_vitehub/comments`. The loader and overlay read the base from their own URL. Paths under `/docs/_vitehub` and `/docs/api` never get the loader.

ViteHub registers these routes below the part of the base that Nitro does not add. When Nitro `baseURL` is the same path, as Nuxt sets for `app.baseURL`, Nitro adds the base and ViteHub adds nothing.

A prerendered site needs no extra route. Its pages have the bootstrap, so a Nuxt app on Cloudflare Workers can serve them as static assets, without `assets.run_worker_first`. Only the session route and Comments API run in the Worker.

A thread link, `<page>?comment=<n>`, also loads the page tools, opens Comments, and opens that thread, even when resolved. `onMention` gets this link.

The overlay is a custom element with a shadow root, so your CSS and its CSS stay apart. It uses the Console's comment parts from [`@vite-hub/ui`](/docs/ui/comments): pins, threads, the composer with `@` mentions and files, and `CommentPanel` as the thread list. Files go through the `comments.upload` checks, so they need Blob or `storeAttachment`.

## Mark Content fields

Edit mode lets people change Content text on the page, so each editable element needs its field address. `contentField()` from `vite-hub/content/client` writes it as a `data-content-field` attribute. In Vue, spread it with `v-bind`:

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

The field is a dot path into the document, such as `hero.title` or `cards.0.title`. Without Vue, write the attribute yourself, or build it with `formatContentField({ collection, id, field })`.

- Put the attribute on an element that holds only the field text. An edit replaces its text, so child elements disappear until the page renders again.
- Only fields with a string draft value are editable on the page. For others and the Markdown body, use the Content section of the Console.
- An edit needs `write` from Comments and from the [Content `authorize`](/docs/content/configure#access) policy for that document. Guests can edit only when the Content policy allows `user: null`.
- <kbd>Enter</kbd> or leaving the field saves. <kbd>Esc</kbd> cancels.

A save writes the whole document to `draft` with the message `Edit <field> on the page`. It fails with [`COMMENTS_FIELD_CONFLICT`](/docs/comments/limits-and-errors#comments_field_conflict) if the document changed after the page read it, and with [`COMMENTS_FIELD_LOCKED`](/docs/comments/limits-and-errors#comments_field_locked) if someone holds the [edit lease](/docs/content/editing-together) in the Console.

In edit mode, the overlay marks edited fields with **Draft**. A reload shows the published text again, without the mark. Publish in the [Console](/docs/content/console), where review and approval rules apply. Comment mode does not turn on [draft preview](/docs/content/preview).

A pin on or inside a Content field element stores the field address, so it follows that text through layout changes.

## Post comments to the pull request

On a preview deployment, `forge` posts each thread to the preview's pull request. Code reviewers and Agents on the pull request see what testers said.

```ts [server/comments.ts]
import { defineComments } from 'vite-hub/comments'

export const comments = defineComments({
  forge: { provider: 'github' },
})
```

| On the page | On the pull request |
| --- | --- |
| The first thread | A summary comment listing every thread: number, first sentence, page, author, and state. Comments edits it when a thread changes. |
| A thread | A comment with the text, a link that opens the thread on the page, the element, and what the person saw: route, components, source files, viewport, browser, and build. |
| A reply | A comment of its own. |
| An edit | Edits that comment. |
| Resolve, reopen | Hides the thread's comment as resolved, or shows it again. |
| Delete | Deletes the comments. The summary goes with the last thread. |

Comments finds the pull request from the build that served the page, as `context.build` records it:

- Repository: `GITHUB_REPOSITORY`, the Vercel Git variables, Netlify's `REPOSITORY_URL`, else the checkout's GitHub `origin` remote.
- Pull request: the one the host names (Vercel, Netlify, GitHub Actions), else the open pull request whose head is the build's branch.

Threads without a pull request, such as on production, stay off GitHub. To choose, return the number from `pullRequest(thread)` and set `repository`.

Posting uses a GitHub App installation. Set `VITEHUB_GITHUB_APP_ID` and `VITEHUB_GITHUB_PRIVATE_KEY`, and give the App write access to pull requests or issues. `VITEHUB_GITHUB_TOKEN` also works, and posts as its user. The [Forge capability](/docs/agents/capabilities/forge) reads the same names.

### Post as each person

The App posts each comment with its author's name: "**Ada** commented on the preview:". People who [signed in with GitHub](#sign-in-with-github) post as themselves, with their sign-in token. Give the sign-in App **Pull requests: Read and write**, or their comments go through the posting App. GitHub then shows their account with the App's badge.

With another sign-in, return their GitHub token from `token(author)`, such as their GitHub user token from [Auth](/docs/auth). `token` replaces the sign-in token.

```ts [server/comments.ts] fragment
import { defineComments } from 'vite-hub/comments'
import { githubToken } from './utils/github'

export const comments = defineComments({
  forge: {
    provider: 'github',
    token: author => githubToken(author.id),
  },
})
```

Guests always post through the App, and so does anyone whose token fails. The post runs after the request ends, so Comments keeps the sign-in token in memory for 10 minutes after the person's last request, and forgets it on sign-out.

### When GitHub refuses

Changes do not wait for GitHub. Each thread has `forge` with `state` (`posted`, `pending`, or `failed` with the `error`) and the `url` of its comment. The thread's next change retries, and so does `comments.sync(threadId)`.

GitHub ids live in the `vitehub_comment_forge` table. `comments()` creates it with the other tables. With `vitehub()`, run `vitehub database generate` and `vitehub database migrate` after you add `forge`. On Cloudflare, the API routes keep the Worker running until GitHub answers. When server code changes threads, pass `comments.flush()` to `waitUntil`.

App mentions and thread numbers stay plain text on GitHub: `@ada` does not notify a GitHub user, and `#3` does not link issue 3.

## Triage in the Console

The Comments section of the [Console](/docs/development/console) lists the 500 threads with the newest activity, open first: first comment, page, author, replies, status, and last activity. Select a thread to read its comments, with the page context below. **Open on page** opens its `?vitehub=comments#comment-<id>` link in a new tab. Reply and resolve on the page, where the context is.

`vitehub inspect` lists the Comments route, the `comments` Realtime Definition when presence runs, and the tables in the Database.

## Fix comments with an Agent

Connect the Agent to the [ViteHub MCP](/docs/development/mcp) of the Console. It runs the Comments operations of your app, such as `comments.threads` and `comments.reply`: it lists open threads, reads their page context and source files, changes the code, then replies and resolves. It acts as you, and `authorize` applies to each call.

Your own MCP server can register the same tools. `commentsMcpTools(comments)` from `vite-hub/comments/runtime` returns them, each with a JSON Schema and a `call(input, { user })` function.

::warning
Your server must authenticate `user` before it calls a tool. Pass `null` for an anonymous caller.
::

Without an event, the tools use this user even when Comments defines `identify`. To use `identify`, pass `call(input, { user, event })` with the Request or the H3 event of the call; `authorize` then decides. Without `identify`, the tools use `user`. Pass `commentsMcpTools(comments, { console: true })` only when your server checked Console access of the `comments` section first, as the Console route does: the default policy then trusts `user`, the same as the comment operations. Browser guest headers name an author only when `authorize` permits the anonymous caller.
