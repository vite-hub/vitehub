---
title: CMS
layout: landing
navigation.title: Overview
description: Store editable Markdown, JSON, and YAML documents from one file, edit them in the Console, and publish them to your site or to a pull request.
navigation.order: 1
icon: i-lucide-newspaper
---

::product-hero{tagline="Edit Markdown documents in the Console, keep every draft, and publish to your site or a pull request." hosts="Node, Docker, Cloudflare, Vercel"}
  :hero-figure{name="cms"}
::

The CMS is `vite-hub/cms`, built on [Content](/docs/content). Add `extends: cms` to `server/content.ts` to store your [document collections](/docs/content/configure#document-collections). It turns on Workspace, Database, and Blob, adds the Workspace and its history tables, and adds a Database when your app has none. You write no Workspace, Database, or schema code.

```ts [server/content.ts]
import { defineContent } from 'vite-hub/content'
import { documents } from 'vite-hub/content/collections'
import { cms } from 'vite-hub/cms'
import { z } from 'zod'

export default defineContent({
  extends: cms,
  collections: {
    posts: documents({ path: 'posts/**/*.md', fields: { title: z.string() } }),
  },
})
```

## Pick a setup

Start with the Blob + Database store. One option changes the store, and the collections stay the same.

| Setup | You add | You get |
| --- | --- | --- |
| [Blob + Database store](/docs/cms/get-started) | `extends: cms` in `server/content.ts` | Drafts, revisions, and published documents in your Blob store and Database, plus scheduled publishing. Runs wherever Blob and Database work, with no GitHub access. |
| [GitHub store, commits to `main`](/docs/cms/configure#github-store) | `extends: [cms, { repo: 'owner/name' }]`, and `VITEHUB_GITHUB_TOKEN` | Documents are files in your repository. A save is a commit on the `vitehub/content` draft branch. A publish is one commit on `main`. Checkout and Console edits meet in Git. No Blob store. |
| [GitHub store with pull requests](/docs/cms/configure#pull-request-mode) | `publish: 'pr'` in the same options | A publish opens a pull request into `main`. Review it, wait for checks, and merge it any way you like. The Console shows the link until it merges. |

::product-features
  :::product-feature-item{title="One line selects the preset" icon="i-lucide-file-code-2" to="/docs/cms/get-started"}
  Add `extends: cms` to `server/content.ts` with no extra settings.
  :::

  :::product-feature-item{title="No wiring to write" icon="i-lucide-blocks" to="/docs/cms/configure#what-the-preset-adds"}
  The preset adds the Workspace, its history tables, and a Database if needed. `vitehub inspect definitions` lists each piece.
  :::

  :::product-feature-item{title="Keep content in Git" icon="i-lucide-git-branch" to="/docs/cms/configure#github-store"}
  Set `repo` to keep published documents and drafts on separate branches, where each publish is a commit.
  :::

  :::product-feature-item{title="Publish through pull requests" icon="i-lucide-git-pull-request" to="/docs/cms/configure#pull-request-mode"}
  `publish: 'pr'` opens a pull request for each publish, keeping documents pending until it merges.
  :::

  :::product-feature-item{title="Decide who edits and publishes" icon="i-lucide-lock" to="/docs/cms/access"}
  Set `roles: true` and assign `viewer`, `commenter`, `editor`, or `publisher` roles, or write your own `authorize`.
  :::

  :::product-feature-item{title="Edit in the Console" icon="i-lucide-file-pen-line" to="/docs/content/console"}
  Editors open the Content section of the Console to edit fields and body text, compare versions, and publish reviewed changes.
  :::
::

## Edit, preview, and publish

The CMS stores your collections. [Content](/docs/content) does the rest, on both stores:

- [Edit in the Console](/docs/content/console): editor, media library, and revision history.
- [Preview drafts](/docs/content/preview) on your own pages before you publish.
- [Edit together](/docs/content/editing-together): presence, edit leases, and live editing.
- [Publish on a schedule](/docs/content/scheduling) on the Blob + Database store.
- [Edit from the terminal](/docs/content/cli) with `vitehub content`, or let an Agent draft and publish with the [Content Agent Capability](/docs/content/agent-capability).
- [Read published documents](/docs/content/server-api) from server routes and from the browser at `/api/content/**`.

## Deploy and operate

- [Roles and access](/docs/cms/access): give each user a role with the Better Auth `admin` plugin.
- [Hosts](/docs/cms/hosts): where each store runs and what to provision before a hosted deploy.
- [Limits and errors](/docs/cms/limits-and-errors): GitHub store limits and fixes for each error code.
- [Server API](/docs/cms/server-api): package exports and every preset option.
