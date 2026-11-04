---
title: Comments configuration
description: Decide who can comment, sign people in with GitHub, let guests in, keep comments on your own records, choose where threads go, upgrade the tables, mention and notify people, attach files, turn comment mode on and off, and mark Content fields for edits in place.
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

`authorize` gets the user, the action, and what the action is about: the `thread`, or the `subject` of a new thread. Return `true` to allow. Any other value denies.

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
| `read` | See pins and threads, join the presence room of the page, and get `@` suggestions. |
| `write` | Start threads, reply, and attach files. Signed-in authors can also edit and delete their own messages. |
| `resolve` | Resolve and reopen any thread. |
| `delete` | Signed-in users can delete any thread or message. |

`thread` is the thread that the action changes. It is `undefined` for lists and for new threads; a new thread has `subject`. The same policy runs for the overlay, the [comment operations](/docs/comments/operations/configure), the Console, MCP, and Agents.

Without `authorize`, a production build lets in only people that a sign-in already checked. Anyone may be able to sign up to an app, so a user of ViteHub Auth or `identify` waits until you write a policy:

| Person | Without `authorize` |
| --- | --- |
| Signed in [with GitHub](#sign-in-with-github) | May do everything when they can push to the repository of the build. Nothing otherwise, also on the dev server. |
| Admitted by the [Console](#comment-as-the-console-team) to its Comments section | May do everything that the Console grant allows. The comment operations, the CLI, and MCP always run after this check. |
| Signed in with ViteHub Auth or `identify`, in a production build | Nothing. The API answers [`COMMENTS_POLICY_MISSING`](/docs/comments/limits-and-errors#comments_policy_missing), and the server log shows `COMMENTS_R0006` once. |
| Anyone on the dev server | May do everything. People who are not signed in comment as guests under a name they type. |
| Not signed in, in a production build | Nothing. |

The dev server follows Vite's serve/build command, never the server's `NODE_ENV`. `defaultPolicy(user, { development, console })` from `vite-hub/comments` is this table as a function, so a policy of your own can fall back to it.

The user comes from `identify`, else from the [Console](#comment-as-the-console-team) when the app has one, else from the ViteHub Auth session when the app has [Auth](/docs/auth), else from [Sign in with GitHub](#sign-in-with-github).

Every route of the Comments API checks the policy again. A user that `read` denies gets `403` with [`COMMENTS_FORBIDDEN`](/docs/comments/limits-and-errors#comments_forbidden), and the overlay does not open. Write requests must also come from a page of the same origin.

The [runtime methods](/docs/comments/server-api#runtime-methods), such as `comments.create()`, are trusted server API. They do not call `authorize`. Call `comments.can()` first when a route acts for a user. They still check the input: mentions, `metadata`, and the limits.

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

A `comments:read` grant allows reading threads and joining page presence. Creating, replying, resolving, reopening, deleting, and editing Content fields require the full `comments` grant as well as the Comments policy.

When a person signs in to the app with `auth: 'app'`, or opens the Console, the next page calls `GET /_vitehub/page/session`. That sets `vitehub-tools=1` when the person may read comments, so the app's pages show the Comments toolbar from then on. Other people get `vitehub-tools=0`, so their pages load no Comments script.

| Console sign-in | Comment author |
| --- | --- |
| `auth: 'app'` or a Console Auth config | The signed-in Console user |
| `provider: 'cloudflare-access'` | The email that Cloudflare Access checked |
| `auth: false`, or the dev server without sign-in | A guest (`user: null` in policies). The overlay asks for a display name when guest access is allowed. |

### Use your own login

Return the user from `identify` to use your own login. Return `null` for an anonymous request. When `identify` is configured, Comments does not read the ViteHub Auth session. Apps with the Console still check Console section access first.

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

The server does not verify a guest name or ID. They are display data, never proof of ownership. A guest id starts with `guest:`, so it never matches the id of a person who signs in. Guests cannot delete messages or threads, even when the policy allows `delete`, and nobody can mention a guest. Sign in to delete your own messages, or ask a signed-in moderator with `delete` permission.

## Comments in your own UI

The overlay and the Console show threads on `page` subjects: the ones people pin on the app's pages. App code can also keep comments on its own records, such as a document, and show them in its own UI. Define a kind of subject for them. The overlay, the Console section, and the overlay tools of [ViteHub MCP](/docs/development/mcp) never show or change them.

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

```ts [server/api/docs/[id]/comments.post.ts]
import { defineEventHandler, getRouterParam, readBody } from 'h3'
import { comments } from '../../../comments'
import { canComment, requireUser } from '../../../utils/docs'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = getRouterParam(event, 'id')!
  if (!await canComment(user, id)) throw new Error('You cannot comment on this document.')
  const { body, quote, version } = await readBody<{ body: string, quote: string, version: number }>(event)
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

- `metadata` keeps what your UI needs, such as where the comment sits in the document: at most 50 keys with string, number, boolean, or `null` values.
- `revision` is the version of the subject that the thread starts on. `comments.list({ subject, revision: { lte: 3 } })` lists the threads of version 3 and of every version before it, so a comment stays with the document until someone resolves it.
- A message with attachments may have no text. On other subjects, `emptyBody` decides.
- Threads are numbered 1, 2, 3, … in the scope of their subject. Deleting threads or a whole scope never reuses those numbers. `getByNumber('doc:42', 3)` finds "#3".
- `removeScope('doc:42')` deletes every thread of the document, for example when the document goes away.
- The runtime methods are trusted server API, so check access in your route. When you call `comments.can()`, `authorize` gets the `thread` or the `subject`.

## Choose the Database

`comments()` keeps threads in a database that you point it to, and creates its tables there on first use. There is no migration to run, and no Database to define. The tables start with `vitehub_comment`, so they sit next to your app's own tables. A [ViteHub app](/docs/comments/with-vite-hub) keeps threads in a ViteHub Database instead.

Give `database` a string that says where the database is. The string names a variable or a binding, so the URL and its token stay out of the build:

| `database` | Where threads go |
| --- | --- |
| Not set | The first one the server finds when it runs: `DATABASE_URL`, `TURSO_DATABASE_URL`, then the Cloudflare D1 binding `DB`. A Postgres `DATABASE_URL` is skipped. |
| `'d1:COMMENTS'` | The Cloudflare D1 binding `COMMENTS`. Comments adds the binding to the build. |
| `'env:COMMENTS_DATABASE_URL'` | The libSQL URL in that variable, such as a Turso database. Its token is in the URL, or in `COMMENTS_AUTH_TOKEN`. |
| `'file:./data/comments.sqlite'` | A SQLite file on Node, relative to the directory that the server starts in. |
| `'libsql://…'` | That libSQL URL. A token in it ends up in the build, so use `env:` for one with a token. |

On Node, the runtime variables can also contain a `file:` location. Comments chooses the connector for the server's runtime, so the file path stays out of the build. Workers support D1 and remote libSQL databases. A static `file:` or `:memory:` location fails the Worker build with `DATABASE_UNSUPPORTED_URL`.

On `vite dev`, threads go to `.vitehub/data/comments.sqlite` in the project, with a `.gitignore` next to it. That keeps the threads you write on your computer out of your app's database. Two strings change it: a `file:` path is used as it is, and an `env:` variable is used when it is set.

With a Nitro Cloudflare preset, such as `NITRO_PRESET=cloudflare_module`, `vite dev` runs the server in workerd, which cannot open that file. There, threads go to a local D1 binding `COMMENTS` that Miniflare keeps in `.wrangler/state`, or to the `database` option when you set one. An unset `env:` variable falls back to that local D1 database. Set Nitro's `devServer.runner` to `node-worker` to keep the file.

When the server finds no database, the API answers `500`, and the server log shows [`DATABASE_NOT_CONNECTED`](/docs/database/limits-and-errors#database_not_connected) with what it looked for. A string that Comments cannot use, such as a Postgres URL, fails the build with [`DATABASE_UNSUPPORTED_URL`](/docs/database/limits-and-errors#database_unsupported_url). Postgres comes in a later version.

### Turso and other libSQL databases

Set the URL and token on the server. Comments finds them without an option:

```bash [.env]
TURSO_DATABASE_URL=libsql://comments-acme.turso.io
TURSO_AUTH_TOKEN=...
```

When your app uses `DATABASE_URL` or `TURSO_DATABASE_URL` for another database, give Comments its own variable: `comments({ database: 'env:COMMENTS_DATABASE_URL' })`.

### Cloudflare D1

```ts [vite.config.ts]
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

Comments adds the `COMMENTS` binding to the Wrangler config of the build, without a database id, and `wrangler deploy` creates the D1 database. When `wrangler.jsonc` already has a binding with that name, Comments uses yours, with its id. Name a binding `DB` and you can leave out `database`.

To try the Worker on your computer, run `pnpm wrangler dev` after the build, or `NITRO_PRESET=cloudflare_module pnpm vite dev` during development. Both keep a local D1 database in `.wrangler/state`.

Add the variables of [Sign in with GitHub](#sign-in-with-github) as Worker secrets, such as `pnpm wrangler secret put VITEHUB_GITHUB_CLIENT_ID`.

### A SQLite file

```ts [vite.config.ts]
export default defineConfig({
  plugins: [comments({ database: 'file:./data/comments.sqlite' })],
})
```

Comments opens the file with Node's built-in `node:sqlite`, so there is no driver to install. Keep the file on a disk that survives deploys and restarts, such as a Docker volume, and run one server process with it.

### A ViteHub Database

In a [ViteHub app](/docs/comments/with-vite-hub), Comments adds four tables, `vitehub_comment_threads`, `vitehub_comment_messages`, `vitehub_comment_counters`, and `vitehub_comment_forge`, to a Database at build time. Without the `database` option, it uses the Database named `default`, else the only Database. `vitehub({ database: true })` gives an app without a Database Definition a `default` Database. The [CMS](/docs/cms) adds one too.

To use another Database, give its name:

```ts [server/comments.ts]
export const comments = defineComments({
  database: 'team',
})
```

ViteHub reads the name from the file without running it, so write it as a string literal. The build fails with `DATABASE_INVALID_CONTRIBUTION_TARGET` when the named Database does not exist, or when the app has several Databases and none is named `default`. The tables use SQLite, so the Database must be SQLite, libSQL, or D1.

Run `vitehub db generate` and `vitehub db migrate` after you add `server/comments.ts` or change `database`. See [Apply migrations](/docs/database/configure#apply-migrations).

## Upgrade to one model

Comments had two models with two sets of tables: the live-site model of the overlay (`vitehub_comment_threads` with `number`, `page`, and `created_by`, `vitehub_comments`, and `vitehub_comment_scope_counters`), and the model of the comment operations. Now both use one model, so a Database with the live-site tables must move them once. The tables share the name `vitehub_comment_threads`, so the move happens in place:

1. It renames the old threads table to `vitehub_comment_threads_live`.
2. It creates `vitehub_comment_threads`, `vitehub_comment_messages`, `vitehub_comment_counters`, and `vitehub_comment_forge`, when they are not there.
3. It copies every thread and comment. It deletes nothing: `vitehub_comment_threads_live`, `vitehub_comments`, and `vitehub_comment_scope_counters` stay for you to check. Drop them yourself later.

All statements run in one batch or transaction, so a failure changes nothing.

| Live-site field | One model |
| --- | --- |
| `number` | `n`, the same number |
| scope `pages` and `page` | subject `{ kind: 'page', id: page }`, scope `site` |
| scope `kind:id`, such as `drop:42` | subject `{ kind: 'drop', id: '42' }`, scope `drop:42`. Define the kind with `defineCommentSubject({ kind: 'drop', scope: id => \`drop:${id}\` })` so new threads take the same scope. The `page` of such a thread stays only in the backup table. |
| other scopes | subject `{ kind: scope, id: page }` |
| `anchor` | an `element` anchor with the same `field`, `label`, `page`, and `viewport` hints; `{ kind: 'page' }` when it was `null` |
| `created_by`, `resolved_by` | `author`, `resolvedBy`. Guests keep their `guest:` ids. |
| `comments[]` | `messages[]`, with the same ids, so pull request links in `vitehub_comment_forge` follow |
| `mentions: { id, name }[]` | `mentions: id[]` |
| `metadata`, `context` | the same |
| `vitehub_comment_scope_counters` | `vitehub_comment_counters`: numbers continue after the highest one each scope handed out |

Stop comment writes while you migrate, including writes from older app instances, and back up the Database first.

**A ViteHub Database.** The migration must go in the migration history, so `vitehub db generate` does not try to change the old table itself:

1. Run `vitehub db generate --custom --name comments_one_model`. It writes an empty SQL migration and the snapshot of the new tables.
2. Print the SQL and put it in that file, one statement before each `--> statement-breakpoint`:

```bash
node --input-type=module -e "import { commentsMigrationSql } from 'vite-hub/comments/database'; console.log(commentsMigrationSql({ from: 'live' }).join(';\n--> statement-breakpoint\n') + ';')"
```

3. Run `vitehub db migrate --dry-run`, then `vitehub db migrate`.

A Database that already has the tables of the comment operations gets the new `metadata`, `context`, and `revision` columns and the `vitehub_comment_forge` table from a normal `vitehub db generate`.

Until the tables move, every Comments request fails with [`COMMENTS_R0019`](/docs/comments/operations/limits-and-errors) and status `503`. Its `fix` names this migration. Comments reads the tables once per server process, so after `vitehub db migrate` the next request works without a restart.

**A Database that `comments()` opens itself.** The SQLite file, the `env:` libSQL URL, and the D1 binding of `comments()` belong to Comments, so it moves them itself: before the first query of each server process, it runs `migrateComments()` and creates the tables that are missing. Requests that arrive during the move wait for it. To move the tables before a deploy instead, run `migrateComments(db)` with a Drizzle database of it. It reads the tables first, so a second run does nothing:

```ts [scripts/migrate-comments.ts]
import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { migrateComments } from '@vite-hub/comments/database'

const db = drizzle(createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN }))
console.log(await migrateComments(db))
// { from: 'live', statements: [...], backup: 'vitehub_comment_threads_live' }
```

For Cloudflare D1, you can also write the SQL to a file and run it with `wrangler d1 execute COMMENTS --remote --file comments-one-model.sql`.

`migrateComments(db, { dialect: 'postgresql' })` adds the new columns to Postgres tables of the comment operations. The live-site model had no Postgres tables.

## Mention people

Type `@` in a comment to mention someone. The server checks every mention: the id must be a real person, the text must name them with `@` and their name, and `canMention` must allow them. Where people come from:

| App | `@` suggests |
| --- | --- |
| With `people` | The people that `people` finds. |
| With [ViteHub Auth](/docs/auth) | The users of Auth. |
| Neither | The people who wrote earlier comments in threads that the writer may read. |

By default, a person may be mentioned in a thread only when they may read it: `authorize({ action: 'read', user: person, thread })`. Suggestions leave out the others, and a message that mentions one fails with `COMMENTS_INVALID_INPUT`. Change it with `canMention`:

```ts [server/comments.ts]
import { defineComments } from 'vite-hub/comments'
import { team } from './utils/team'

export const comments = defineComments({
  people: {
    search: query => team.filter(person => person.name.toLowerCase().includes(query.toLowerCase())),
    byIds: ids => team.filter(person => ids.includes(person.id)),
  },
  // Only people of the same team, whatever they may read.
  canMention: ({ user, person }) => person.team === user?.team,
})
```

`people.search` gets the text after `@`. Return the full records: `canMention` and `authorize` read their fields, and Comments sends only `id`, `name`, and `image` to the browser. It returns at most 20 people. A message keeps at most 20 mentions, as ids.

## Notify mentioned people

`onMention` runs once for each saved message that mentions people, with those people. An edit runs it only for the people it adds. It runs after the answer, through `waitUntil` where the host has it, and a failure is logged and never fails the comment. Compose it with [Email](/docs/email):

```ts [server/comments.ts]
import { defineComments } from 'vite-hub/comments'
import { email } from 'vite-hub/email/server'
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

The server checked each person in `users`. `link` is the app path that opens the thread, such as `/pricing?comment=3` for a page, or what the [subject's `link`](#comments-in-your-own-ui) returns.

`onComment({ thread, message, mentions })` runs after each new thread and each reply saves, before the answer. Keep it short, or send the work to a [Queue](/docs/queue). Comments logs an error that it throws and still returns the saved comment.

## Attach files

A message can keep files: `attachments` holds their keys. The `comments.upload` operation, or `POST /api/_vitehub/comments/attachments`, stores a file and returns `{ key, name, type, size }`; pass the key in `attachments` of `comments.create` or `comments.reply`. A message with attachments may have no text. Uploads need `write` on the subject.

Without an option, Comments stores the file in the [Blob](/docs/blob) store of the app, under `comments/<id>/<name>`. To store files yourself, such as with the other files of your app, return the key from `storeAttachment`:

```ts [server/comments.ts]
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

Comments checks the size and the type before it calls `storeAttachment`: at most 5 MB of PNG, JPEG, GIF, WebP, AVIF, PDF, or plain text. See [Limits](/docs/comments/limits-and-errors#limits). Without Blob and without `storeAttachment`, uploads fail with `COMMENTS_R0014`.

**Show attachments.** `GET /api/_vitehub/comments/attachments/<key>` answers the file to a person who may read a thread with a message that lists the key. Anyone else, and a key that no message lists yet, gets `404` with `COMMENTS_R0020`. It reads the file with `readAttachment`, else from the Blob store; with `storeAttachment` and no `readAttachment`, it answers `COMMENTS_R0021`. Build the URL with `transport.attachmentUrl(key)` of [`createRestTransport()`](/docs/comments/server-api#rest-transport), or `commentAttachmentUrl(key)`, and use it as the `src` of a thumbnail. The `comments.attachment` operation returns the same file in Base64, for the CLI.

The answer keeps a browser from running the file:

| Header | Value |
| --- | --- |
| `Content-Type` | The stored type, when Comments attaches that type. Any other type, such as SVG or HTML from your own `storeAttachment`, answers as `application/octet-stream`. |
| `Content-Disposition` | `inline` for PNG, JPEG, GIF, WebP, and AVIF; `attachment` for PDF, text, and every other type, with the file name. |
| `X-Content-Type-Options` | `nosniff` |
| `Content-Security-Policy` | `default-src 'none'; sandbox` |
| `Cache-Control` | `private, max-age=300` |

A key is the right to read through any thread that lists it, so keep keys hard to guess. The keys of the Blob store carry a random id. Without `readAttachment`, Comments reads only its own uploads: it saves an ownership record at `comments/<uuid>/.upload.json` with the exact file key and a SHA-256 digest, and checks both before answering the file. A message that lists an app file, even at a matching `comments/<uuid>/<name>` path, answers `COMMENTS_R0020`. Replacing an uploaded file with different contents also makes it unreadable.

Keep these ownership records with the files when copying or backing up Blob storage. Uploads from versions without records must be uploaded again, or read through an app's `readAttachment` hook that checks their access.

## Turn comment mode on and off

Comments is a ViteHub page tool. Comment mode starts when a person opens the [Console](#comment-as-the-console-team), or on any page with the `?vitehub` query, such as `https://example.com/pricing?vitehub`. `?vitehub=comments` does the same. The page then loads the page tools loader, which calls `GET /_vitehub/page/session`. That route runs the visitor check of each page tool. Comments allows the overlay when `authorize` allows `read`, or when it can offer GitHub sign-in or account switching. The sign-in prompt grants no access to threads. The route then sets `vitehub-tools=1` for 30 days, so every other page of the site opens in comment mode too. When no tool allows the person, the route sets `vitehub-tools=0` and the loader stops. The cookie is only a hint. Every API request checks access again.

The Comments toolbar is one segment of the ViteHub tools pill at the bottom of the page. When the app has the Console, the pill also shows a **Console** link for people that the Console lets in. The **×** button of the pill, **Turn off ViteHub tools**, ends comment mode. It turns all page tools off: it sets `vitehub-tools=0`, removes the query, and removes the pill.

| Key | Action |
| --- | --- |
| <kbd>C</kbd> | Turn **Comment** on or off. While it is on, a click anywhere starts a thread. |
| <kbd>E</kbd> | Turn **Edit** on or off, when the app has Content. |
| <kbd>Esc</kbd> | Close the open thread, or turn **Comment** and **Edit** off. |
| <kbd>⌘</kbd> <kbd>Enter</kbd> | Send the comment. |

Every HTML page gets a short inline script before `</body>`, the page tools bootstrap. It is the same for every visitor, so the page keeps its cache headers. In the browser, it loads the page tools loader only with a hint: the `?vitehub` query, `vitehub-tools=1`, or the [Auth session marker](/docs/auth/configure#session-marker-cookie) of a person who just signed in. Visitors without a hint make no request. With the hint, the server instead adds one loader script, `<script type="module" src="/_vitehub/page/assets/loader.js?v=13">`, and sends the page with `cache-control: private, no-store`. The loader imports the overlay only for people that the session route allows. With an application base such as `/portal/`, the loader and session URLs start with `/portal/_vitehub/page/`. Paths under `/_vitehub` and `/api` within that application never get the page tools.

- Nitro 3 apps get the script from the server response. Nuxt 4 apps get it through Nitro's `render:html` hook, and the loader also when a route returns the page as a `Response`.
- A single-page app whose `index.html` Vite serves or builds gets the bootstrap in `index.html`.
- Prerendered pages get the bootstrap when they are rendered, so a host or a CDN that serves them as static files still shows the overlay. The server does not add a second script to a page that has one.

### Apps below a base path

When the app has a Vite `base`, such as `base: '/docs/'`, or a Nuxt `app.baseURL`, Comments and the page tools follow it. The session route is `/docs/_vitehub/page/session`, the loader is `/docs/_vitehub/page/assets/loader.js`, and the Comments API is `/docs/api/_vitehub/comments`. The loader and the overlay find the base from their own URL, so you do not configure it twice. Paths under `/docs/_vitehub` and `/docs/api` never get the loader.

ViteHub registers these routes below the part of the base that Nitro does not add. When you also set Nitro `baseURL` to the same path, as Nuxt does for `app.baseURL`, Nitro adds the base and ViteHub adds nothing. A base that you set with `NUXT_APP_BASE_URL` when the server starts also works on Nuxt 4: the loader tag takes the base of each request.

A prerendered site needs no extra route. Its pages have the bootstrap, so a Nuxt app on Cloudflare Workers can serve them as static assets, without `assets.run_worker_first`. Only the session route and the Comments API run in the Worker.

The overlay is a custom element with a shadow root. Your CSS does not change it, and its CSS does not change your page.

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
- An edit needs `write` from Comments and `write` from the [Content `authorize`](/docs/content/configure#access) policy for that document. Guests can edit only when the Content policy allows `user: null`.
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

Comments keeps the GitHub ids in the `vitehub_comment_forge` table. The `comments()` plugin creates it with the other tables. With `vitehub()`, run `vitehub db generate` and `vitehub db migrate` after you add `forge`. On Cloudflare, the API routes keep the Worker running until GitHub answers. When server code changes threads, pass `comments.flush()` to `waitUntil`.

App mentions and thread numbers stay plain text on GitHub: `@ada` does not notify a GitHub user, and `#3` does not link issue 3.

## Triage in the Console

The Console has a Comments section at `/_vitehub/comments`. It lists the 500 threads with the newest activity, open threads first: first comment, page, author, replies, status, and last activity. Select a thread to read its comments in order, with the page context under them. **Open on page** opens its `?vitehub=comments#comment-<id>` link in a new tab. Reply and resolve on the page, where the context is.

`vitehub inspect` lists the Comments route, the `comments` Realtime Definition when presence runs, and the tables in the Database.

## Fix comments with an Agent

The Console serves [ViteHub MCP](/docs/development/mcp) at `/_vitehub/mcp`. An Agent that connects to it lists the open threads, reads the page context and source files of each one, then replies and resolves the thread after it changes the code. It acts with your Console access, and `authorize` applies to each call.

An app with its own MCP server can register the same tools: `commentsMcpTools(comments)` from `vite-hub/comments/runtime` returns them with a JSON Schema and a `call(input, { user })` function each.

Your server must authenticate `user` before calling a tool; pass `null` for an anonymous caller. Without an event, the tools use this user even when Comments defines `identify`. To use request-based Comments identity, pass `call(input, { user, event })` with the H3 request event. Pass Console access through `commentsMcpTools(comments, { consoleSession })`: a `false` result or a failed read denies access before `identify` or `authorize`. Otherwise `identify` takes precedence. Without `identify`, the Console reader is used, then the Auth reader in `{ session }` if no Console reader is supplied, or `user` when neither reader is supplied. Browser guest headers name an author only when `authorize` permits the anonymous caller.
