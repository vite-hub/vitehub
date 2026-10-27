---
title: Configure comments
description: Set the access policy, add subject kinds, react to mentions, and choose the Database.
navigation.title: Configure
navigation.order: 3
icon: i-lucide-settings
---

## Access: `authorize`

```ts [server/comments.ts]
export default defineComments({
  authorize: ({ user, actor, action, thread, subject }) => { /* … */ },
})
```

| Field | Meaning |
| --- | --- |
| `user` | The signed-in user, including application fields such as `role`, or `null`. Stored authors and mention suggestions contain only `id`, `name`, and `image`. |
| `actor` | The Agent Actor when an agent acts for `user`. |
| `action` | `read`, `write`, `resolve`, or `delete`. |
| `thread` | The thread, when the action is about one. Not set for `create`, `list`, and `users`. |
| `subject` | What the action is about: the subject of `thread`, the subject that `create` starts a thread on, or the subject that a `list` filters by. Not set for a `list` with no filter and for `users`. |

Return `true` to allow. The policy runs for every operation, on every surface: the Console, the CLI, MCP, and agents.

- Without `authorize`, nobody can read or write. Calls fail with `COMMENTS_R0006`, and the Console list shows that error with its fix.
- Creating a thread asks `read`, then `write`, with its subject. Mention suggestions ask `read`, then `write`, without a thread or subject.
- Every operation on a thread asks `read` for that thread first. A thread you may not read looks missing: `get` answers `null`, and `reply`, `edit`, `delete`, `resolve`, and `reopen` fail with `COMMENTS_R0002`, the same as for a thread that does not exist.
- People edit their own messages and delete their own messages, once they may read the thread. Nobody else edits a message. An Agent has no such right, even when it acts for the author: `edit` needs `write`, and `delete` needs `delete`.
- `delete` covers the messages of other people. A person deletes a whole thread, or its first message, only when every message in it is theirs; otherwise it needs `delete`.
- `resolve` covers resolving and reopening.
- `list` asks `read` for each thread, with up to 16 checks at once, and drops the threads you may not read.
- `users()` suggests people only to someone who may `write`, and the store looks only at authors of threads you may read.

The operations also sit behind the Console section `comments`, so `console.authorize` decides who reaches them at all.

## Subjects

A thread is about a subject: `{ kind, id }`. `kind` picks the numbering scope.

| Kind | `id` | Scope |
| --- | --- | --- |
| `page` | An app path such as `/pricing` | `site` |
| `content` | `<collection>/<id>` | `site` |

Numbers are unique inside a scope, so `?comment=3` names one thread of the site. Add your own kinds:

```ts [server/comments.ts]
import { defineCommentSubject, defineComments } from 'vite-hub/comments'

export default defineComments({
  authorize: ({ user }) => Boolean(user),
  subjects: [
    // Every version of a drop shares one number sequence.
    defineCommentSubject({ kind: 'drop', scope: id => `drop:${id.split('@')[0]}` }),
  ],
})
```

## Mentions

A message mentions people by id, and its text names each one with `@name`. The server checks both: the id must belong to a real person, and the text must contain `@` and that person's name. Where people come from:

- With [Auth](/docs/auth), `users()` and the mention check read the Better Auth users. `users()` searches their name, and returns only `id`, `name`, and `image`.
- Without Auth, they are the authors that comments know, and only those with a thread that you may read.

```ts [server/comments.ts]
export default defineComments({
  authorize: ({ user }) => Boolean(user),
  onMention: async ({ thread, message, mentioned }) => {
    await notify(mentioned, `/pricing?comment=${thread.n}`, message.body)
  },
})
```

`onMention` runs after the comment is saved, through `waitUntil` where the host has it. A failure is logged and never fails the comment. It receives only the people that the message mentions for the first time and that `authorize({ action: 'read', user: <mentioned>, thread })` lets read the thread. The mention stays in the text for the others.

## Overlay

In production, enable `console` with your access policy to serve the operation RPC that the overlay needs. With `console` omitted, the overlay runs only in development. With `console: false`, it is disabled in both modes.

`vitehub({ comments: { overlay } })` controls the comment UI that [the loader](/docs/comments/get-started#the-overlay) puts on your pages.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `overlay` | `false \| { paths?, exclude?, session? }` | `{}` | `false` adds no loader. |
| `overlay.paths` | `string[]` | every page | Globs of the pages that get the overlay, relative to the app base. `*` is one path segment, `**` any depth: `/docs/**` is `/docs` and everything below it. |
| `overlay.exclude` | `string[]` | none | Globs of the pages that never get it. |
| `overlay.session` | `"marker" \| "always"` | `"always"` | When the loader asks the server whether the visitor may read comments. `"always"` asks on page load and client-side navigation; `"marker"` also requires an app-managed `vitehub_session` cookie. See [Privacy](#content-security-policy-and-privacy). |

The globs are checked in the browser against `location.pathname`, so they apply to client-side navigation as well. The loader is on every page, but a page that the globs leave out makes no request at all. The loader follows navigation: when a visitor moves to a page that the globs leave out, the overlay hides and its `C` hotkey stops, and when they move to an allowed page it shows again. If the landing page was left out, the loader waits, and the first allowed page loads the overlay.

The loader and the overlay are served by your app below `/_vitehub/comments/`, as `loader.<hash>.js` and `overlay.<hash>.js`. The file names carry a hash of their content, and the tag names both, so a page always loads a loader and an overlay of the same build. They are sent with `Cache-Control: max-age=31536000`, and a new release has new names.

### Content Security Policy and privacy

- **CSP.** Both files come from your own origin, so `script-src 'self'` is enough, and `connect-src 'self'` covers the loader's `fetch`. With a nonce policy (`script-src 'nonce-…' 'strict-dynamic'`) the loader tag gets the nonce of the response's `Content-Security-Policy` automatically, in the Nitro middleware and in the Nuxt `render:html` hook. The loader loads the overlay with a dynamic `import()`, which `'strict-dynamic'` allows from a trusted script. The overlay builds its icons from SVG elements and sets no `innerHTML`, so it works under Trusted Types. It adopts its styles as a constructed stylesheet, which needs no `style-src 'unsafe-inline'`; where the browser has none, it falls back to a `<style>` element that carries the loader's nonce.
- **What gets the tag.** The middleware rewrites only UTF-8 `text/html` that is not compressed and has a `</body>` or `</html>`: streamed pages are rewritten as they stream, and fragments, JSON, and other types are never touched.
- **Privacy.** On each allowed page load and client-side navigation, the loader sends `POST /_vitehub/rpc/__call` with the session cookie and no other data. It receives your own user, and whether you may read and write, and nothing about anyone else. Everything else is downloaded only after `authorize` says you may read comments. Navigation rechecks authorization; a denied session removes the overlay and stops its comment client. The Console page never gets the loader.
- **Anonymous visitors.** The default works with ViteHub Auth, other session providers, and local development. Anonymous visitors receive no comments or overlay bundle. To skip even the session request for anonymous visitors, opt into `overlay: { session: 'marker' }` only if your app sets a readable `vitehub_session=1` cookie when signing in and clears it on sign-out. ViteHub Auth does not currently manage this marker. The marker holds no secret and grants no access: the server still authorizes every session request. The loader rereads it on navigation and destroys the overlay when it disappears.

```ts [vite.config.ts]
vitehub({ comments: { overlay: { session: 'always' } } })
```

## Database

With `server/comments.ts` and no `database` option, `vitehub()` turns the Database on and adds an empty default Database Definition (`.vitehub/comments/database.ts`) when the app has none, the way the Content cms preset does. Comments then use the default Database. Setting `database: false` fails the build with `COMMENTS_B0001`. To choose another Database:

```ts [vite.config.ts]
vitehub({ comments: { database: 'main' } })
```

For Postgres set `comments: { dialect: 'postgresql' }`. To wire the tables yourself, import `commentsSchema` from `vite-hub/comments/database` (SQLite, libSQL, D1) or `commentsPostgresSchema` from `vite-hub/comments/database/postgres`, and add it to your Database Definition.
