# Launch SEO easy wins

## Decision

Keep the SEO slice inside the existing Docus stack. Do not add a broad SEO bundle or start a keyword/rebrand project.

ViteHub already extends Docus 5.11 and sets the public site name and URL (`docs/nuxt.config.ts:5-11`). Docus already installs `@nuxtjs/robots` and `nuxt-og-image`, prerenders `/sitemap.xml`, and points `robots.txt` at it. Its default landing also supplies canonical, Open Graph, generated social-image, and `WebSite` JSON-LD behavior. ([Docus config](https://github.com/nuxt-content/docus/blob/v5.11.0/layer/nuxt.config.ts), [default landing](https://github.com/nuxt-content/docus/blob/v5.11.0/layer/app/templates/landing.vue), [`useSeo` source](https://github.com/nuxt-content/docus/blob/v5.11.0/layer/app/composables/useSeo.ts), [MIT license](https://github.com/nuxt-content/docus/blob/v5.11.0/LICENSE))

The gap is that ViteHub's custom landing, docs, and blog pages replace Docus's default pages while reproducing only part of that metadata.

## Current evidence

Checked against production on 2026-07-11 with a Googlebot user agent:

| Surface                                           | Current result                                                                                                                                                                                                                | Action                                                                 |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [`/`](https://vitehub.dev/)                       | Returns indexable HTML to Googlebot, but `<title>` is only `ViteHub`; it has a description, `og:site_name`, `og:title`, and `twitter:card`, but no canonical, `og:description`, `og:url`, `og:type`, share image, or JSON-LD. | Fix now.                                                               |
| [`/robots.txt`](https://vitehub.dev/robots.txt)   | Allows crawling and names the sitemap.                                                                                                                                                                                        | Keep as-is.                                                            |
| [`/sitemap.xml`](https://vitehub.dev/sitemap.xml) | Contains 99 documentation URLs, but omits `/`, `/blog`, and both tutorial URLs.                                                                                                                                               | Complete after metadata, in this PR if the route override stays small. |
| Content frontmatter                               | All 102 Markdown pages have a title and description. Five title pairs are duplicated across Server Primitive and Capability pages: Database, KV, Schedule, Blob, and Sandbox.                                                 | Optional cleanup; no bulk rewrite.                                     |

Both slash and non-slash documentation URLs currently return `200`, while internal Nuxt links are configured to append slashes. Canonical tags should therefore normalize to the trailing-slash form, and the sitemap should list that same form. Google recommends absolute self-referential canonicals and consistent canonical URLs in sitemaps. ([Google canonical guidance](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls), [Google sitemap guidance](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap))

Plain command-line clients receive the intentional AI-readable Markdown representation at `/`, but a Googlebot request receives HTML. That content negotiation is not an SEO blocker; retain a Googlebot-HTML check in verification.

Reproduction:

```bash
curl -fsSL \
  -A 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' \
  -H 'Accept: text/html' \
  https://vitehub.dev/

curl -fsSL https://vitehub.dev/robots.txt
curl -fsSL https://vitehub.dev/sitemap.xml
```

## Recommended repo changes

1. **Let the descriptive landing title reach `<title>`.** `docs/app/pages/index.vue:4` currently forces every landing title to `ViteHub`, overriding the descriptive title at lines 6-10. Remove that constant template or use the same `%s` pattern as Doctor. Keep the approved visible headline, HTML title, and `og:title` mutually consistent. Google uses `<title>`, the visible main heading, and `og:title` when generating title links. ([Google title-link guidance](https://developers.google.com/search/docs/appearance/title-link))

2. **Restore Docus's default landing SEO behavior.** Use the existing `useSeo({ type: "website", ... })` plus `defineOgImage("Landing", ...)` pattern, or its explicit equivalent, in the custom landing. This supplies the missing canonical, Open Graph URL/description/type, generated social card, and `WebSite` JSON-LD without a new dependency. Keep one human-readable description that accurately summarizes the approved Agent-first positioning; do not add a keyword list. Google may use a specific, high-quality meta description for the search snippet, and `WebSite` structured data is its strongest site-name signal. ([Google snippet guidance](https://developers.google.com/search/docs/appearance/snippet), [Google site-name guidance](https://developers.google.com/search/docs/appearance/site-names), [Nuxt `useSeoMeta`](https://nuxt.com/docs/4.x/api/composables/use-seo-meta))

3. **Make the sitemap complete and canonical.** Docus's built-in sitemap queries `docs` plus its optional `landing` collection; ViteHub defines custom `docs` and `blog` collections and a route-owned landing, so the home and blog routes fall outside that generator. Override the application sitemap narrowly to include `/`, `/blog/`, the two blog documents, and all docs using the preferred URL form. ([Docus sitemap route](https://github.com/nuxt-content/docus/blob/v5.11.0/layer/server/routes/sitemap.xml.ts), [Docus collection selection](https://github.com/nuxt-content/docus/blob/v5.11.0/layer/server/utils/content.ts))

4. **Add one output-level regression check.** After generation, assert that the home HTML has a descriptive title, canonical, description, Open Graph image/description/URL, and `WebSite` JSON-LD; assert that `robots.txt` references the sitemap; assert that the sitemap contains the home, blog, tutorial, and representative docs URLs. Also fetch the home with a Googlebot user agent so AI-readable content negotiation cannot accidentally replace crawler HTML.

## Next narrow follow-up

Add normalized canonicals to the custom docs and blog routes. `docs/app/composables/useDocsPage.ts` and both blog page components currently stop at title/description/Open Graph title. Reusing Docus's SEO composable there can emit one absolute canonical and matching `og:url` per route, normalized to the configured trailing-slash policy. Keep this separate from the landing PR so the rendering behavior of every custom route can be checked together.

The five duplicate documentation-title pairs can follow later through page-specific SEO titles that leave visible headings unchanged. They are smaller than the missing landing canonical and sitemap signals.

## Optional free/open-source follow-up tools

- **Use Unlighthouse once against the preview and once after production deploy.** It is a free, MIT-licensed CLI that crawls the site and reports titles, descriptions, share images, and links across routes. Run it ad hoc rather than adding a runtime dependency: `pnpm dlx unlighthouse --site <preview-url>`. ([official docs](https://unlighthouse.dev/), [source and license](https://github.com/harlan-zw/unlighthouse))
- **Use Lighthouse only for a focused single-page check or a later CI guard.** Lighthouse is open source and supports SEO audits from Chrome DevTools, the CLI, or a Node module; Unlighthouse already runs it site-wide, so installing both now adds no value. ([official documentation](https://developer.chrome.com/docs/lighthouse/overview), [Apache-2.0 source](https://github.com/GoogleChrome/lighthouse))
- **After deploy, submit the corrected sitemap and inspect `/` in Google Search Console.** Search Console is free but not open source, so it is an operational verification step rather than a repo dependency. Its URL Inspection view reports rendered HTML and selected canonicals; its Sitemaps report records fetch and parsing errors. ([URL Inspection](https://support.google.com/webmasters/answer/9012289), [Sitemaps report](https://support.google.com/webmasters/answer/7451001))

## Explicitly out of scope

- Rebrand, keyword campaign, backlink campaign, or content calendar.
- A second robots/OG module or the full `@nuxtjs/seo` bundle on top of Docus.
- Analytics, marketing pixels, or a large structured-data taxonomy.
- Changing the AI-readable Markdown response, because verified search-crawler requests already receive HTML.
