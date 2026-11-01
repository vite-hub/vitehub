---
title: CMS
navigation.title: Overview
description: Store editable Markdown, JSON, and YAML documents from one file, edit them in the Console, and publish them to your site or to a pull request.
navigation.order: 1
icon: i-lucide-newspaper
---

::product-hero{tagline="Edit Markdown documents in the Console, keep every draft, and publish to your site or a pull request." hosts="Node, Docker, Cloudflare, Vercel" video="/videos/cms-demo.mp4" poster="/videos/cms-demo.jpg" video-label="An editor writes a post in the ViteHub Console and publishes it"}
::

The CMS is one preset for [Content](/docs/content). Add `extends: cms` to `server/content.ts`, and ViteHub stores your [document collections](/docs/content/configure#document-collections): it turns on Workspace, Database, and Blob, adds the Workspace and its history tables, and adds a Database when the app has none. You write no Workspace Definition, no Database Definition, and no schema.

```ts [server/content.ts]
import { defineContent, documents } from 'vite-hub/content'
import { cms } from 'vite-hub/cms'
import { z } from 'zod'

export const content = defineContent({
  extends: cms,
  collections: {
    posts: documents({ path: 'posts/**/*.md', fields: { title: z.string() } }),
  },
})
```

## Pick a setup

Start with the Blob + Database store. Change the store with one option, without changing the collections.

| Setup | You add | You get |
| --- | --- | --- |
| [Blob + Database store](/docs/cms/get-started) | `extends: cms` in `server/content.ts` | Drafts, revisions, and published documents in your Blob store and Database. Every host where Blob and Database work. Scheduled publishing. No GitHub access. |
| [GitHub store, commits to `main`](/docs/cms/configure#github-store) | `extends: [cms, { repo: 'owner/name' }]`, and `VITEHUB_GITHUB_TOKEN` | Documents are files in your repository. A save is a commit on the `vitehub/content` draft branch, and a publish is one commit on `main`. Edits in a checkout and edits in the Console meet in Git. No Blob store. |
| [GitHub store with pull requests](/docs/cms/configure#pull-request-mode) | `publish: 'pr'` in the same options | A publish opens a pull request into `main`. Review it, wait for checks, and merge it with any method. The Console shows the link until it merges. |

::product-features
  :::product-feature-item{title="One line selects the preset" icon="i-lucide-file-code-2" to="/docs/cms/get-started"}
  `extends: cms` in `server/content.ts`. `vitehub()` needs no feature settings for it.
  :::

  :::product-feature-item{title="No wiring to write" icon="i-lucide-blocks" to="/docs/cms/configure#what-the-preset-adds"}
  The preset adds the Workspace, its history tables, and a Database when the app has none. `vitehub inspect definitions` lists each part.
  :::

  :::product-feature-item{title="Keep content in Git" icon="i-lucide-git-branch" to="/docs/cms/configure#github-store"}
  Set `repo`. Published documents are on one branch, drafts are on another, and a publish is a commit.
  :::

  :::product-feature-item{title="Publish through pull requests" icon="i-lucide-git-pull-request" to="/docs/cms/configure#pull-request-mode"}
  `publish: 'pr'` opens one pull request for each publish. The documents stay pending until it merges.
  :::

  :::product-feature-item{title="Decide who edits and publishes" icon="i-lucide-lock" to="/docs/cms/configure#access"}
  `authorize` allows or denies `read`, `write`, and `publish` for each user and Agent.
  :::

  :::product-feature-item{title="Edit in the Console" icon="i-lucide-file-pen-line" to="/docs/content/console"}
  Editors open `/_vitehub/content`, edit fields and the body, compare versions, and publish what they reviewed.
  :::
::

## Edit, preview, and publish

The CMS stores the collections. [Content](/docs/content) owns everything you do with them, on both stores:

- [Edit in the Console](/docs/content/console): the editor, the media library, and history.
- [Preview drafts](/docs/content/preview) on your own pages before you publish.
- [Edit together](/docs/content/editing-together): presence, edit leases, and live editing.
- [Publish on a schedule](/docs/content/scheduling), on the Blob + Database store.
- [Edit from the terminal](/docs/content/cli) with `vitehub content`, and let an Agent draft and publish with the [Content Agent Capability](/docs/content/agent-capability).
- [Read published documents](/docs/content/server-api) from your routes, and from the browser through `/api/content/**`.

## Deploy and operate

[Hosts](/docs/cms/hosts) lists where each store runs and what to provision before a hosted deploy. [Limits and errors](/docs/cms/limits-and-errors) lists the limits of the GitHub store and the fix for each error code. The [Server API](/docs/cms/server-api) lists the imports and every preset option.
