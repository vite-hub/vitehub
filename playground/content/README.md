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

Open <http://localhost:5173/login> and sign in as one of the playground users:

| User | Console access (`server/console-authorize.ts`) | Content access (`content.authorize`) |
| --- | --- | --- |
| `admin@vitehub.dev` | Every section | Read, write, publish |
| `editor@vitehub.dev` | Content only | Read, write, publish |
| `writer@vitehub.dev` | Content only | Read and write, no publish |

The public page at `/` lists published posts. It has no edit button: editors go to `/_vitehub/content`.
Users and sessions live in memory, so a restart signs everyone out. Documents persist in `.data`.
