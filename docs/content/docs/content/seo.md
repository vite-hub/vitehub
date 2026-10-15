---
title: Content SEO
description: Give documents public URLs, per-document SEO fields, head tags for any framework, and a generated sitemap and robots.txt.
navigation.title: SEO
navigation.order: 5
icon: i-lucide-search-check
---

Content gives you the parts of SEO that depend on your documents: where each document lives, what search results and social cards show for it, and which pages a sitemap lists. Your pages still render the tags. Content returns them in the shape `useHead()` takes, so any framework or plain server route can use them.

| Part | What it does |
| --- | --- |
| [`url`](#document-urls) | Maps each document to its public URL. Reads carry `document.url`. |
| [`seo()`](#seo-fields) | A field for per-document title, description, social image, canonical URL, and `noindex`. |
| [`contentHead()`](#head-tags) | Head tags from a document, its `seo()` values, and site defaults. |
| [`defineContent({ seo })`](#sitemap-and-robotstxt) | Generated `/sitemap.xml` and `/robots.txt`. |
| [Console SEO group](#console) | Counters, fallbacks, and search and social previews while editing. |

## Document URLs

Set `url` on a collection or singleton to say where its documents are published. A pattern replaces `:id` with the document id and `:<field>` with a text or number field:

```ts [server/content.ts]
import { defineContent, documents, seo, singleton } from 'vite-hub/content'
import { z } from 'zod'

export const content = defineContent({
  workspace: 'site',
  collections: {
    posts: documents({ path: 'posts/**/*.md', url: '/blog/:id', fields: { title: z.string(), seo: seo() } }),
    docs: documents({ path: 'docs/**/*.md', url: ({ id }) => id === 'index' ? '/docs' : `/docs/${id}`, fields: { title: z.string() } }),
    home: singleton({ path: 'home.md', url: '/', fields: { title: z.string() } }),
  },
})
```

Every read of a routable collection carries `url`: `get()`, `list()`, `save()`, and the Console. Pattern values are encoded per path segment, so the id `2026/hello` becomes `/blog/2026/hello`. A pattern whose field has no value, or a function that returns `null`, gives `url: null`: that document has no page. Collections without `url` leave the key out, and `collection.routable` is `false`.

A pattern must start with `/` and may only name `:id` and defined fields; anything else throws `CONTENT_R0006` when the definition loads.

## SEO fields

`seo()` is a field like any other. Add it to the collections whose pages need their own search and social text:

```ts [server/content.ts]
import { image } from 'vite-hub/blob'
import { documents, seo } from 'vite-hub/content'

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

The whole field and each key are optional, so an empty `seo` costs nothing. Unknown keys fail validation, so a typo such as `descripton` is caught on save. Long titles and descriptions still validate: search results show about 60 title characters and 50 to 160 description characters, and the field's JSON Schema carries those lengths in `x-vitehub-seo` for forms and tools.

`seo()` is a record of validators rather than a Zod or Valibot object, because those object schemas reject a Blob `image()`. Without `image`, the social image is a URL, absolute or root-relative, such as `/og/home.png`. Pass `image()` from `vite-hub/blob` to store a [Blob reference](/docs/blob/server-api) instead. Its issues come back under `seo.image`.

Values are stored as a nested YAML block in Markdown frontmatter, or nested JSON or YAML in [data files](/docs/content/configure#data-files).

## Head tags

`contentHead(document, options)` returns `{ title, meta, link, script? }`. It reads `seo()` values first, then the document's own fields, then `defaults`. It has no framework dependency, and it runs on the server or in the browser. Import it from `vite-hub/content`, or from `vite-hub/content/client` in browser code.

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

Nuxt has `useHead()` built in; in a Vue app, install `@unhead/vue`. On a plain server route, render the tags yourself, as the Content playground's `server/routes/blog/[...id].get.ts` does.

| Option | Description |
| --- | --- |
| `site.url` | Public origin. Makes the canonical URL, `og:url`, and image URLs absolute. |
| `site.name` | `og:site_name`, and the default title template `%s · <name>`. |
| `site.locale` | `og:locale`, such as `en_US`. |
| `defaults` | `{ title?, description?, image? }` fallbacks, often read from a [settings document](/docs/content/configure#singletons-and-data-files). ViteHub does not own a settings schema, so you map your fields. |
| `titleTemplate` | `'%s \| Docs'`, a function, or `null` for no template. A document without its own title uses the default title as is. |
| `collection` | The collection of the document, such as `content.collection('posts')`, or its JSON form with `schema`. `contentHead()` finds its `seo()` field by the field's marker, whatever its name, and names the page with its `titleField`. |
| `field` | The field that holds `seo()` values. Defaults to the `seo()` field of `collection`, then to `seo`. |
| `resolveImage` | Turns an image value into a URL. Defaults to strings as they are, and a Blob reference of the `default` store to the URL that [`blob.serve`](/docs/blob/configure) serves it at, with its `route` and `publicBaseUrl`. The default reads the generated Blob config, so it works on the server. In the browser, or for signed or CDN URLs, pass your own. |
| `type` | `og:type`. Defaults to `article` for a document with a URL and `website` otherwise. |
| `jsonLd` | `true` adds a generated `Article` or `WebPage` JSON-LD script, or pass your own object. `<` is escaped, so document text cannot close the script. |

The result includes `description`, `robots: noindex` when set, Open Graph `og:title`, `og:description`, `og:type`, `og:url`, `og:image`, `og:site_name`, and `og:locale`, Twitter `summary_large_image` or `summary` card tags, and a `canonical` link. Tags without a value are left out.

## Sitemap and robots.txt

Turn on the routes in `defineContent()`:

```ts [server/content.ts]
export const content = defineContent({
  workspace: 'site',
  collections: { posts, home },
  seo: { site: 'https://vitehub.dev', sitemap: true, robots: { disallow: ['/_vitehub'] } },
})
```

| `seo` option | Description |
| --- | --- |
| `site` | Public origin for absolute URLs. Defaults to the origin of each request. |
| `sitemap` | `true` serves `/sitemap.xml`. |
| `robots` | `true` serves `/robots.txt` that allows every crawler, or `{ disallow }` to keep paths out. It names `/sitemap.xml` when the sitemap is on. |

The sitemap lists every published document of a routable collection that has a URL. It leaves out documents with `seo.noindex`, and documents whose `seo.canonical` points to another URL. `lastmod` is the document's `updatedAt` on `published`. Drafts never reach it. One sitemap holds 50,000 URLs; beyond that Content warns and lists the first 50,000.

ViteHub generates both routes the same way it generates `/api/content/**`: the `vitehub()` Vite plugin and the Nuxt module read the `defineContent()` call in `server/content.ts` without running it. The routes are generated when the call sets `seo` with `sitemap` or `robots` that is not literally `false`. They run on Nitro 3, on Nuxt 4 with Nitro 2, and on every preset. A server route of your own at `/sitemap.xml` or `/robots.txt` conflicts with them and fails the build; a file in `public/` is served first.

Check the output from code:

```ts
await content.sitemap()  // [{ collection: 'posts', id: 'hello', loc: 'https://vitehub.dev/blog/hello', lastmod }]
content.robots()         // 'User-agent: *\nDisallow: /_vitehub\n\nSitemap: https://vitehub.dev/sitemap.xml\n'
```

In another server, mount `defineContentSitemapHandler(content)` and `defineContentRobotsHandler(content)` yourself. `renderContentSitemap(entries)` renders entries as sitemap XML, for example to merge them with pages that are not Content documents.

## Console

When a collection has a `seo()` field, the [Console editor](/docs/content/console) shows an **SEO** group of property rows below the document fields. It folds while the field is empty, shows how many values are set, and opens on its own when one of them has an issue:

- Title and description with character counters that turn amber past the recommended length.
- Empty inputs show what `contentHead()` falls back to as placeholders, such as the document title and summary, and the document URL for the canonical link.
- A search result preview, dimmed when the page is hidden from search engines.
- A social card preview at 1.91:1. A Blob image shows through the Blob serve route when it is enabled, and a placeholder otherwise.
