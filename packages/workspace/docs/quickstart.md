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
})
```
::

Create `src/docs.workspace.ts` for Vite or `server/workspaces/docs.ts` for Nitro:

```ts
import { defineWorkspace, source } from '@vitehub/workspace'

export default defineWorkspace({
  store: {
    provider: 'local',
    root: '.vitehub/workspaces/docs',
  },
  sources: {
    docs: source.file('README.md'),
  },
})
```

Use it from a server route:

```ts
import { useWorkspace } from '@vitehub/workspace'

const workspace = useWorkspace('docs', { allowWrite: true })

await workspace.fs.writeFile('generated/notes.md', 'Generated notes')

return {
  files: await workspace.fs.list('', { recursive: true }),
}
```
