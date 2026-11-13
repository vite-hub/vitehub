# Lumen docs: a demo of @vite-hub/docs

A docs site for Lumen, a made-up image CLI, built with [`@vite-hub/docs`](https://vitehub.dev/docs/docs-site) and deployed as one Cloudflare Worker. It uses the workspace packages, so every change to `@vite-hub/docs`, the CMS, Auth, or Comments runs here before it ships.

Live: <https://docs-demo.vitehub.dev>

## What it shows

- 24 Markdown pages in 4 sections with categories and icons, a tutorial with the code panel, guides, reference tables, a standalone page (`/about`), callouts, tabs, steps, code groups, and `::agent-only` blocks.
- A landing page (`app/pages/index.vue`) whose title, description, and body are `content/index.md`, with the latest release and posts from the CMS.
- Three CMS collections beside the docs: a blog (`/blog`, 5 posts), a changelog (`/changelog`, 7 releases), and authors (4). They exist only in the CMS, and the site reads the published documents on each request, so a publish is live within a minute. RSS at `/blog/rss.xml` and `/changelog/rss.xml`.
- Five isometric illustrations, each in a light and a dark file, in the media library of the Console and served at `/media/illustrations/`.
- Agent resources: `/raw/<page>.md`, `/llms.txt`, `/llms-full.txt`, `/sitemap.xml`, `/sitemap.md`, `/robots.txt`, and the docs MCP server at `/mcp`.
- The hosted [ViteHub Console](https://console.vitehub.dev), with a signed Operations endpoint in the demo Worker, the CMS (`docsCollection()`), and Comments. Agents use `https://console.vitehub.dev/mcp/account`.
- The tools pill on every page for a signed-in editor.

The docs assistant: the **Ask** button on every page opens a chat that answers from the pages and links them. It runs on Maxi's ChatGPT plan through the `chatgpt` Connection, with a model-backed Driver, because a Worker cannot start Codex. `server/agents/docs/agent.ts` is the Agent, `server/connections/chatgpt.ts` the Connection. The grant is in the `users` D1 Database, encrypted with the `VITEHUB_CONNECTIONS_KEY` secret.

## Files

| File | Use |
| --- | --- |
| `nuxt.config.ts` | `vite-hub/nuxt` with the `cloudflare` host, and `@vite-hub/docs/nuxt` |
| `content/` | The docs pages |
| `app/pages/`, `app/components/` | The landing, blog, and changelog pages, and the `::illustration` and `::illustrated-cards` blocks |
| `blog/`, `changelog/`, `authors/` | The seed of the CMS collections. `scripts/seed-content.mjs` saves and publishes them through `vitehub content` |
| `illustrations/` | The generators and the SVG files of the illustrations. `scripts/upload-illustrations.mjs` uploads them to the media library |
| `.claude/skills/illustration-isometric-mono/` | The illustration skill from [skills.sh](https://skills.sh/mengto/skills/illustration-isometric-mono), copied by hand, see below |
| `server/auth.ts` | Better Auth in the `users` Database through `authDatabase("users")`: email and password, GitHub when its secrets exist, the admin plugin with the CMS roles, and the CMS roles |
| `server/databases/users/`, `server/databases/content/` | Two D1 Database Definitions and their migrations. `users`: the Better Auth and OAuth tables. `content`: the CMS history and editor sessions, and the Comments tables |
| `server/content.ts` | The CMS with `access: 'roles'` and `database: 'content'`: `docsCollection()`, and the `blog`, `changelog`, and `authors` collections. Today on the Blob + Database store (R2 and D1). With a GitHub token it moves to the GitHub store of this repository with `publish: 'commit'`, see the comment in the file |
| `server/comments.ts`, `server/console-authorize.ts` | Comments in the `content` Database (`database: "content"`), and Console access with the CMS roles |
| `server/api/blog/`, `server/api/changelog/`, `server/routes/*/rss.xml.get.ts` | The published posts and releases, parsed with the docs parser, and the feeds |

## Run it

From the repository root:

```sh
corepack pnpm install
corepack pnpm exec vp run --cache -t playground-docs-demo#build
cd packages/docs/playground
corepack pnpm exec wrangler d1 migrations apply vitehub-docs-demo-users --local --config .output/server/wrangler.json
corepack pnpm exec wrangler d1 migrations apply vitehub-docs-demo-content --local --config .output/server/wrangler.json
corepack pnpm dlx wrangler@4.158.0 dev --config .output/server/wrangler.json --host docs-demo.vitehub.dev --upstream-protocol https
```

`--host` and `--upstream-protocol` give the local Worker the origin of `publicUrl`, so Better Auth accepts the sign-in. wrangler 4.147 has no local runtime for the compatibility date of the build, so local runs use a newer wrangler.

## Deploy

The Console uses signed requests. After deploying, link `https://docs-demo.vitehub.dev` in [console.vitehub.dev](https://console.vitehub.dev), set the `VITEHUB_CONSOLE_KEY_<NAME>` public-key variable that it supplies as a Worker secret, and check the connection. The app no longer serves Console pages or Console OAuth endpoints.

The `docs-demo deploy` job of `ci.yml` builds the site, applies the D1 migrations, and deploys the Worker on each push to `main`, with the Cloudflare token of the Production environment. `publicUrl` in `site.ts` is a custom domain, so ViteHub serves the Worker on `docs-demo.vitehub.dev` and turns off its `workers.dev` address.

On a new deploy, seed the CMS and the media library with a signed-in admin's session cookie:

```sh
VITEHUB_CONSOLE_COOKIE="..." node scripts/upload-illustrations.mjs https://docs-demo.vitehub.dev
VITEHUB_CONSOLE_COOKIE="..." node scripts/seed-content.mjs https://docs-demo.vitehub.dev
```

Worker secrets: `VITEHUB_SECRET` (32 or more characters), `VITEHUB_CONTENT_KEY` (32 random bytes, for the Console preview), `VITEHUB_CONNECTIONS_KEY` (32 random bytes, encrypts the ChatGPT grant; a new key loses the grant), `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` (GitHub sign-in, from the vite-hub OAuth app "Lumen docs demo"). They live in the `Production` environment of vite-hub/vitehub as `DOCS_DEMO_<name>` (the client ID as a variable), and the `docs-demo deploy` job passes them to `wrangler deploy --secrets-file`. The demo does not use `VITEHUB_ADMIN_EMAILS`: only the GitHub account of onmax gets the admin role (see `server/auth.ts`). Not set yet: `VITEHUB_GITHUB_TOKEN` (a fine-grained token for vite-hub/vitehub, with contents and pull requests read and write, for the GitHub store).

Resources: the Worker `vitehub-docs-demo`, the D1 databases `vitehub-docs-demo-users` (binding `DB_USERS`) and `vitehub-docs-demo-content` (binding `DB_CONTENT`), and the R2 buckets `vitehub-docs-demo` (binding `BLOB`, the CMS documents, not served) and `vitehub-docs-demo-media` (binding `BLOB_MEDIA`, the media library, served at `/media`). The D1 database `vitehub-docs-demo` is the old single database. The site no longer uses it; its rows were copied to the two new databases on 2026-11-03, and it stays for a rollback until someone deletes it.

Workarounds in the app, with the finding behind each:

- `console.authorize` is an absolute path in `nuxt.config.ts`: with an `app/` folder, ViteHub resolves a relative path from `app/`. Fixed by [vite-hub/vitehub#3292](https://github.com/vite-hub/vitehub/pull/3292); the absolute path keeps working after it.
- `routeRules` with `swr: 60` cache text, not a `Response`, so the RSS routes return a string and set the content type.
- `nitro.cloudflare.wrangler.assets.run_worker_first` for the docs pages and `/api/_docs/*`: without it the static prerendered pages answer first, so the Console preview pane stays blank and `Accept: text/markdown` gets HTML.
- `linkChecker.excludeLinks`: the Worker renders `/blog`, `/changelog`, `/_vitehub`, and `/media/` at request time, so the build output has no file for them.
- `h3` in `dependencies`: the Workflow Worker bundle of the Agent resolves `h3` from the generated `.nuxt` folder, where pnpm does not hoist it.
- `workspace: {}` in `server/agents/docs/agent.ts`: it says that the Agent owns the pages Workspace of `docsAssistant`, so the build bundles the pages for the Worker.
- `agents`, `@vite-hub/schedule`, `@vite-hub/shell`, and `@vite-hub/workflow` in `dependencies`: the Worker bundle imports them on paths that this app does not use (the docs MCP server on Workers, the Console Schedule route, the Workspace shell), and `wrangler deploy` fails when they are missing.
- `NODE_OPTIONS=--max-old-space-size=6144` in the build script: the Nitro bundle runs out of the default heap.

## Illustrations

The illustrations follow the skill [`illustration-isometric-mono`](https://skills.sh/mengto/skills/illustration-isometric-mono) of mengto/skills: true isometric dioramas on one slab, generated as SVG from a kit. `npx skills add mengto/skills --skill illustration-isometric-mono` cannot install it (the CLI fails to parse the `description` of its SKILL.md and skips it), so it is copied from commit `1de14e2` of the repository into `.claude/skills/`. The one deliberate change is the palette: a zinc ramp for light and another for dark, in `illustrations/iso.mjs`, instead of the skill's green, so they match the black, white, and zinc theme of the docs.

Rebuild one: `node illustrations/hero.gen.mjs illustrations/svg/hero-light.svg "Lumen" --theme light`. Check it with `node illustrations/lint.mjs <file> --prefix <prefix>` and `node illustrations/ramp-check.mjs <file>`.

## Review

Comment on the live pages with ViteHub Comments: sign in to the Console, open the page tools, and comment on a page. An Agent connected through MCP can read and answer the comments.
