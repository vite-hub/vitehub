---
title: About this demo
description: Why this site exists, what it runs on, and where its source is.
---

Lumen does not exist. This site exists to show [`@vite-hub/docs`](https://vitehub.dev/docs/docs-site) as a real app outside the ViteHub repository: it installs the published preview packages, it builds with Nuxt, and it runs as one Cloudflare Worker.

## What runs here

| Part | Where |
| --- | --- |
| Pages | Markdown files in `content/` of [`packages/docs/playground`](https://github.com/vite-hub/vitehub/tree/main/packages/docs/playground) of vite-hub/vitehub |
| Site | A Nuxt 4 app with `@vite-hub/docs/nuxt` and `vite-hub/nuxt` |
| Host | Cloudflare Workers. Two D1 databases: `users` for users, sessions, and OAuth, and `content` for the CMS history, editor sessions, and comments. Two R2 buckets: the CMS documents, and the media library |
| Editing | The ViteHub CMS on the Blob + Database store. Docs pages render from the repository; blog posts, releases, and authors render from the CMS |
| Deploys | A GitHub Actions workflow that builds and deploys on each push to `main` |

## Why a standalone page

This page is `content/about.md`. A file outside `content/docs/` is a plain article under the site header, without the sidebar and the section rail. Use it for pages such as About, Pricing, or Privacy.

## Contact

Open an issue in [vite-hub/vitehub](https://github.com/vite-hub/vitehub/issues), or leave a comment on any page when you are signed in.
