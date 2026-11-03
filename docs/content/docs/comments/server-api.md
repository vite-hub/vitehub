---
title: Comments server API
description: The comments() plugin, defineComments() options, the runtime methods and their error codes, thread and anchor types, the HTTP routes, and Content field addresses.
navigation.title: Server API
navigation.order: 5
icon: i-lucide-code-2
---

## Public imports

| Import | Use |
| --- | --- |
| `comments` from `@vite-hub/comments/vite`, also its default export | The Vite plugin for an app without `vite-hub`. See [`comments()` options](#comments-options). |
| `defineComments` from `vite-hub/comments` | Define Comments in `server/comments.ts`. Export the result as `comments`. |
| `Comments`, `CommentThread`, `CommentMessage`, `CommentAnchor`, `CommentUser`, `CommentSubject`, `CommentsErrorCode` from `vite-hub/comments` | Types of the runtime, threads, messages, anchors, people, subjects, and error codes. The browser client and the comment operations use the same types. |
| `defineCommentSubject` from `vite-hub/comments` | A kind of subject of your own, with its numbering scope. See [Comments in your own UI](/docs/comments/configure#comments-in-your-own-ui). |
| `migrateComments`, `commentsMigrationSql` from `vite-hub/comments/database` | Move a Database from the live-site tables to one model. See [Upgrade to one model](/docs/comments/configure#upgrade-to-one-model). |
| `normalizeCommentPage` from `vite-hub/comments` | The page key of a path, as Comments stores it. |
| `installComments` from `vite-hub/comments` | Connect a definition to a Drizzle Database in tests or outside ViteHub. The generated Nitro plugin calls it for you. |
| `contentField`, `formatContentField`, `parseContentField` from `vite-hub/content/client` | Write and read [Content field addresses](#content-field-addresses). |
| `connectRealtimeRoom` from `@vite-hub/realtime/client` | Join a Realtime room for presence. The overlay uses it for the [presence rooms](#presence-rooms). |

Without `vite-hub`, import the same names from `@vite-hub/comments`. `@vite-hub/comments/vite` also exports `hubComments()`, the build integration that `vitehub()` adds for you.

## `comments()` options

`comments()` turns Comments on in a Vite app without `vite-hub`. It needs no `server/comments.ts`; when the app has one, it uses it. It adds [Nitro](https://nitro.build), unless the app adds `nitro()` itself. In an app with `vitehub()`, it does nothing, because `vitehub()` runs Comments.

| Option | Default | Behavior |
| --- | --- | --- |
| `database` | `DATABASE_URL`, `TURSO_DATABASE_URL`, or the D1 binding `DB`, read when the server runs. `.vitehub/data/comments.sqlite` on `vite dev`. | Where threads go: `'d1:BINDING'`, `'env:VARIABLE'` with a libSQL URL, `'file:./path.sqlite'` on Node, or a `libsql://` URL. Comments creates its tables there on first use. See [Choose the Database](/docs/comments/configure#choose-the-database). |

## `defineComments()` options

| Option | Default | Behavior |
| --- | --- | --- |
| `authorize({ user, actor?, action, thread?, subject? })` | People signed in with GitHub who can push to the repository, and users of any other sign-in, may do everything. Guests may only on the dev server. | Return `true` to allow. `action` is `read`, `write`, `resolve`, or `delete`. See [Decide who can comment](/docs/comments/configure#decide-who-can-comment). |
| `identify({ event })` | The Console user, else the ViteHub Auth session, else [Sign in with GitHub](/docs/comments/configure#sign-in-with-github) | Return the user of a request, with a string `id`, or `null`. See [Use your own login](/docs/comments/configure#use-your-own-login). |
| `database` | `default`, else the only Database | In a ViteHub app, the Database name, as a string literal. `comments()` takes its own [`database`](#comments-options) instead. See [Choose the Database](/docs/comments/configure#choose-the-database). |
| `subjects` | `page` and `content` | More kinds of subject, from `defineCommentSubject({ kind, scope, emptyBody?, link? })`. |
| `people` | The users of ViteHub Auth, else the authors of earlier comments | `{ search(query, limit), byIds(ids) }`: where `@` finds people. See [Mention people](/docs/comments/configure#mention-people). |
| `canMention({ user, person, thread?, subject? })` | `person` may read the thread | Return `true` when `user` may mention `person` there. |
| `onMention({ users, message, thread, link? })` | None | Runs once for each message that mentions people for the first time. See [Notify mentioned people](/docs/comments/configure#notify-mentioned-people). |
| `onComment({ thread, message, mentions })` | None | Runs after a new thread or a reply saves, before the answer. Errors are logged, not returned. |
| `storeAttachment(file, { user, subject? })` | The Blob store of the app | Stores an uploaded file and returns its key. See [Attach files](/docs/comments/configure#attach-files). |
| `forge` | None | `{ provider: 'github', repository?, pullRequest?(thread), token?(author), title?, apiUrl? }`. Posts threads to the pull request of the preview. See [Post comments to the pull request](/docs/comments/configure#post-comments-to-the-pull-request). |

## Runtime methods

Import `comments` from `server/comments.ts` in server routes, plugins, and Agent tools. Each method returns `[error, data]`, except `can()`. These methods are trusted server API: they do not call `authorize`.

```ts [server/api/threads/[id]/resolve.post.ts]
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
| `list({ subject?, page?, scope?, status?, revision?, limit?, before? })` | Threads with their messages, newest activity first. `revision: { lte: 3 }` keeps the threads of version 3 of the subject and earlier ones. `limit` is 200 by default and 500 at most. | `COMMENTS_NOT_INSTALLED`, `COMMENTS_INVALID_INPUT` |
| `get(id)` | One thread. | `COMMENTS_NOT_INSTALLED`, `COMMENTS_NOT_FOUND` |
| `getByNumber(scope, n)` | Thread `#n` of a scope, such as `site`. | `COMMENTS_NOT_INSTALLED`, `COMMENTS_NOT_FOUND` |
| `getByMessage(messageId)` | The thread that holds a message. | `COMMENTS_NOT_INSTALLED`, `COMMENTS_NOT_FOUND` |
| `create({ subject?, page?, anchor?, context?, metadata?, revision?, body, author, mentions?, attachments? })` | The new thread, with its first message and the next number of the scope of its subject. Give `subject`, or `page` for a page subject. `anchor` is `{ kind: 'page' }` by default. Runs `onComment` and `onMention`. | `COMMENTS_NOT_INSTALLED`, `COMMENTS_INVALID_INPUT` |
| `reply(threadId, { body, author, mentions?, attachments? }, { allowResolved? })` | The new message. A resolved thread fails with `COMMENTS_RESOLVED`, unless `allowResolved` is `true`; then it stays resolved. | `COMMENTS_NOT_INSTALLED`, `COMMENTS_NOT_FOUND`, `COMMENTS_INVALID_INPUT`, `COMMENTS_RESOLVED` |
| `resolve(threadId, { by })` | The thread, with `status: 'resolved'`, `resolvedBy`, and `resolvedAt`. | `COMMENTS_NOT_INSTALLED`, `COMMENTS_NOT_FOUND` |
| `reopen(threadId)` | The thread, with `status: 'open'`. | `COMMENTS_NOT_INSTALLED`, `COMMENTS_NOT_FOUND` |
| `remove(threadId)` | Nothing. Deletes the thread and all its messages. | `COMMENTS_NOT_INSTALLED`, `COMMENTS_NOT_FOUND` |
| `removeMessage(messageId)` | Nothing. Deleting the first message deletes the thread. | `COMMENTS_NOT_INSTALLED`, `COMMENTS_NOT_FOUND` |
| `edit(messageId, { body, mentions? })` | The message, with the new text and `editedAt`. | `COMMENTS_NOT_INSTALLED`, `COMMENTS_NOT_FOUND`, `COMMENTS_INVALID_INPUT` |
| `removeScope(scope)` | `{ removed }`, the number of threads it deleted with their messages. | `COMMENTS_NOT_INSTALLED` |
| `people({ query, user, thread?, subject?, limit? })` | At most 20 people whose name contains `query`, that `user` may mention there. | `COMMENTS_NOT_INSTALLED` |
| `can({ user, action, thread?, subject? }, gate?)` | `true` when the `authorize` policy allows the action. Without `authorize`, [the default policy](/docs/comments/configure#decide-who-can-comment) decides; `gate` says what your server already checked: `{ development, console }`. | None |
| `sync(threadId)` | Nothing. With `forge`, brings the thread's pull request comments in line now, and posts what failed before. | None |
| `flush()` | Nothing. Waits for the pull request syncs and `onMention` calls that earlier changes started. | None |

`page` is normalized before it is stored or compared: Comments drops the query and the hash, joins repeated slashes, and removes a trailing slash. `/pricing/?plan=pro#faq` is `/pricing`.

`COMMENTS_NOT_INSTALLED` means that the method ran before the server installed Comments, such as at import time. See [Limits and errors](/docs/comments/limits-and-errors).

A change from server code does not reach open pages at once. Open pages read their threads again when the tab gets focus, and every 30 seconds while it is visible.

## Types

### Threads and messages

The server API, the comment operations, the browser client, and the overlay use the same types.

```ts
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

Each message keeps a copy of its author. A message keeps its author name when the Auth user changes or goes away.

### Users

`authorize`, `can()`, and `people()` get the user of the request, or `null` for an anonymous one.

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

An anchor says where a thread sits. The overlay writes an `element` anchor with hints when someone clicks; the browser client of `@vite-hub/comments/client` also writes `text`, `area`, and `image` anchors.

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

1. `field`: the element with that `data-content-field`. When a field shows more than once on the page, the CSS path picks the copy.
2. `selector`, when the element it finds still has the same `label`.
3. The first element with the same tag and `label`.
4. The `page` point. The pin shows with a dashed border, and the thread says "element moved".

The overlay shows only threads with an `element` anchor. `selector` stops at the closest ancestor with an `id` or a Content field. Give stable `id` values to sections that pins should follow.

The overlay places pins again when the window resizes, the page changes, or a client router changes the URL. A pin on a hidden element hides with it.

### Page context

When someone starts a thread on a page, the overlay also records what they saw, so a teammate or an Agent can find the code to change. The server adds the build and the source files.

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

- **Components:** the overlay walks the Vue component tree from the app container down to the element. A production build keeps that tree, so this works without Vue devtools and changes nothing in the HTML. Pages that Vue does not render get no components.
- **URL:** the overlay drops all query parameters and the hash. The server checks that the submitted URL matches the request origin and thread page, then stores only the origin and normalized pathname.
- **Files:** a production build keeps only the component name, which for `<script setup>` is the name of its file. At build time, Comments lists the `.vue` files of the project by name, and the server adds the files of each name to the thread. In Nuxt, it also uses the resolved component registry, including custom prefixes, component directories, and client/server suffixes. A name that two files share, such as `index`, gets both unless Nuxt resolves that name to a specific component. The list skips `node_modules`, `dist`, `public`, and dot directories. Nuxt rescans refresh its resolved names; in other Vite apps, restart the server after you add a component.
- **Build:** the commit and branch come from the host or CI at build time (`VERCEL_GIT_COMMIT_SHA`, `WORKERS_CI_COMMIT_SHA`, `CF_PAGES_COMMIT_SHA`, `COMMIT_REF`, or `GITHUB_SHA`), else from Git. The GitHub repository and the pull request come from the same place, for [`forge`](/docs/comments/configure#post-comments-to-the-pull-request). The browser cannot set them, and cannot set file names.

The Console shows the context in each thread's fields. `describeCommentContext(context)` from `vite-hub/comments` returns the same label and value pairs.

## HTTP routes

The overlay and [`createRestTransport()`](#rest-transport) call the Comments API at `/api/_vitehub/comments`. Each answer is JSON, `{ data }` or `{ error }`, with `cache-control: private, no-store`. `error` has `code`, `why`, `fix`, and `docs`. Threads and messages have the [types above](#threads-and-messages); a thread also has `can: { comment, resolve, delete }` for the reader. Routes that answer threads or messages also send `people`: the people that they mention, with their names.

The routes run the same actions as the [comment operations](/docs/comments/operations/server-api), with the same checks, for the user of the request. They need no Console access, so guests and people that `identify` signs in, such as readers of a share link, can use them. They serve threads on every subject that `authorize` lets the reader see, not only `page` subjects.

| Route | Needs | Does |
| --- | --- | --- |
| `GET /session` | None | Returns `{ user, can: { read, comment, resolve }, realtime, content }`, plus `signIn: { provider, url }` for a person who can sign in with GitHub, and `github` with `signOut` for a person signed in with GitHub. It sets no cookie: `GET /_vitehub/page/session` owns the `vitehub-tools` hint. |
| `GET /threads` | `read` | Lists the threads that the reader may read, as `comments.list` does. Search parameters: `page`, or `subjectKind` with `subjectId`, or `subjectKind` alone; `status`, `mine`, `mentions`, `revision` (at most this revision), `limit`, and `beforeId` with `beforeUpdatedAt` for the next page. `403` when the reader may not read the filter. |
| `GET /threads/:id` | `read` | One thread, or `null` when it does not exist or the reader may not read it. |
| `GET /scopes/:scope/threads/:n` | `read` | Thread `#n` of a scope, such as `site`, or `null`. |
| `POST /threads` | `read` and `write` | Starts a thread from the input of `comments.create`: `{ subject, anchor?, body, mentions?, attachments?, metadata?, revision? }`. `page` may replace `subject`, and a page thread may carry the `context` that the overlay read. `mentions` are ids. |
| `POST /threads/:id/comments` | `write` | Replies with `{ body, mentions?, attachments? }`. Returns the message as `data` and the thread as `thread`. A resolved thread answers `COMMENTS_RESOLVED`. |
| `PATCH /threads/:id/comments/:messageId` | Your own message | Changes its text with `{ body, mentions? }`. Returns the thread. |
| `POST /threads/:id/resolve`, `POST /threads/:id/reopen` | `resolve` | Resolves or reopens the thread. |
| `DELETE /threads/:id` | `write` when every message is yours, else `delete` | Deletes the thread. Returns `null`. |
| `DELETE /threads/:id/comments/:messageId` | `write` for your own message, `delete` for any other | Deletes one message, or the thread for its first message. Returns the thread, or `null`. |
| `POST /attachments` | `write` | Stores a file from `{ name, type, data, subject? }`, `data` in Base64, as `comments.upload` does. Returns `{ key, name, type, size }`. |
| `GET /attachments/:key` | `read` on a thread with a message that lists the key | Answers the file. See [Attach files](/docs/comments/configure#attach-files). |
| `GET /people?q=` | `read` | Returns the `@` suggestions. With `thread`, `page`, or `subjectKind` and `subjectId`, only the people who may be mentioned there. `limit` is at most 20. |
| `GET /fields?field=` | `write`, and Content `write` | Reads the draft of one Content field: `{ field, value, editable, digest, collection, id }`. |
| `POST /fields` | `write`, and Content `write` | Saves `{ field, value, ifDigest }` as a Content draft. Returns `{ field, value, digest }`. |
| `GET /auth/github?return=` | None | Starts [Sign in with GitHub](/docs/comments/configure#sign-in-with-github), then sends the person back to `return`, a path on the same site. |
| `GET /auth/callback/github` | None | Where GitHub sends the person back. List it as the App's callback URL. |
| `POST /auth/sign-out` | None | Ends the GitHub sign-in in this browser. |

The server sets the author of a message from the user of the request. A guest sends its id and name in the `x-vitehub-comments-guest-id` and `x-vitehub-comments-guest-name` headers.

`POST` and `DELETE` requests with an `Origin` header must come from the site's own origin. A proxy that ends TLS must pass `X-Forwarded-Proto` and `X-Forwarded-Host`. See [Hosts](/docs/comments/hosts#proxies-that-end-tls).

| Status | Codes |
| --- | --- |
| `400` | `COMMENTS_INVALID_INPUT`, `COMMENTS_FIELD_INVALID` |
| `403` | `COMMENTS_FORBIDDEN`, `COMMENTS_POLICY_MISSING`, `COMMENTS_FIELD_FORBIDDEN` |
| `404` | `COMMENTS_NOT_FOUND`, `COMMENTS_CONTENT_MISSING`, `COMMENTS_SIGN_IN_OFF`, `COMMENTS_R0020` |
| `409` | `COMMENTS_RESOLVED`, `COMMENTS_FIELD_CONFLICT` |
| `422` | `COMMENTS_FIELD_NOT_EDITABLE` |
| `423` | `COMMENTS_FIELD_LOCKED` |
| `502` | `COMMENTS_SIGN_IN_FAILED` |
| `413`, `415` | `COMMENTS_INVALID_INPUT` for a file that is too large or of a type that Comments does not attach |
| `501` | `COMMENTS_R0014`, `COMMENTS_R0021`: no place to store or read attachments |
| `503` | `COMMENTS_NOT_INSTALLED`, `COMMENTS_R0019` |

The overlay script is a static file at `/api/_vitehub/comments/assets/overlay.js`.

### REST transport

`createRestTransport()` from `vite-hub/comments/client` is a [`CommentsTransport`](/docs/comments/operations/server-api#browser-transport) over these routes, for an app's own comment UI. Unlike the RPC transport, it needs no Console access, so it serves guests and share-link readers too.

```ts [app/comments.ts]
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
| `base` | The page origin | The app origin and mount, such as `/portal`. |
| `headers` | None | Headers, or a function that returns them, for each request. |
| `guest` | None | `{ id, name }`, or a function that returns it, sent as the guest headers. |
| `credentials` | `same-origin` | Sends the session cookie. |
| `fetch` | `globalThis.fetch` | For tests, or a server. |

A failed request throws `CommentsRestError` with the `code`, `why`, `fix`, and `status` of the answer. `commentAttachmentUrl(key, base?)` builds the same URL as `transport.attachmentUrl()`. The overlay sends its requests through the same code.

## Content field addresses

Content owns the address format, `<collection>[:<id>]#<field.path>`. Comments only reads it.

| Function | Behavior |
| --- | --- |
| `contentField(collection, field)` | Returns `{ 'data-content-field': 'about#hero.title' }` for a singleton. |
| `contentField(collection, id, field)` | Returns `{ 'data-content-field': 'customers:acme#name' }` for a document of a `documents()` collection. |
| `formatContentField({ collection, id?, field })` | Returns the address string. Throws a `TypeError` for a collection name, an id, or a field path that the format cannot hold. |
| `parseContentField(value)` | Returns `{ collection, id?, field }`, or `undefined` for any other string. |

The field path uses dots between keys, such as `hero.title` or `cards.0.title`. An id cannot contain `#`. See [Mark Content fields](/docs/comments/configure#mark-content-fields).

## Presence rooms

When the host has a [Realtime room authority](/docs/realtime/configure#choose-a-room-authority), Comments adds the Realtime Definition `comments`. Each page has one room. The overlay connects read-only and shares only presence: who is on the page, and each cursor as an element and a point in its box. The room stores nothing. Threads stay in the Database.

The server sets each person in the room from `identify` or the Auth session, and checks `authorize` with `read`. After a change, the overlay sends a hint without data to the other browsers on the page, and they read the threads again over HTTP.

`connectRealtimeRoom(definition, documentId, options?)` from `@vite-hub/realtime/client` is the client that the overlay uses. It joins one room for presence and does not edit the document. See [Realtime server API](/docs/realtime/server-api#presence-without-an-editor).

## Generated output

When the app has `server/comments.ts`, or uses `comments()`, the integration writes `.vitehub/nitro/comments/handler.mjs`, `.vitehub/nitro/comments/plugin.mjs`, and `.vitehub/nitro/comments/page-session.mjs`. Without `server/comments.ts`, `comments()` also writes `definition.mjs`, which exports `defineComments()` with no options. The handler serves `/api/_vitehub/comments/**`. The plugin installs Comments with its Database when the server starts, and registers the overlay as the `comments` page tool, including its sign-in prompt. `page-session.mjs` serves `GET /_vitehub/page/session`, and the package serves the page tools loader at `/_vitehub/page/assets/loader.js`. These routes work without the Console. A root-relative Vite `base` or Nuxt `app.baseURL` prefixes these paths. Absolute and protocol-relative Vite asset URLs leave them at root unless an explicit ViteHub application base is set. With a room authority, Realtime also gets `comments.mjs`, the presence room definition. Treat these files as build output, not application imports.
