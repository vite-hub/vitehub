---
title: Comments server API
description: "The comments() plugin, defineComments() options, runtime methods and error codes, thread and anchor types, HTTP routes, and Content field addresses."
navigation.title: Server API
navigation.order: 5
icon: i-lucide-code-2
---

## Public imports

| Import | Use |
| --- | --- |
| `comments` from `@vite-hub/comments/vite`, also its default export | The Vite plugin for an app without `vite-hub`. See [`comments()` options](#comments-options). |
| `defineComments` from `vite-hub/comments` | Define Comments in `server/comments.ts`. Export the result as `comments`. |
| `Comments`, `CommentThread`, `CommentMessage`, `CommentAnchor`, `CommentUser`, `CommentSubject`, `CommentsErrorCode` from `vite-hub/comments` | Types for the runtime, threads, messages, anchors, people, subjects, and error codes, shared with the browser client and comment operations. |
| `defineCommentSubject` from `vite-hub/comments` | Your own subject kind, with its numbering scope. See [Comments in your own UI](/docs/comments/configure#comments-in-your-own-ui). |
| `migrateComments`, `commentsMigrationSql` from `vite-hub/comments/database` | Move a Database from the live-site tables to one model. See [Upgrade to one model](/docs/comments/configure#upgrade-to-one-model). |
| `normalizeCommentPage` from `vite-hub/comments` | The page key that Comments stores for a path. |
| `installComments` from `vite-hub/comments/server` | Connect a definition to a Drizzle Database in tests or outside ViteHub. The generated Nitro plugin calls it on the first Comments call. |
| `contentField`, `formatContentField`, `parseContentField` from `vite-hub/content/client` | Write and read [Content field addresses](#content-field-addresses). |
| `connectRealtimeRoom` from `@vite-hub/realtime/client` | Join a Realtime room for presence, as the overlay does for [presence rooms](#presence-rooms). |

Without `vite-hub`, import the same names from `@vite-hub/comments`. `@vite-hub/comments/vite` also exports `hubComments()`, the build integration that `vitehub()` adds for you.

## `comments()` options

`comments()` turns Comments on in a Vite app without `vite-hub`. It uses `server/comments.ts` if present. It adds [Nitro](https://nitro.build) unless the app adds `nitro()`. With `vitehub()`, it does nothing, because `vitehub()` runs Comments.

| Option | Default | Behavior |
| --- | --- | --- |
| `database` | `DATABASE_URL`, `TURSO_DATABASE_URL`, or the D1 binding `DB`, read at runtime. `.vitehub/data/comments.sqlite` on `vite dev`. | Where threads go: `'d1:BINDING'`, `'env:VARIABLE'` with a libSQL URL, `'file:./path.sqlite'` on Node, or a `libsql://` URL. Comments creates its tables there on first use. See [Choose the Database](/docs/comments/configure#choose-the-database). |

## `defineComments()` options

| Option | Default | Behavior |
| --- | --- | --- |
| `authorize({ user, actor?, action, thread?, subject? })` | GitHub users who can push to the repository, and users of other sign-ins, may do everything. Guests only on the dev server. | Return `true` to allow. `action` is `read`, `write`, `resolve`, or `delete`. See [Decide who can comment](/docs/comments/configure#decide-who-can-comment). |
| `identify({ event })` | On pages, the ViteHub Auth session, else [Sign in with GitHub](/docs/comments/configure#sign-in-with-github). Through the Console, the CLI, and MCP, the Console caller. | Return the request's user, with a string `id`, or `null`. `identify` and `authorize` then decide on every surface, instead of Console access. See [Use your own login](/docs/comments/configure#use-your-own-login). |
| `database` | `default`, else the only Database | In a ViteHub app, the Database name as a string literal. Any other value fails the build with `COMMENTS_B0004`. `comments()` takes its own [`database`](#comments-options). See [Choose the Database](/docs/comments/configure#choose-the-database). |
| `subjects` | `page` and `content` | More subject kinds, from `defineCommentSubject({ kind, scope, emptyBody?, link? })`. |
| `people` | ViteHub Auth users, else authors of earlier comments | `{ search(query, limit), byIds(ids) }`: where `@` finds people. See [Mention people](/docs/comments/configure#mention-people). |
| `canMention({ user, person, thread?, subject? })` | `person` may read the thread | Return `true` when `user` may mention `person` there. |
| `onMention({ users, message, thread, link? })` | None | Runs once per message that mentions people for the first time. See [Notify mentioned people](/docs/comments/configure#notify-mentioned-people). |
| `onComment({ thread, message, mentions })` | None | Runs after a new thread or reply saves, before the response. Errors are logged, not returned. |
| `storeAttachment(file, { user, subject? })` | The app's Blob store | Stores an uploaded file and returns its key. See [Attach files](/docs/comments/configure#attach-files). |
| `forge` | None | `{ provider: 'github', repository?, pullRequest?(thread), token?(author), title?, apiUrl? }`. Posts threads to the preview's pull request. See [Post comments to the pull request](/docs/comments/configure#post-comments-to-the-pull-request). |

## Runtime methods

Import `comments` from `server/comments.ts` in server routes, plugins, and Agent tools. Each method except `can()` returns `[error, data]`.

::warning
These methods are trusted server API. They do not call `authorize`.
::

```ts [server/api/threads/[id]/resolve.post.ts] fragment
import { defineEventHandler, getRouterParam } from 'h3'
import { comments } from '../../../comments'

export default defineEventHandler(async (event) => {
  const [error, thread] = await comments.resolve(getRouterParam(event, 'id')!, {
    by: { id: 'release-bot', name: 'Release bot' },
  })
  if (error) throw error
  return thread
})
```

| Method | Returns | Error codes |
| --- | --- | --- |
| `list({ subject?, page?, scope?, status?, revision?, limit?, before? })` | Threads with their messages, newest activity first. `revision: { lte: 3 }` keeps threads of subject version 3 and earlier. `limit` is 200 by default, 500 at most. | `COMMENTS_NOT_INSTALLED`, `COMMENTS_INVALID_INPUT` |
| `get(id)` | One thread. | `COMMENTS_NOT_INSTALLED`, `COMMENTS_NOT_FOUND` |
| `getByNumber(scope, n)` | Thread `#n` of a scope, such as `site`. | `COMMENTS_NOT_INSTALLED`, `COMMENTS_NOT_FOUND` |
| `getByMessage(messageId)` | The thread holding a message. | `COMMENTS_NOT_INSTALLED`, `COMMENTS_NOT_FOUND` |
| `create({ subject?, page?, anchor?, context?, metadata?, revision?, requestId?, body, author, actor?, mentions?, attachments? })` | The new thread, with its first message and the next number in its scope. Give `subject`, or `page` for a page subject. `anchor` defaults to `{ kind: 'page' }`. Runs `onComment` and `onMention`. With `requestId`, a retry by the same author for the same subject returns the first thread and runs no hooks. Another author or subject with that key gets `COMMENTS_INVALID_INPUT`. | `COMMENTS_NOT_INSTALLED`, `COMMENTS_INVALID_INPUT` |
| `reply(threadId, { body, author, actor?, mentions?, attachments? }, { allowResolved? })` | The new message. A resolved thread fails with `COMMENTS_RESOLVED`, unless `allowResolved` is `true`; then it stays resolved, and the comment parts list it with open threads until someone resolves it again. | `COMMENTS_NOT_INSTALLED`, `COMMENTS_NOT_FOUND`, `COMMENTS_INVALID_INPUT`, `COMMENTS_RESOLVED` |
| `resolve(threadId, { by })` | The thread, with `status: 'resolved'`, `resolvedBy`, and `resolvedAt`. | `COMMENTS_NOT_INSTALLED`, `COMMENTS_NOT_FOUND` |
| `reopen(threadId)` | The thread, with `status: 'open'`. | `COMMENTS_NOT_INSTALLED`, `COMMENTS_NOT_FOUND` |
| `remove(threadId)` | Nothing. Deletes the thread and its messages. | `COMMENTS_NOT_INSTALLED`, `COMMENTS_NOT_FOUND` |
| `removeMessage(messageId)` | Nothing. Deleting the first message deletes the thread. | `COMMENTS_NOT_INSTALLED`, `COMMENTS_NOT_FOUND` |
| `edit(messageId, { body, mentions? })` | The message with new text and `editedAt`. | `COMMENTS_NOT_INSTALLED`, `COMMENTS_NOT_FOUND`, `COMMENTS_INVALID_INPUT` |
| `removeScope(scope)` | `{ removed }`, the number of threads deleted with their messages. | `COMMENTS_NOT_INSTALLED` |
| `people({ query, user, thread?, subject?, limit? })` | Up to 20 people whose name contains `query` and whom `user` may mention there. | `COMMENTS_NOT_INSTALLED` |
| `can({ user, action, thread?, subject? }, gate?)` | `true` when `authorize` allows the action. Without `authorize`, [the default policy](/docs/comments/configure#decide-who-can-comment) decides; `gate` says what your server already checked: `{ development, console }`. | None |
| `sync(threadId)` | Nothing. With `forge`, syncs the thread's pull request comments now, and retries failed posts. | None |
| `flush()` | Nothing. Waits for pending pull request syncs and `onMention` calls. | None |

Comments normalizes `page` before storing or comparing: it drops the query and hash, joins repeated slashes, and removes a trailing slash. `/pricing/?plan=pro#faq` becomes `/pricing`.

`COMMENTS_NOT_INSTALLED` means the method ran before the server installed Comments, such as at import time. See [Limits and errors](/docs/comments/limits-and-errors).

Open pages see server-side changes on tab focus, or within 30 seconds while visible.

## Types

### Threads and messages

The server API, comment operations, browser client, and overlay share these types.

```ts
import type { CommentAnchor, CommentContext } from 'vite-hub/comments'

interface CommentThread {
  id: string
  scope: string                   // the numbering scope: 'site' for pages and Content
  n: number                       // 1, 2, 3, … in the order threads start in their scope
  subject: CommentSubject         // what the thread is about, such as { kind: 'page', id: '/pricing' }
  anchor: CommentAnchor           // where it sits; { kind: 'page' } for the whole subject
  metadata?: CommentMetadata      // fields that app code keeps on the thread
  context?: CommentContext        // what the person saw, for threads that the overlay started
  revision?: number               // the version of the subject that the thread started on
  status: 'open' | 'resolved'
  author: CommentUser
  actor?: CommentActor            // the Agent that wrote it for `author`
  resolvedBy?: CommentUser
  resolvedAt?: number             // milliseconds since the epoch
  createdAt: number
  updatedAt: number
  messages: CommentMessage[]      // oldest first; the first message opened the thread
  forge?: CommentForgeLink | null // with the forge option: its pull request comment
}

interface CommentMessage {
  id: string
  threadId: string
  body: string                    // Markdown, at most 10,000 characters; empty only with attachments or emptyBody
  mentions: string[]              // ids of the people that body names with @, at most 20
  attachments: string[]           // keys of stored files, at most 10
  author: CommentUser
  actor?: CommentActor
  createdAt: number
  editedAt?: number
}

interface CommentUser {
  id: string                      // a guest id starts with 'guest:'
  name?: string
  image?: string
  guest?: boolean                 // true for a guest that named itself in the browser
}

interface CommentActor {
  id: string
  name?: string                   // the comment parts show the Agent in place of `author`: "Claude (Ana Ruiz)"
  image?: string                  // the Agent's logo, its avatar in the comment parts
}

interface CommentSubject {
  kind: string                    // 'page', 'content', or a kind of your own
  id: string                      // an app path for 'page'
}

interface CommentForgeLink {
  repository: string              // 'owner/name'
  pullRequest: number
  state: 'posted' | 'pending' | 'failed'
  url?: string                    // the comment of the first message
  error?: string                  // why GitHub refused it
  postedAs?: 'author' | 'app'
}

// At most 50 keys of up to 64 characters. Strings hold at most 4,000 characters.
type CommentMetadata = Record<string, string | number | boolean | null>
```

Each message keeps a copy of its author, so the name stays when the Auth user changes or is deleted.

### Users

`authorize`, `can()`, and `people()` get the request's user, or `null` when anonymous.

```ts
type CommentsUser = Record<string, unknown> & {
  id: string
  github?: CommentsGitHubAccess   // set for a person who signed in with GitHub
}

interface CommentsGitHubAccess {
  login: string                   // their GitHub username
  repository?: string             // the repository of the build, 'owner/name'
  write: boolean                  // whether they can push to it, checked every 5 minutes
}
```

### Anchors

An anchor says where a thread sits. The overlay writes an `element` anchor with hints on click. The `@vite-hub/comments/client` browser client also writes `text`, `area`, and `image` anchors.

```ts
type CommentAnchor =
  | { kind: 'page' }
  | {
      kind: 'element'
      selector: string            // CSS path
      x: number                   // pin position in the element box, in thousandths
      y: number
      field?: string              // data-content-field address, such as 'about#hero.title'
      label?: string              // tag and the first 40 characters of the element text
      page?: { x: number, y: number } // thousandths of the document width, CSS pixels from the top
      viewport?: { width: number }    // viewport width when the pin was dropped
    }
  | { kind: 'text', selector: string, exact: string, prefix: string, suffix: string }
  | { kind: 'area', selector: string, x: number, y: number, width: number, height: number }
  | { kind: 'image', selector: string, x: number, y: number, width?: number, height?: number }
```

To place a pin, the overlay uses the first of these that finds an element:

1. `field`: the element with that `data-content-field`. When the field shows more than once, the CSS path picks the copy.
2. `selector`, when its element still has the same `label`.
3. The first element with the same tag and `label`.
4. The `page` point. The pin gets a dashed border, and the thread says "element moved".

The overlay shows only threads with an `element` anchor. `selector` stops at the closest ancestor with an `id` or Content field, so give stable `id` values to sections that pins should follow.

Pins move again when the window resizes, the page changes, or a client router changes the URL. A pin on a hidden element hides too.

### Page context

When someone starts a thread, the overlay records what they saw, so a teammate or Agent can find the code to change. The server adds the build and source files.

```ts
interface CommentContext {
  url: string                     // origin and pathname only; no credentials, query, or hash
  title?: string
  route?: string                  // Vue Router route pattern, such as '/blog/:id(.*)*'
  element?: {
    tag: string
    id?: string
    testId?: string               // data-testid, data-test, or data-cy of the element or an ancestor
    role?: string                 // the role attribute, or the role of the tag
    name?: string                 // aria-label, alt, title, or the first 120 characters of the text
    classes?: string[]
  }
  components?: Array<{ name: string, files?: string[] }>  // outermost first
  environment?: {
    viewport: { width: number, height: number }
    devicePixelRatio: number
    userAgent: string
    language?: string
    colorScheme?: 'light' | 'dark'
    timeZone?: string
  }
  build?: { commit?: string, branch?: string, repository?: string, pullRequest?: number }
}
```

- **Components:** the overlay walks the Vue component tree from the app container to the element. Production builds keep that tree, so this needs no Vue devtools and no HTML changes. Pages Vue does not render get none.
- **URL:** the overlay drops the query and hash. The server checks that the URL matches the request origin and thread page, then stores only the origin and normalized pathname.
- **Files:** a production build keeps only the component name, which for `<script setup>` is its file name. At build time, Comments lists the project's `.vue` files by name, and the server adds each name's files to the thread. Nuxt also uses its resolved component registry, with custom prefixes, directories, and client/server suffixes. A name shared by two files, such as `index`, gets both, unless Nuxt resolves it to one. The list skips `node_modules`, `dist`, `public`, and dot directories. Nuxt rescans refresh the names. In other Vite apps, restart the server after you add a component.
- **Build:** the commit and branch come from the host or CI at build time (`VERCEL_GIT_COMMIT_SHA`, `WORKERS_CI_COMMIT_SHA`, `CF_PAGES_COMMIT_SHA`, `COMMIT_REF`, or `GITHUB_SHA`), else from Git. The GitHub repository and pull request come from the same place, for [`forge`](/docs/comments/configure#post-comments-to-the-pull-request). The browser cannot set them or the file names.

The Console shows the context in each thread's fields. `describeCommentContext(context)` from `vite-hub/comments` returns the same label and value pairs.

## HTTP routes

The overlay and [`createRestTransport()`](#rest-transport) call the Comments API at `/api/_vitehub/comments`. Responses are JSON, `{ data }` or `{ error }`, with `cache-control: private, no-store`. `error` has `code`, `why`, `fix`, and `docs`. Threads and messages use the [types above](#threads-and-messages), and a thread adds `can: { comment, resolve, delete }` for the reader. Routes that return threads or messages also send `people`, the mentioned people with names.

The routes run the same actions and checks as the [comment operations](/docs/comments/operations/server-api), for the request's user. They need no Console access, so guests and `identify` users, such as share link readers, can use them. They serve threads on every subject `authorize` lets the reader see, not only `page`.

| Route | Needs | Does |
| --- | --- | --- |
| `GET /session?page=` | None | Returns `{ user, can: { read, comment, resolve, delete }, realtime, content }` for the page. Adds `signIn: { provider, url }` when GitHub sign-in is possible, and `github` with `signOut` once signed in. `can.delete` means the person may delete others' comments. It sets no cookie: `GET /_vitehub/page/session` owns the `vitehub-tools` hint. |
| `GET /threads` | `read` | Lists readable threads, like `comments.list`. Search parameters: `page`, or `subjectKind` with `subjectId`, or `subjectKind` alone; `status`, `mine`, `mentions`, `revision` (at most this revision), `limit`, and `beforeId` with `beforeUpdatedAt` for the next page. `403` when the reader may not read the filter. |
| `GET /threads/:id` | `read` | One thread, or `null` when it is missing or the reader may not read it. |
| `GET /scopes/:scope/threads/:n` | `read` | Thread `#n` of a scope, such as `site`, or `null`. |
| `POST /threads` | `read` and `write` | Starts a thread from `comments.create` input: `{ subject, anchor?, body, mentions?, attachments?, metadata?, revision?, requestId? }`. `page` may replace `subject`, and a page thread may carry the overlay's `context`. `mentions` are ids. |
| `POST /threads/:id/comments` | `write` | Replies with `{ body, mentions?, attachments? }`. Returns the message as `data` and the thread as `thread`. A resolved thread returns `COMMENTS_RESOLVED`. |
| `PATCH /threads/:id/comments/:messageId` | Your own message | Changes its text with `{ body, mentions? }`. Returns the thread. |
| `POST /threads/:id/resolve`, `POST /threads/:id/reopen` | `resolve` | Resolves or reopens the thread. |
| `DELETE /threads/:id` | `write` when every message is yours, else `delete` | Deletes the thread. Returns `null`. |
| `DELETE /threads/:id/comments/:messageId` | `write` for your own message, `delete` for others | Deletes one message, or the thread for its first message. Returns the thread or `null`. |
| `POST /attachments` | `write` | Stores `{ name, type, data, subject? }`, `data` in Base64, like `comments.upload`. Returns `{ key, name, type, size }`. |
| `GET /attachments/:key` | `read` on a thread with a message that lists the key | Returns the file. See [Attach files](/docs/comments/configure#attach-files). |
| `GET /people?q=` | `read` | Returns `@` suggestions. With `thread`, `page`, or `subjectKind` and `subjectId`, only people who may be mentioned there. `limit` is at most 20. |
| `GET /fields?page=&field=` | Page `write`, and Content `write` | Reads one Content field's draft: `{ field, value, editable, digest, collection, id }`. `page` is required for its Comments policy. |
| `POST /fields?page=` | Page `write`, and Content `write` | Saves `{ field, value, ifDigest }` as a Content draft. Returns `{ field, value, digest }`. Needs `page`, like the field read. |
| `GET /auth/github?return=` | None | Starts [Sign in with GitHub](/docs/comments/configure#sign-in-with-github), then returns the person to `return`, a path on the same site. |
| `GET /auth/callback/github` | None | Where GitHub returns the person. List it as the App's callback URL. |
| `POST /auth/sign-out` | None | Ends the GitHub sign-in in this browser. |

The server sets a message's author from the request's user. A guest sends its id and name in the `x-vitehub-comments-guest-id` and `x-vitehub-comments-guest-name` headers.

`POST` and `DELETE` requests with an `Origin` header must come from the site's origin. A proxy that ends TLS must pass `X-Forwarded-Proto` and `X-Forwarded-Host`. See [Hosts](/docs/comments/hosts#proxies-that-end-tls).

| Status | Codes |
| --- | --- |
| `400` | `COMMENTS_INVALID_INPUT`, `COMMENTS_FIELD_INVALID` |
| `403` | `COMMENTS_FORBIDDEN`, `COMMENTS_POLICY_MISSING`, `COMMENTS_FIELD_FORBIDDEN` |
| `404` | `COMMENTS_NOT_FOUND`, `COMMENTS_CONTENT_MISSING`, `COMMENTS_SIGN_IN_OFF`, `COMMENTS_R0020` |
| `409` | `COMMENTS_RESOLVED`, `COMMENTS_FIELD_CONFLICT` |
| `422` | `COMMENTS_FIELD_NOT_EDITABLE` |
| `423` | `COMMENTS_FIELD_LOCKED` |
| `502` | `COMMENTS_SIGN_IN_FAILED` |
| `413`, `415` | `COMMENTS_INVALID_INPUT` for a file that is too large or of a type Comments does not attach |
| `501` | `COMMENTS_R0014`, `COMMENTS_R0021`: no place to store or read attachments |
| `503` | `COMMENTS_NOT_INSTALLED`, `COMMENTS_R0019` |

The overlay script is a static file at `/api/_vitehub/comments/assets/overlay.js`.

### REST transport

`createRestTransport()` from `vite-hub/comments/client` is a [`CommentsTransport`](/docs/comments/operations/server-api#browser-transport) over these routes for your own UI. Unlike the RPC transport, it needs no Console access, so it serves guests and share-link readers.

```ts [app/comments.ts] fragment
import { createCommentsClient, createRestTransport } from 'vite-hub/comments/client'

const transport = createRestTransport({
  // A share link's token, which `identify` reads on the server. A function runs before each request.
  headers: () => ({ 'x-share-token': shareToken() }),
  // The name that a guest typed, when `authorize` lets anonymous people write.
  guest: () => readGuest(),
})
const client = createCommentsClient({ transport, user, query: { subject: { kind: 'drop', id: '42' } } })

// A thumbnail of an attachment: the URL checks that the reader may read its thread.
const src = transport.attachmentUrl(thread.messages[0].attachments[0])
```

| Option | Default | Use |
| --- | --- | --- |
| `base` | The page origin | App origin and mount, such as `/portal`. |
| `headers` | None | Headers for each request, or a function that returns them. |
| `guest` | None | `{ id, name }`, or a function that returns it, sent as guest headers. |
| `credentials` | `same-origin` | Sends the session cookie. |
| `fetch` | `globalThis.fetch` | For tests or a server. |

A failed request throws `CommentsRestError` with the response's `code`, `why`, `fix`, and `status`. `commentAttachmentUrl(key, base?)` builds the same URL as `transport.attachmentUrl()`. The overlay uses the same code.

## Content field addresses

Content owns the address format, `<collection>[:<id>]#<field.path>`. Comments only reads it.

| Function | Behavior |
| --- | --- |
| `contentField(collection, field)` | Returns `{ 'data-content-field': 'about#hero.title' }` for a singleton. |
| `contentField(collection, id, field)` | Returns `{ 'data-content-field': 'customers:acme#name' }` for a document in a `documents()` collection. |
| `formatContentField({ collection, id?, field })` | Returns the address string. Throws a `TypeError` for a collection name, id, or field path the format cannot hold. |
| `parseContentField(value)` | Returns `{ collection, id?, field }`, or `undefined` for any other string. |

Field paths use dots between keys, such as `hero.title` or `cards.0.title`. An id cannot contain `#`. See [Mark Content fields](/docs/comments/configure#mark-content-fields).

## Presence rooms

When the host has a [Realtime room authority](/docs/realtime/configure#choose-a-room-authority), Comments adds the Realtime Definition `comments`, with one room per page. The overlay connects read-only and shares only presence: who is on the page, and each cursor as an element and a point in its box. The room stores nothing; threads stay in the Database.

The server sets each person in the room from `identify` or the Auth session, and checks `authorize` with `read` and the page subject. Clients send the normalized page in `params: { page }`, and the server checks that the room is `commentRoom(page)` before it grants access. After a change, the overlay sends other browsers a data-free hint, and they reload threads over HTTP.

`connectRealtimeRoom(definition, documentId, options?)` from `@vite-hub/realtime/client` is the overlay's client. It joins one room for presence without editing the document. See [Realtime server API](/docs/realtime/server-api#presence-without-an-editor).

## Generated output

With `server/comments.ts` or `comments()`, the integration writes these build files. Do not import them.

- `.vitehub/nitro/comments/handler.mjs` serves `/api/_vitehub/comments/**`.
- `.vitehub/nitro/comments/plugin.mjs` installs Comments with its Database at server start. It registers the overlay and sign-in prompt as the `comments` page tool.
- `.vitehub/nitro/comments/page-session.mjs` serves `GET /_vitehub/page/session`.
- `definition.mjs`, only from `comments()` without `server/comments.ts`, exports `defineComments()` with no options.
- `comments.mjs`, with a room authority, is the Realtime presence room definition.

The package serves the page tools loader at `/_vitehub/page/assets/loader.js`. These routes work without the Console. A root-relative Vite `base` or Nuxt `app.baseURL` prefixes them. Absolute and protocol-relative Vite asset URLs leave them at root, unless you set an explicit ViteHub application base.
