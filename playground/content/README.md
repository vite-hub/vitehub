# Content playground

A real ViteHub app that edits Content documents in the Console. It uses app Auth, the Blob + Database Store for the
`site` Workspace, and two document collections in `server/content.ts`.

```bash
mkdir -p playground/content/.vitehub/data/database
pnpm --dir playground/content run db:migrate
pnpm --dir playground/content run dev
```

The migration in `server/databases/content/migrations` is committed. `vitehub db generate` cannot regenerate it on this
base yet: drizzle-kit cannot load `@vite-hub/workspace/blob-database`, and generation needs the literal schema keys in
`server/databases/content/config.ts` until #2377 lands.

Open <http://localhost:5173/login> and sign in as one of the playground users. `server/auth.ts` installs the Better
Auth `admin` plugin with the CMS roles, `admin(cmsAccess)`, and gives each playground user its role at sign-up. Other
users get `user`, which has no CMS permission. `cmsContentAuthorize`, `cmsCommentsAuthorize`, and `cmsConsoleAuthorize`
from `vite-hub/cms/access` then decide in `server/content.ts`, `server/comments.ts`, and `server/console-authorize.ts`.
`vitehub cms roles` lists the roles.

| User | CMS role | Console sections | Content | Comments |
| --- | --- | --- | --- | --- |
| `admin@vitehub.dev` | `admin` | Every section | Read, write, publish | Read, comment, resolve |
| `editor@vitehub.dev` | `publisher` | Content, Comments | Read, write, publish | Read, comment, resolve |
| `writer@vitehub.dev` | `editor` | Content, Comments | Read and write, no publish | Read, comment, resolve |
| `reviewer@vitehub.dev` | `commenter` | Content, Comments | Read drafts only | Read, comment, resolve |

An admin changes a role in the Console Auth section.

`realtime: true` turns on live co-editing: open a post as two users (for example the editor and the writer in two
browser profiles) and both edit it at once, with carets and field avatars. The room saves the draft a few seconds after
typing stops, and History names everyone who edited. A post that uses Markdown the editor cannot keep, such as an
footnote definition the base parser drops, opens read-only in the room and stays editable in Source by one editor at a time. The sessions
table stores the room's `live` lease in its text `kind` column, so the committed migration needs no change.

Media at `/_vitehub/content/-/media` stores files in `.vitehub/data/blob`. Editors upload files and edit alt text,
focal points, and crops; admins and publishers also move and delete them, since they can publish.

The public page at `/` lists published posts. It has no edit button: editors go to `/_vitehub/content`.

`server/comments.ts` turns on Comments. Sign in, then open `/?vitehub` (or the "Comment on this site" link). Press `C`
and click the page to pin a comment; open the same page as a second user in another browser profile to see their
pins, avatar, and cursor live. Press `E` and click the site title or a post title, which carry `contentField()`
attributes, to edit the text in place: the edit saves a draft that `/_vitehub/content` shows and publishes. The
writer edits but cannot publish, and the reviewer only comments. The Comments section of the Console lists every thread. Migrations `0002_comments` to
`0004_comments_scope` add the tables; they are written by hand for the same reason as the others.
Users and sessions live in memory, so a restart signs everyone out. Documents persist in `.data`.
