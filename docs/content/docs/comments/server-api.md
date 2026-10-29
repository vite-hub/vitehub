---
title: Comments server API
description: defineComments() options, the runtime methods and their error codes, thread and anchor types, the HTTP routes, and Content field addresses.
navigation.title: Server API
navigation.order: 4
icon: i-lucide-code-2
---

## Public imports

| Import | Use |
| --- | --- |
| `defineComments` from `vite-hub/comments` | Define Comments in `server/comments.ts`. Export the result as `comments`. |
| `Comments`, `CommentThread`, `Comment`, `CommentAnchor`, `CommentAuthor`, `CommentMention`, `CommentsErrorCode` from `vite-hub/comments` | Types of the runtime, threads, comments, anchors, and error codes. |
| `normalizeCommentPage` from `vite-hub/comments` | The page key of a path, as Comments stores it. |
| `installComments` from `vite-hub/comments` | Connect a definition to a Drizzle SQLite Database in tests or outside ViteHub. The generated Nitro plugin calls it for you. |
| `contentField`, `formatContentField`, `parseContentField` from `vite-hub/content/client` | Write and read [Content field addresses](#content-field-addresses). |
| `connectRealtimeRoom` from `@vite-hub/realtime/client` | Join a Realtime room for presence. The overlay uses it for the [presence rooms](#presence-rooms). |

Libraries can install `@vite-hub/comments` and use the same exports. `@vite-hub/comments/vite` exports `hubComments()`, the build integration that `vitehub()` adds for you.

## `defineComments()` options

| Option | Default | Behavior |
| --- | --- | --- |
| `authorize({ user, action, thread })` | Signed-in users may do everything. Anonymous requests may do nothing. | Return `false` to deny. `action` is `read`, `comment`, or `resolve`. See [Decide who can comment](/docs/comments/configure#decide-who-can-comment). |
| `identify({ event })` | The ViteHub Auth session | Return the user of a request, with a string `id`, or `null`. See [Use your own login](/docs/comments/configure#use-your-own-login). |
| `database` | `default`, else the only Database | The Database name, as a string literal. See [Choose the Database](/docs/comments/configure#choose-the-database). |
| `people({ query, user })` | Authors of earlier comments | The people that `@` suggests, as `{ id, name }[]`. |
| `onComment({ thread, comment, mentions })` | None | Runs after a new thread or a reply saves. Errors are logged, not returned. See [Notify mentioned people](/docs/comments/configure#notify-mentioned-people). |
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
| `list({ scope?, page?, status?, limit? })` | Threads with their comments, newest activity first. Without `scope`, threads of every scope. `limit` is 200 by default and 500 at most. | `COMMENTS_NOT_INSTALLED` |
| `get(id)` | One thread. | `COMMENTS_NOT_INSTALLED`, `COMMENTS_NOT_FOUND` |
| `getByNumber(scope, number)` | Thread `#number` of a scope. | `COMMENTS_NOT_INSTALLED`, `COMMENTS_NOT_FOUND` |
| `getByComment(commentId)` | The thread that holds a comment, for routes that have only the comment id. | `COMMENTS_NOT_INSTALLED`, `COMMENTS_NOT_FOUND` |
| `create({ scope?, page, anchor?, context?, metadata?, body, author, mentions? })` | The new thread, with its first comment and the next number of its scope. Runs `onComment`. `scope` is `'pages'` by default, and a page thread needs `anchor`. | `COMMENTS_NOT_INSTALLED`, `COMMENTS_INVALID_INPUT` |
| `reply(threadId, { body, author, mentions? }, { allowResolved? })` | The new comment. Runs `onComment`. A resolved thread fails with `COMMENTS_RESOLVED`, unless `allowResolved` is `true`; then it stays resolved. | `COMMENTS_NOT_INSTALLED`, `COMMENTS_NOT_FOUND`, `COMMENTS_INVALID_INPUT`, `COMMENTS_RESOLVED` |
| `resolve(threadId, { by })` | The thread, with `status: 'resolved'`, `resolvedBy`, and `resolvedAt`. | `COMMENTS_NOT_INSTALLED`, `COMMENTS_NOT_FOUND` |
| `reopen(threadId)` | The thread, with `status: 'open'`. | `COMMENTS_NOT_INSTALLED`, `COMMENTS_NOT_FOUND` |
| `remove(threadId)` | Nothing. Deletes the thread and all its comments. | `COMMENTS_NOT_INSTALLED`, `COMMENTS_NOT_FOUND` |
| `removeComment(commentId)` | Nothing. Deleting the first comment deletes the thread. | `COMMENTS_NOT_INSTALLED`, `COMMENTS_NOT_FOUND` |
| `edit(commentId, { body, mentions? })` | The comment, with the new text and `editedAt`. | `COMMENTS_NOT_INSTALLED`, `COMMENTS_NOT_FOUND`, `COMMENTS_INVALID_INPUT` |
| `removeScope(scope)` | `{ removed }`, the number of threads it deleted with their comments. | `COMMENTS_NOT_INSTALLED` |
| `people({ query, user, scope? })` | At most 20 `{ id, name }` whose name contains `query`: the `people` option, else the authors of `scope`, `'pages'` by default. | `COMMENTS_NOT_INSTALLED` |
| `can({ user, action, thread?, scope? })` | `true` when the `authorize` policy allows the action. `scope` is the thread's, else `'pages'`. | None |
| `sync(threadId)` | Nothing. With `forge`, brings the thread's pull request comments in line now, and posts what failed before. | None |
| `flush()` | Nothing. Waits for the pull request syncs that earlier changes started. | None |

`page` is normalized before it is stored or compared: Comments drops the query and the hash, joins repeated slashes, and removes a trailing slash. `/pricing/?plan=pro#faq` is `/pricing`.

`COMMENTS_NOT_INSTALLED` means that the method ran before the server installed Comments, such as at import time. See [Limits and errors](/docs/comments/limits-and-errors).

A change from server code does not reach open pages at once. Open pages read their threads again when the tab gets focus, and every 30 seconds while it is visible.

## Types

### Threads and comments

```ts
interface CommentThread {
  id: string
  scope: string                   // 'pages' for the overlay, or the scope that app code picks
  number: number                  // 1, 2, 3, … in the order threads start in their scope
  page: string                    // normalized pathname, such as '/pricing'
  anchor: CommentAnchor | null    // null for threads that app code anchors itself
  metadata: CommentMetadata | null
  context: CommentContext | null  // what the person saw; null for threads that server code created without it
  status: 'open' | 'resolved'
  createdBy: CommentAuthor
  resolvedBy: CommentAuthor | null
  resolvedAt: string | null       // ISO time
  createdAt: string
  updatedAt: string
  comments: Comment[]             // oldest first; the first comment opened the thread
  forge?: CommentForgeLink | null // with the forge option: its pull request comment
}

interface CommentForgeLink {
  repository: string              // 'owner/name'
  pullRequest: number
  state: 'posted' | 'pending' | 'failed'
  url?: string                    // the comment of the first comment
  error?: string                  // why GitHub refused it
  postedAs?: 'author' | 'app'
}

interface Comment {
  id: string
  threadId: string
  body: string                    // plain text, 1 to 4,000 characters
  mentions: CommentMention[]      // at most 20
  author: CommentAuthor
  createdAt: string
  editedAt: string | null
}

// At most 50 keys of up to 64 characters. Strings hold at most 4,000 characters.
type CommentMetadata = Record<string, string | number | boolean | null>

interface CommentAuthor {
  id: string
  name: string
  image?: string
  guest?: boolean                 // true for a guest that named itself in the browser
}

interface CommentMention {
  id: string
  name: string
}
```

Each comment row keeps a copy of its author. A comment keeps its author name when the Auth user changes or goes away.

### Anchors

An anchor says where a thread sits on its page. The overlay writes it when someone clicks.

```ts
interface CommentAnchor {
  field?: string                  // data-content-field address, such as 'about#hero.title'
  selector: string                // CSS path, at most 10 levels
  label: string                   // tag and the first 40 characters of the element text
  x: number                       // pin position in the element box, in thousandths
  y: number
  page: { x: number, y: number }  // thousandths of the document width, CSS pixels from the top
  viewport: { width: number }     // viewport width when the pin was dropped
}
```

To place a pin, the overlay uses the first of these that finds an element:

1. `field`: the element with that `data-content-field`. When a field shows more than once on the page, the CSS path picks the copy.
2. `selector`, when the element it finds still has the same `label`.
3. The first element with the same tag and `label`.
4. The `page` point. The pin shows with a dashed border, and the thread says "element moved".

`selector` stops at the closest ancestor with an `id` or a Content field. Give stable `id` values to sections that pins should follow.

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

The overlay calls the Comments API at `/api/_vitehub/comments`. Each answer is JSON, `{ data }` or `{ error }`, with `cache-control: private, no-store`. `error` has `code`, `why`, `fix`, and `docs`.

| Route | Needs | Does |
| --- | --- | --- |
| `GET /session` | None | Returns `{ user, can: { read, comment, resolve }, realtime, content }`. It sets no cookie: `GET /_vitehub/page/session` owns the `vitehub-tools` hint. |
| `GET /threads?page=&status=` | `read` | Lists threads, as `list()` does. |
| `POST /threads` | `comment` | Starts a thread from `{ page, anchor, context?, body, mentions? }`. |
| `POST /threads/:id/comments` | `comment` | Replies with `{ body, mentions? }`. |
| `POST /threads/:id/resolve`, `POST /threads/:id/reopen` | `resolve` | Resolves or reopens the thread. |
| `DELETE /threads/:id` | `resolve` | Deletes the thread. |
| `DELETE /threads/:id/comments/:commentId` | `comment` for your own comment, `resolve` for any other | Deletes one comment. |
| `GET /people?q=` | `read` | Returns the `@` suggestions. |
| `GET /fields?field=` | `comment`, and Content `write` | Reads the draft of one Content field: `{ field, value, editable, digest, collection, id }`. |
| `POST /fields` | `comment`, and Content `write` | Saves `{ field, value, ifDigest }` as a Content draft. Returns `{ field, value, digest }`. |

The server sets the author of a comment from the user of the request. A guest sends its id and name in the `x-vitehub-comments-guest-id` and `x-vitehub-comments-guest-name` headers.

`POST` and `DELETE` requests with an `Origin` header must come from the site's own origin. A proxy that ends TLS must pass `X-Forwarded-Proto` and `X-Forwarded-Host`. See [Hosts](/docs/comments/hosts#proxies-that-end-tls).

| Status | Codes |
| --- | --- |
| `400` | `COMMENTS_INVALID_INPUT`, `COMMENTS_FIELD_INVALID` |
| `403` | `COMMENTS_FORBIDDEN`, `COMMENTS_FIELD_FORBIDDEN` |
| `404` | `COMMENTS_NOT_FOUND`, `COMMENTS_CONTENT_MISSING` |
| `409` | `COMMENTS_RESOLVED`, `COMMENTS_FIELD_CONFLICT` |
| `422` | `COMMENTS_FIELD_NOT_EDITABLE` |
| `423` | `COMMENTS_FIELD_LOCKED` |
| `503` | `COMMENTS_NOT_INSTALLED` |

The overlay script is a static file at `/api/_vitehub/comments/assets/overlay.js`.

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

When the app has `server/comments.ts`, the integration writes `.vitehub/nitro/comments/handler.mjs`, `.vitehub/nitro/comments/plugin.mjs`, and `.vitehub/nitro/comments/page-session.mjs`. The handler serves `/api/_vitehub/comments/**`. The plugin installs Comments with its Database when the server starts, and registers the overlay as the `comments` page tool. `page-session.mjs` serves `GET /_vitehub/page/session`, and the package serves the page tools loader at `/_vitehub/page/assets/loader.js`. These routes work without the Console. With a room authority, Realtime also gets `comments.mjs`, the presence room definition. Treat these files as build output, not application imports.
