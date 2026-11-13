---
title: Content SEO
description: Give documents public URLs, per-document SEO fields, head tags for any framework, a generated sitemap and robots.txt, and Markdown files for agents.
navigation.title: SEO
navigation.order: 12
icon: i-lucide-search-check
---

Content handles the SEO parts that depend on your documents: each document's URL, its search and social text, and the sitemap. Your pages render the tags. Content returns them in the `useHead()` shape, so any framework or server route can use them.

| Part | What it does |
| --- | --- |
| [`url`](#document-urls) | Each document's public URL, as `document.url`. |
| [`seo()`](#seo-fields) | Per-document title, description, social image, canonical URL, and `noindex`. |
| [`contentHead()`](#head-tags) | Head tags from a document, its `seo()` values, and site defaults. |
| [`defineContent({ seo })`](#sitemap-and-robotstxt) | Generated `/sitemap.xml` and `/robots.txt`. |
| [`seo: { markdown, llms }`](#markdown-for-agents) | Markdown copies of each page, `/llms.txt`, `/llms-full.txt`, and `/sitemap.md`. |
| [Console SEO group](#console) | Counters, fallbacks, and search and social previews. |

## Document URLs

Set `url` on a collection or singleton to give its documents a public URL. A pattern replaces `:id` with the document id and `:<field>` with a text or number field:

```ts [server/content.ts]
import { defineContent, seo } from 'vite-hub/content'
import { documents, singleton } from 'vite-hub/content/collections'
import { z } from 'zod'

export default defineContent({
  workspace: 'site',
  collections: {
    posts: documents({ path: 'posts/**/*.md', url: '/blog/:id', fields: { title: z.string(), seo: seo() } }),
    docs: documents({ path: 'docs/**/*.md', url: ({ id }) => id === 'index' ? '/docs' : `/docs/${id}`, fields: { title: z.string() } }),
    home: singleton({ path: 'home.md', url: '/', fields: { title: z.string() } }),
  },
})
```

`get()`, `list()`, `save()`, and the Console return `url` for a routable collection. Values are encoded per path segment, so the id `2026/hello` becomes `/blog/2026/hello`. An empty pattern field, or a function that returns `null`, gives `url: null`: the document has no page. Without `url`, reads leave the key out and `collection.routable` is `false`. [`content.resolve(path)`](/docs/content/configure#find-the-document-of-a-page) uses `url` to find a page's document.

A pattern must start with `/` and name only `:id` and defined fields. Otherwise loading the definition throws `CONTENT_R0006`.

In a collection with [locales](/docs/content/configure#locales), a pattern without `:locale` puts `/<locale>` before the URL of every locale but the source locale, so `/docs/:id` gives `/docs/guide` and `/es/docs/guide`. Write `:locale` in the pattern, such as `/:locale/docs/:id`, to place the locale yourself. A `url()` function receives `{ id, data, locale }`.

### Source URLs

A read-only Source (files Content does not edit) gets a `url` from `contentSource(input, { url })`. A Source document's id is its path without the leading slash and extension: `glob({ cwd: 'content' })` reads `content/guides/start.md` as `guides/start`. A `:<name>` in the pattern reads a frontmatter value.

```ts [server/content.ts]
import { contentSource, defineContent } from 'vite-hub/content'
import { glob } from 'vite-hub/source'

export default defineContent({
  source: contentSource(glob({ cwd: 'content', include: 'guides/*.md' }), { url: '/:id' }),
  seo: { sitemap: true },
})
```

A Source `url` adds its documents to the [sitemap](#sitemap-and-robotstxt), but Source reads do not return `document.url`. `content.resolve()`, Markdown copies, and `seo()` fields work only with collections.

## SEO fields

`seo()` is a normal field. Add it to collections whose pages need their own search and social text:

```ts [server/content.ts] fragment
import { z } from 'zod'
import { image, seo } from 'vite-hub/content'
import { documents } from 'vite-hub/content/collections'

const posts = documents({
  path: 'posts/**/*.md',
  url: '/blog/:id',
  fields: { title: z.string(), summary: z.string().optional(), seo: seo({ image: image() }) },
})
```

| Key | Type | Falls back to |
| --- | --- | --- |
| `title` | `string` | The document `title`, `name`, `label`, or `heading`. |
| `description` | `string` | The document `description`, `summary`, or `excerpt`, then the site default. |
| `image` | URL, or a Blob reference with `seo({ image: image() })` | The site default image. |
| `canonical` | Absolute URL, or a path that starts with `/` | The document `url`. |
| `noindex` | `boolean` | `false`. |

The field and each key are optional. Unknown keys fail validation, so a save catches a typo such as `descripton`. Long text still validates. Search results show about 60 title characters and 50 to 160 description characters. The field's JSON Schema has those lengths in `x-vitehub-seo` for forms and tools.

`seo()` is a record of validators, not a Zod or Valibot object, because those reject a Blob `image()`. By default the social image is an absolute or root-relative URL, such as `/og/home.png`. Pass `image()` from `vite-hub/content` to store a [Blob reference](/docs/blob/server-api) instead. Its issues come back under `seo.image`.

Values are stored as nested YAML in Markdown frontmatter, or nested JSON or YAML in [data files](/docs/content/configure#data-files).

## Head tags

`contentHead(document, options)` returns `{ title, meta, link, script?, htmlAttrs? }`. It reads `seo()` values, then the document's fields, then `defaults`. It needs no framework and runs on the server or in the browser. Import it from `vite-hub/content`, or `vite-hub/content/client` in browser code.

```vue [pages/blog/[...id].vue]
<script setup lang="ts">
import { contentHead } from 'vite-hub/content/client'

const route = useRoute()
const { data: post } = await useFetch(`/api/posts/${route.params.id}`)
const { data: settings } = await useFetch('/api/settings')

useHead(computed(() => contentHead(post.value, {
  site: { url: 'https://vitehub.dev', name: settings.value?.data.title },
  defaults: { description: settings.value?.data.description, image: settings.value?.data.socialImage },
})))
</script>
```

Nuxt has `useHead()` built in. In a Vue app, install `@unhead/vue`. In a plain server route, render the tags yourself, as `server/routes/blog/[...id].get.ts` in the Content playground does.

| Option | Description |
| --- | --- |
| `site.url` | Public origin for absolute canonical, `og:url`, and image URLs. |
| `site.name` | `og:site_name`, and the default title template `%s · <name>`. |
| `site.locale` | `og:locale`, such as `en_US`. |
| `defaults` | `{ title?, description?, image? }` fallbacks, often from a [settings document](/docs/content/configure#singletons-and-data-files). ViteHub has no settings schema, so you map your fields. |
| `titleTemplate` | `'%s \| Docs'`, a function, or `null` for none. A document without a title uses the default title as is. |
| `collection` | The document's collection, such as `content.collection('posts')`, or its JSON form with `schema`. `contentHead()` finds the `seo()` field by its marker, whatever its name, and titles the page with `titleField`. |
| `field` | The field that holds `seo()` values. Defaults to the `seo()` field of `collection`, then to `seo`. |
| `resolveImage` | Turns an image value into a URL. By default, strings stay as they are, and a Blob reference of the `default` store becomes its [`blob.serve`](/docs/blob/configure) URL, with its `route` and `publicBaseUrl`. The default reads the generated Blob config, so it works on the server. In the browser, or for signed or CDN URLs, pass your own. |
| `type` | `og:type`. Defaults to `article` for a document with a URL, else `website`. |
| `jsonLd` | `true` adds an `Article` or `WebPage` JSON-LD script. You can pass your own object. `<` is escaped, so document text cannot close the script. |

The result has `description`, `robots: noindex` when set, Open Graph `og:title`, `og:description`, `og:type`, `og:url`, `og:image`, `og:site_name`, and `og:locale`, Twitter `summary_large_image` or `summary` card tags, and a `canonical` link. Empty tags are left out.

### Pages in several locales

A document from a collection with [locales](/docs/content/configure#pages-in-each-locale) carries `locale`, and `get()` gives it `alternates`, the URL of each locale that has its own version. `contentHead()` reads both:

- `htmlAttrs: { lang }` is the locale of the version that the page shows. `useHead()` sets it on `<html>`.
- When the document has its own version in two or more locales, `link` has `{ rel: 'alternate', hreflang, href }` for each of them, and `hreflang: 'x-default'` for the source locale page.
- A page that shows the source locale because its locale has no translation (`fallback: true`) has `lang` of the source locale, and its canonical link points to the source locale page. `seo.canonical` still wins.

```ts fragment
contentHead(await docs.get('guide', { locale: 'es' }), { site: { url: 'https://vitehub.dev' } })
// htmlAttrs: { lang: 'es' }
// link: canonical https://vitehub.dev/es/docs/guide, alternate en /docs/guide, es /es/docs/guide, x-default /docs/guide
```

## Sitemap and robots.txt

Turn on the routes in `defineContent()`:

```ts [server/content.ts]
import { defineContent, seo } from 'vite-hub/content'
import { documents, singleton } from 'vite-hub/content/collections'
import { z } from 'zod'

export default defineContent({
  workspace: 'site',
  collections: {
    posts: documents({ path: 'posts/**/*.md', url: '/blog/:id', fields: { title: z.string(), seo: seo() } }),
    home: singleton({ path: 'home.md', url: '/', fields: { title: z.string() } }),
  },
  seo: { site: 'https://vitehub.dev', sitemap: true, robots: { disallow: ['/_vitehub'] } },
})
```

| `seo` option | Description |
| --- | --- |
| `site` | Public origin for absolute URLs. Defaults to the origin of each request. |
| `sitemap` | `true` serves `/sitemap.xml`. |
| `robots` | `true` serves a `/robots.txt` that allows every crawler. `{ disallow }` keeps paths out. It names `/sitemap.xml` when the sitemap is on. |

In a collection with locales, the sitemap lists each published translation at its own URL, with `locale` on each entry. It leaves out pages that show the source locale as a fallback: their canonical link points to the source locale page.

The sitemap lists:

- Every published document with a URL in a routable collection, except documents with `seo.noindex` or a `seo.canonical` that points elsewhere. `lastmod` is its `updatedAt` on `published`. Drafts are never listed.
- Every document of a Source with a [`url`](#source-urls), without `lastmod`. A Source without `url` is not listed.

One sitemap holds 50,000 URLs. Above that, `content.sitemap()` throws `CONTENT_R0009` and does not return a partial sitemap.

Like `/api/content/**`, the `vitehub()` Vite plugin and the Nuxt module generate both routes from the `defineContent()` call in `server/content.ts`, without running it. They do so when `seo` sets `sitemap` or `robots` to anything but literal `false`. The routes run on Nitro 3, in Vite and in Nuxt 5, and on every preset. Your own server route at `/sitemap.xml` or `/robots.txt` fails the build. A file in `public/` is served first.

Check the output from code:

```ts [server/utils/seo-check.ts]
import content from '../content'

export async function checkSeo() {
  await content.sitemap()  // [{ collection: 'posts', id: 'hello', loc: 'https://vitehub.dev/blog/hello', lastmod }]
  content.robots()         // 'User-agent: *\nDisallow: /_vitehub\n\nSitemap: https://vitehub.dev/sitemap.xml\n'
}
```

In another server, mount `defineContentSitemapHandler(content)` and `defineContentRobotsHandler(content)` yourself. Each one returns a Fetchable route, `{ fetch(request) }`, that Nitro and H3 accept as a route handler. You can also call `fetch(request)` directly. `renderContentSitemap(entries)` renders entries as sitemap XML, for example to add pages that are not Content documents.

## Markdown for agents

Agents read Markdown better than HTML. Two `seo` options serve your published Markdown documents as Markdown:

```ts [server/content.ts]
import { defineContent } from 'vite-hub/content'
import { documents } from 'vite-hub/content/collections'
import { z } from 'zod'

export default defineContent({
  workspace: 'site',
  collections: {
    posts: documents({ path: 'posts/**/*.md', url: '/blog/:id', fields: { title: z.string(), description: z.string().optional() } }),
  },
  seo: { site: 'https://example.com', llms: { title: 'Example', description: 'Notes about examples.' } },
})
```

| `seo` option | Description |
| --- | --- |
| `markdown` | `true` serves each page as Markdown at its URL plus `.md`, such as `/blog/hello.md`, and `/index.md` for `/`. The page URL also returns Markdown when the request sends `Accept: text/markdown` before `text/html`. |
| `llms` | `true`, or `{ title, description }`, serves `/llms.txt`, `/llms-full.txt`, and `/sitemap.md`. It also turns on `markdown`, because their links point at the `.md` copies. The title defaults to the host name. |

The copy starts with the document title, unless the body has its own heading, and its description as a quote. Root-relative links become absolute.

- `/llms.txt` follows the [llms.txt](https://llmstxt.org) format: the title, the description, a link to `/llms-full.txt`, then one section per collection, named by its `label`, with a link to the `.md` copy of each page and its description.
- `/llms-full.txt` joins the copy of every page, home page first.
- `/sitemap.md` lists every page, grouped by the first segment of its URL.

They list the same pages as the sitemap, but only from Markdown collections: published documents with a URL, without `seo.noindex` or a `seo.canonical` that points elsewhere. Drafts, JSON and YAML documents, and Sources are not listed.

Responses that can be Markdown carry `Vary: Accept`, so a cache keeps the HTML and the Markdown apart. When a request asks for Markdown, with `.md` or with `Accept`, and no page answers it, the response is a `404` with a Markdown body. The body names `/llms.txt` and the sitemaps, so an agent knows where to look next.

Check the output from code:

```ts [server/utils/agent-check.ts]
import content from '../content'

export async function checkAgentFiles() {
  await content.llms()                           // llms.txt
  await content.llms({ file: 'llms-full.txt' })
  await content.llms({ file: 'sitemap.md' })
  await content.markdown('/blog/hello.md')       // the copy, or null
}
```

ViteHub generates these routes from `server/content.ts` like the sitemap, when `seo` sets `markdown` or `llms` to anything but literal `false`. The Markdown copies are middleware, because no route pattern matches a URL plus `.md`. The middleware loads when the server starts, so it can see a missing page, but it loads `server/content.ts` only on the first request that asks for Markdown. In another server, mount `defineContentLlmsHandler(content)` at the three paths and `defineContentMarkdownHandler(content)` as middleware.

## Console

When a collection has a `seo()` field, the [Console editor](/docs/content/console) shows an **SEO** group below the document fields. It folds while empty, shows how many values are set, and opens when a value has an issue. It has:

- Title and description counters that turn amber past the recommended length.
- Placeholders that show the `contentHead()` fallback, such as the document title, summary, and URL.
- A search result preview, dimmed when the page is hidden from search engines.
- A 1.91:1 social card preview. A Blob image shows through the Blob serve route when it is on, else a placeholder.
