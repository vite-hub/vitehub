# Edit pages in the Console

The Console edits, previews, and publishes docs pages through the ViteHub CMS. The docs site keeps rendering the Markdown files. The CMS stores drafts and publishes them, and the Console preview shows a draft through the docs UI.

## Turn it on

Install `vite-hub/nuxt` next to `@vite-hub/docs/nuxt`, and add one file:

```ts
// server/content.ts
import { defineContent } from "vite-hub/content"
import cms from "vite-hub/cms"
import { docsCollection } from "@vite-hub/docs"

export const content = defineContent({
  extends: [cms, { repo: "owner/name", publish: "pr", access: "roles" }],
  collections: { docs: docsCollection() },
})
```

Open `/_vitehub/content` and select **Docs**. The build reads this file without running it, so keep `defineContent({ extends, collections })` as written and give the `cms` options as string literals.

`docsCollection()` is a `documents()` collection over the pages:

- `path` is `content/**/*.md` by default, the default `dir` of the docs module. The folder before the first `*` must be the content folder, because the document id is the page file without `.md`. In a monorepo, pass `docsCollection({ path: "docs/content/**/*.md" })`, or set `root: "docs"` in the `cms` options.
- `fields` are the page frontmatter (`docsPageFields`). The Console validates them like the build does.
- Each document URL is its page URL: `content/docs/kv/index.md` is `/docs/kv`, `content/about.md` is `/about`, and `content/index.md` is `/`.
- `label` is `Docs`, and one document is a `Page`. Pass `label` to change it.

## Where drafts go

With `repo`, the CMS uses the GitHub store. It needs `VITEHUB_GITHUB_TOKEN`. A save commits to the `vitehub/content` branch. `publish: "pr"` opens a pull request into `main`. The site shows the change after the pull request merges and the site builds again.

Without `repo`, the CMS uses the Blob + Database store. Its Workspace starts empty, and a publish does not change the files that the site renders. Use it to try the editor on your machine. Import a page with:

```sh
vitehub content edit docs docs/kv/index --file content/docs/kv/index.md
```

Run `vitehub db generate` and `vitehub db migrate` once, so the Database has the CMS tables.

## Who may edit

`access: "roles"` uses the CMS roles of the Better Auth `admin` plugin. See the `@vite-hub/cms` README. Your own `authorize` replaces it. For example, everyone may edit on a development server and nobody in production:

```ts
export const content = defineContent({
  extends: cms,
  collections: { docs: docsCollection() },
  authorize: () => import.meta.dev,
})
```

## Preview

The Console preview pane opens the page URL with the draft. The page route reads the draft from `content.collection("docs").get(id)` and parses it like a published page. Fields that are not saved yet show too. A new page that exists only as a draft previews as well. The response is `Cache-Control: private, no-store`. A request with the Content preview cookie reads the drafts of every page. The sidebar, search, and previous and next links stay published.

The preview needs a server that renders the page. A prerendered page that a static host serves shows the published file.

Without `server/content.ts`, the page route reads only the published files and bundles nothing from Content.

## Dotted keys

Pages can write `navigation.order: 2` or a nested `navigation:` object. YAML keeps `navigation.order` as one key, so `docsPageFields` has a field for each dotted key: `navigation.title`, `navigation.order`, `navigation.group`, `navigation.kind`, `seo.title`, and `seo.description`. The Console shows them as fields and writes them back as dotted keys. Content keeps only the keys that have a field, so without these fields a save would drop them.
