# Content playground

A real ViteHub app with Content documents. It uses app Auth, the Blob + Database Store for the
`site` Workspace, and two document collections in `server/content.ts`.

```bash
mkdir -p playground/content/.vitehub/data/database
pnpm --dir playground/content run db:migrate
pnpm --dir playground/content run dev
```

The migrations in `server/databases/content/migrations` are committed. `0000` to `0005` were written by hand;
`vitehub database generate` wrote `20261102185656_auth`. Generation needs the literal schema keys in `server/databases/content/index.ts`
until #2377 lands.

Open <http://localhost:5173/login> and sign in as one of the playground users. `server/auth.ts` installs the Better
Auth `admin` plugin with the CMS roles, `admin(cmsAccess)`, and gives each playground user its role at sign-up. Other
users get `user`, which has no CMS permission. `cmsContentAuthorize` and `cmsCommentsAuthorize` from
`vite-hub/cms/access` then decide in `server/content.ts` and `server/comments.ts`.
`vitehub cms roles` lists the roles.

| User | CMS role | Content | Comments |
| --- | --- | --- | --- |
| `admin@vitehub.dev` | `admin` | Read, write, publish | Read, comment, resolve |
| `editor@vitehub.dev` | `publisher` | Read, write, publish | Read, comment, resolve |
| `writer@vitehub.dev` | `editor` | Read and write, no publish | Read, comment, resolve |
| `reviewer@vitehub.dev` | `commenter` | Read drafts only | Read, comment, resolve |

An admin changes a role in the Console Auth section.

`GET /api/users` lists the users for an admin. `server/routes/api/users.get.ts` checks the role with
`requireAuthorization(event, ...)` and calls the `admin()` plugin's `listUsers` on `useAuth(event).api`. Another user
gets `403`, and a signed-out caller gets `401`.

The playground uses `console: { auth: false }`, so `vitehub content` and the other commands call the dev server without
a signature. The Console at console.vitehub.dev calls apps from its server, so it cannot open this dev server.

`realtime: true` turns on the live co-editing rooms. The live editor was part of the Console that the app served,
which is removed. The room saves the draft a few seconds after
typing stops, and History names everyone who edited. A post that uses Markdown the editor cannot keep, such as an
footnote definition the base parser drops, opens read-only in the room and stays editable in Source by one editor at a time. The sessions
table stores the room's `live` lease in its text `kind` column, so the committed migration needs no change.

Media in the Content section stores files in `.vitehub/data/blob`. Editors upload files and edit alt text,
focal points, and crops; admins and publishers also move and delete them, since they can publish.

The public page at `/` lists published posts. It has no edit button: editors use the Content section of the Console, or `vitehub content`.

The `docs` collection keeps each page in English and Spanish, with `locales: ['en', 'es']`. `server/routes/[...path].get.ts`
serves every published docs page: `/docs/guide` in English and `/es/docs/guide` in Spanish, or in English with a note
while the page has no translation. Its head has `<html lang>`, the canonical link, and an `hreflang` link for each
locale. In the Console, the docs editor switches between `EN` and `ES` next to the title. You can also save a translation
from server code with `content.collection('docs').save(id, input, { locale: 'es' })`, or with an Agent that has the
`content()` Capability.

`server/agents/translator.ts` writes the Spanish page. The `write:after` hook in `server/workspaces/site.ts` enqueues the
`translate` job of `server/queues/translate.ts` when an English page changes on the draft, also after `vitehub push`, and
the job runs the Agent. Start the server with `AI_GATEWAY_API_KEY` set. To try it from a local folder, sign in, then pass
the session cookie to the CLI, because the Console uses app Auth:

```bash
export VITEHUB_CONSOLE_COOKIE='better-auth.session_token=...'
pnpm vitehub pull site --dir content --ref draft --url http://localhost:5173
# edit content/docs/en/guide.md
pnpm vitehub push --message "Edit the guide"
pnpm vitehub pull   # brings back content/docs/es/guide.md with derivedFrom
```

`server/comments.ts` turns on Comments. Sign in, then open `/?vitehub` (or the "Comment on this site" link). Press `C`
and click the page to pin a comment; open the same page as a second user in another browser profile to see their
pins, avatar, and cursor live. Press `E` and click the site title or a post title, which carry `contentField()`
attributes, to edit the text in place: the edit saves a draft that the Content section of the Console shows and publishes. The
writer edits but cannot publish, and the reviewer only comments. The Comments section of the Console lists every thread. Migrations `0002_comments` to
`0004_comments_scope` add the tables; they are written by hand.
Users and sessions live in the `content` Database: `authDatabase("content")` in `server/auth.ts` adds the Better Auth
tables to it, and `20261102185656_auth` is the migration that `vitehub database generate --name auth` wrote for them. The accounts
in `server/roles.ts` get their CMS role at sign-up. `admin@vitehub.dev` is the admin.
Documents persist in `.data`.
