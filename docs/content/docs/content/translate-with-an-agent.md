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
3. The job runs a translator Agent with the [`content()` Capability](/docs/content/agent-capability#translations). The Agent saves the page with `locale: 'es'`, and Content writes `derivedFrom`.

The [content playground](https://github.com/vite-hub/vitehub/tree/main/playground/content) runs this setup.

## Before you start

The collection needs [locales](/docs/content/configure#locales). This page uses the `docs` collection with English as the source locale:

```ts [server/content.ts]
docs: documents({
  path: 'docs/{locale}/**/*.md',
  locales: ['en', 'es'],
  url: '/docs/:id',
  fields: { title: z.string().min(1), description: z.string().optional() },
}),
```

Turn on Agents and Queue in the existing `vitehub()` options, and set `AI_GATEWAY_API_KEY` in the server environment for the model. See [Agent Drivers](/docs/agents/agent-drivers#use-a-model-backed-driver).

```diff [vite.config.ts]
 vitehub({
+  agent: true,
+  queue: true,
   workspace: true,
 })
```

## Define the translator

The Agent reads the English page, reads the Spanish page for its digest, and saves the translation. `runtime: false` runs it inside the Queue job. The `user` option gives the Agent the CMS role that your `authorize` policy checks: here an editor, which saves drafts and cannot publish.

```ts [server/agents/translator.ts]
import { defineAgent } from 'vite-hub/agent'
import { content } from 'vite-hub/agent/capabilities'

export default defineAgent({
  runtime: false,
  driver: {
    model: 'anthropic/claude-haiku-5.5',
    instructions: [
      'Translate pages of the `docs` collection from English (en) into Spanish (es).',
      '1. Read the English page with content_get_document and ref "draft".',
      '2. Read the Spanish page with locale "es" and ref "draft". Use ifDigest null when it has fallback: true, otherwise its digest.',
      '3. Save with content_save_draft and locale "es". Keep the data keys and the Markdown structure.',
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

A standalone `runAgent()` inside the server gets the `content` primitive, as the generated Agent routes do. The job throws when the Agent fails, so the Queue tries it again.

```ts [server/queues/translate.ts]
import { runAgent } from 'vite-hub/agent'
import { defineQueue } from 'vite-hub/queue'
import translator from '../agents/translator'

export default defineQueue<{ id: string }>(async ({ payload }) => {
  const [error] = await runAgent(translator, { prompt: `Translate the docs page with id "${payload.id}" into Spanish.` }, { output: 'drained' })
  if (error) throw error
})
```

## Start the job when an English page changes

`write:after` runs once for each changed file after a commit, on every ref. Content saves, Console edits, and `vitehub push` all commit to `draft`. Add the hook to the Workspace that `defineContent({ workspace })` names:

```ts [server/workspaces/site.ts]
import { runQueue } from 'vite-hub/queue'
import { defineWorkspace } from 'vite-hub/workspace'

export default defineWorkspace({
  store,
  hooks: {
    'write:after': async ({ operation, path, ref }) => {
      const id = ref === 'draft' && operation === 'writeFile' ? /^docs\/en\/(.+)\.md$/.exec(path)?.[1] : undefined
      if (!id) return
      const [error] = await runQueue('translate', { id })
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

- The Queue delivers a job at least once. A retried job runs the model again. Make the Agent safe to repeat: it reads the current Spanish digest before each save.
- A save records the English version on the draft when the Agent saves. If someone changes the English page while the Agent works, that change enqueues a second job, which translates the new version.
- In `vite dev` and with `preset: 'node'`, the job runs in the server process, so that process needs `AI_GATEWAY_API_KEY`. See [Queue hosts](/docs/queue/hosts) for the other providers.
- The Agent output is a draft. Review translations before you publish them.

## Related pages

- [Content Agent Capability](/docs/content/agent-capability#translations)
- [Content locales](/docs/content/configure#locales)
- [Work on a ref in a local folder](/docs/workspace/server-api#work-on-a-ref-in-a-local-folder)
- [Derived files](/docs/workspace/server-api#derived-files)
- [Queue server API](/docs/queue/server-api)
