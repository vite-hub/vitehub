---
title: Quickstart
description: Define and use a local ViteHub workspace.
navigation.title: Quickstart
navigation.order: 1
frameworks: [vite, nitro]
---

Install and register the integration:

::fw{id="vite:dev vite:build"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { hubWorkspace } from '@vitehub/workspace/vite'

export default defineConfig({
  plugins: [hubWorkspace()],
  workspace: {},
})
```
::

::fw{id="nitro:dev nitro:build"}
```ts [nitro.config.ts]
import { defineNitroConfig } from 'nitro/config'

export default defineNitroConfig({
  modules: ['@vitehub/workspace/nitro'],
  workspace: {},
})
```
::

Create `workspaces/docs.ts`:

```ts
import { defineWorkspace, loader, source } from '@vitehub/workspace'

export default defineWorkspace({
  name: 'docs',
  store: {
    provider: 'local',
    root: '.vitehub/workspaces/docs',
  },
  sources: [
    source.markdown({
      path: 'README.md',
      workspacePath: 'README.md',
    }),
  ],
  loaders: [loader.files()],
})
```

Use it from a server route:

```ts
import { useWorkspace } from '@vitehub/workspace'

const workspace = await useWorkspace('docs')
await workspace.sync()

await workspace.writeFile('generated/notes.md', 'Generated notes')

return {
  files: await workspace.list('', { recursive: true }),
  diff: await workspace.diff(),
}
```
