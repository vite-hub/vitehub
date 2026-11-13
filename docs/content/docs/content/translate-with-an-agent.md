---
title: Translate Content with an Agent
description: Keep English pages in your repository, push them to the Workspace, let an Agent write each translation, and pull the translations back.
navigation.title: Translate with an Agent
navigation.order: 14
icon: i-lucide-languages
---

You write the English pages in your repository. `vitehub push` sends them to the `draft` ref of the Content Workspace. An Agent translates each changed page, and `vitehub pull` brings the translations back to your folder. Each translation records the English version it came from, so `vitehub status` shows when it is stale.

The wiring has three parts:

1. A `write:after` hook on the Workspace sees that an English page changed on `draft`.
2. The hook enqueues a Queue job with the id of the page.
3. The job reads the source digest of the English page on `draft` and runs a translator Agent with the [`content()` Capability](/docs/content/agent-capability#translations). The Agent saves the page with `locale: 'es'` and that `sourceDigest`, and Content writes `derivedFrom`.

The [content playground](https://github.com/vite-hub/vitehub/tree/main/playground/content) runs this setup.

## Before you start

The collection needs [locales](/docs/content/configure#locales). This page uses the `docs` collection with English as the source locale:

```ts [server/content.ts]
import { defineContent } from 'vite-hub/content'
import { documents } from 'vite-hub/content/collections'
import { cmsContentAuthorize } from 'vite-hub/cms/access'
import { z } from 'zod'

export const content = defineContent({
  workspace: 'site',
  collections: {
    docs: documents({
      path: 'docs/{locale}/**/*.md',
      locales: ['en', 'es'],
      url: '/docs/:id',
      fields: { title: z.string().min(1), description: z.string().optional() },
    }),
  },
  authorize: cmsContentAuthorize,
})
```

Turn on Agents and Queue in the app config. Keep the other options of your app, and set `AI_GATEWAY_API_KEY` in the server environment for the model. See [Agent Drivers](/docs/agents/agent-drivers#use-a-model-backed-driver).

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { agent: true, queue: true, workspace: true },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ agent: true, queue: true, workspace: true }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ agent: true, queue: true, workspace: true })],
})
```
:::
::

## Define the translator

The Agent reads the Spanish page for its digest, reads the English page, and saves the translation with the source digest that the job gives it. It stops when the English page changed after the job started, because the change started a newer job. `runtime: false` runs it inside the Queue job. The `user` option gives the Agent the CMS role that your `authorize` policy checks: here an editor, which saves drafts and cannot publish.

```ts [server/agents/translator.ts]
import { defineAgent } from 'vite-hub/agent'
import { content } from 'vite-hub/agent/capabilities'

export default defineAgent({
  runtime: false,
  driver: {
    model: 'anthropic/claude-haiku-5.5',
    instructions: [
      'Translate pages of the `docs` collection from English (en) into Spanish (es). The task gives a page id and the source digest of the English version.',
      '1. Read the Spanish page with content_get_document, locale "es", and ref "draft". Use ifDigest null when it has fallback: true, otherwise its digest. Stop when its derivedFrom.digest is the source digest of the task.',
      '2. Read the English page with ref "draft". Stop when its source.digest is not the source digest of the task: a newer job translates it.',
      '3. Save with content_save_draft, locale "es", and sourceDigest set to the source digest of the task. Keep the data keys and the Markdown structure.',
      'On WORKSPACE_CONFLICT, start again at step 1. Do not save more than twice.',
    ].join('\n'),
  },
  capabilities: [content({
    collections: ['docs'],
    operations: ['read', 'write'],
    user: () => ({ id: 'translator', name: 'Translator', role: 'editor' }),
  })],
})
```

## Run it from a Queue job

A standalone `runAgent()` inside the server gets the `content` primitive, as the generated Agent routes do. The job reads the English page when it starts, and gives the Agent its `source.digest`: the version that this job translates. The job throws when the Agent fails, so the Queue tries it again.

```ts [server/queues/translate.ts]
import { runAgent } from 'vite-hub/agent'
import { defineQueue } from 'vite-hub/queue'
import translator from '../agents/translator'
import { content } from '../content'

export default defineQueue<{ id: string }>(async ({ payload }) => {
  const english = await content.collection('docs').get(payload.id, { ref: 'draft' })
  if (!english?.source) return
  const prompt = `Translate the docs page with id "${payload.id}" into Spanish. The source digest of the English version to translate is ${english.source.digest}.`
  const [error] = await runAgent(translator, { prompt })
  if (error) throw error
})
```

## Start the job when an English page changes

`write:after` runs once for each changed file after a commit, on every ref. Content saves, Console edits, and `vitehub push` all commit to `draft`. Add the hook to the Workspace that `defineContent({ workspace })` names:

```ts [server/workspaces/site.ts] fragment
import { sendQueue } from 'vite-hub/queue'
import { defineWorkspace } from 'vite-hub/workspace'

export default defineWorkspace({
  store,
  hooks: {
    'write:after': async ({ operation, path, ref }) => {
      const id = ref === 'draft' && operation === 'writeFile' ? /^docs\/en\/(.+)\.md$/.exec(path)?.[1] : undefined
      if (!id) return
      const [error] = await sendQueue('translate', { id })
      if (error) console.error(`Could not enqueue the translation of ${path}:`, error)
    },
  },
})
```

The hook matches only `docs/en/`. The Agent saves to `docs/es/`, so a translation does not start another one. `publish()` commits to `published`, which the hook skips. The commit is already saved when the hook runs, so the hook logs a failed enqueue instead of throwing. When the Workspace comes from a package, use [`registerWorkspacePlugin()`](/docs/workspace/server-api#add-plugins-to-a-workspace) with the same hook.

## Push English, pull Spanish

Start the dev server with the key in its environment. Check out the `draft` ref of the Content Workspace into a folder of your project:

```bash [Terminal]
AI_GATEWAY_API_KEY=... pnpm dev
pnpm vitehub pull site --dir content --ref draft
```

Edit an English page and push it. The push commits to `draft`, the hook enqueues the job, and the Agent saves the Spanish page a few seconds later. `vitehub pull --dry-run` shows it before you pull:

```bash [Terminal]
pnpm vitehub push --message "Add the install guide"
pnpm vitehub pull --dry-run
pnpm vitehub pull
```

```text [Output]
site: pushed 1 file to draft (8649b63c…)
  docs/en/guide.md
Remote changes since 8649b63c… (run `vitehub pull`):
  added     docs/es/guide.md
site: pulled draft 8649b63c… -> d7e036ce…
  added    docs/es/guide.md
```

The pulled Spanish page names the English version that it translates:

```md [content/docs/es/guide.md]
---
title: Instalar la aplicación
description: Instala la aplicación y ponla en marcha en tu equipo.
derivedFrom:
  path: docs/en/guide.md
  digest: sha256-91a5d764…
---

## Requisitos
```

Edit the English page again. Until a new translation exists, `vitehub status` lists the Spanish page as stale. It compares the files of your folder and does not call the app:

```text [Output]
site: content/ is draft at d7e036ce… on http://localhost:5173
Local changes:
  modified  docs/en/guide.md
Stale derived files (their source changed):
  changed   docs/es/guide.md <- docs/en/guide.md
```

After the push, `vitehub workspace stale site --ref draft` lists the page on the app until the Agent saves it. Pull again when the job is done. `vitehub workspace history site --ref draft` shows each push and each save of the Agent, with its author.

Commit the English pages, the translations, and `vitehub.lock` to your repository. The translations stay drafts until someone publishes them in the Console or with `content.publish()`.

## Limits

- The Queue delivers a job at least once. A retried job runs the model again. Make the Agent safe to repeat: it reads the current Spanish digest before each save, and it stops when the Spanish page already records the source digest of the job.
- A save records the English version that the job gave the Agent, not the one on the draft when it saves. If someone changes the English page while the Agent works, that change enqueues a second job. The first job stops when it sees the change, or its save shows as stale until the second job saves the new translation. When the two saves race, the second gets `WORKSPACE_CONFLICT`, reads both pages again, and stops if the English page moved.
- In `vite dev` and with `host: 'node'`, the job runs in the server process, so that process needs `AI_GATEWAY_API_KEY`. See [Queue hosts](/docs/queue/hosts) for the other providers.
- The Agent output is a draft. Review translations before you publish them.

## Related pages

- [Content Agent Capability](/docs/content/agent-capability#translations)
- [Content locales](/docs/content/configure#locales)
- [Work on a ref in a local folder](/docs/workspace/server-api#work-on-a-ref-in-a-local-folder)
- [Derived files](/docs/workspace/server-api#derived-files)
- [Queue server API](/docs/queue/server-api)
