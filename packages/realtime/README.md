# @vite-hub/realtime

<p>
  <a href="https://vitehub.dev"><img alt="ViteHub" src="https://img.shields.io/badge/ViteHub-vitehub.dev-646cff?style=flat-square"></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ready-3178c6?style=flat-square">
  <img alt="Yjs" src="https://img.shields.io/badge/Yjs-collaboration-f7df1e?style=flat-square">
  <img alt="Vite" src="https://img.shields.io/badge/Vite-discovery-646cff?style=flat-square">
</p>

`@vite-hub/realtime` synchronizes TipTap editors through Yjs while a ViteHub Workspace owns the canonical Markdown files. Use the package directly when you compose ViteHub's modular Vite integrations. Use [`vite-hub`](https://www.npmjs.com/package/vite-hub) when you want the combined distribution.

Realtime is for collaborative documents, presence, and explicit Workspace checkpoints. It is not a general-purpose WebSocket or event-broadcasting API.

## Install

```sh
pnpm add @vite-hub/realtime @vite-hub/workspace @tiptap/vue-3 h3 nitro vite vue
```

ViteHub Realtime requires Node 24.15 or newer. The published client adapter is for Vue. The package declares `vite` and `vue` as optional peers so server-only integrations do not install unused framework tooling; this walkthrough uses both.

## Connect one document

Register Workspace before Realtime. This local setup keeps both the room and its Workspace in memory.

```ts
// vite.config.ts
import { hubRealtime } from "@vite-hub/realtime/vite"
import { hubWorkspace } from "@vite-hub/workspace/vite"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [
    hubWorkspace(),
    hubRealtime({ authority: "memory" }),
  ],
})
```

Declare a writable Workspace and a Realtime Definition with the same Workspace name. The relative file name `server/realtime/docs.ts` becomes the Realtime Definition name `docs`.

```ts
// server/workspaces/docs.ts
import { defineWorkspace } from "@vite-hub/workspace"

export default defineWorkspace({
  store: { provider: "memory" },
  rules: {
    "/**": { write: true, mediaType: "text/markdown" },
  },
})
```

```ts
// server/realtime/docs.ts
import { defineRealtime } from "@vite-hub/realtime"

export default defineRealtime({
  document: { workspace: "docs" },
  history: { checkpoint: true },
})
```

Connect a browser to the `docs` definition and a safe Workspace path. `useRealtimeTiptap()` exposes Vue refs for the room state and TipTap extensions bound to its Yjs document.

```vue
<!-- app/components/DocumentEditor.vue -->
<script setup lang="ts">
import { EditorContent, useEditor } from "@tiptap/vue-3"
import { useRealtimeTiptap } from "@vite-hub/realtime/vue"
import { computed } from "vue"

const realtime = useRealtimeTiptap("docs", "guides/welcome.md")
const editor = useEditor({
  extensions: realtime.extensions.value,
})
const connection = computed(() =>
  realtime.synced.value ? "Document synced" : `Realtime: ${realtime.status.value}`,
)
</script>

<template>
  <p aria-live="polite">{{ connection }}</p>
  <EditorContent :editor="editor" />
</template>
```

Open the page in two tabs. Each tab first reports `Realtime: connecting`, then `Document synced`. Edits sync between them, and `realtime.people.value` reports the connected people.

Room updates do not write the Workspace document. Save the current Markdown and create a Workspace snapshot explicitly:

```ts
const checkpoint = await realtime.history.checkpoint()

console.log(checkpoint.content)
console.log(checkpoint.snapshot.id)
```

## Deployment and security boundaries

- The Vue adapter connects to the generated same-origin `/api/_vitehub/realtime/**` WebSocket route. The Vite integration registers that route and discovers `server/realtime` definitions.
- `authority: "memory"` is single-process and loses room state when the process stops. ViteHub rejects it for known distributed host presets. It retains at most 128 active rooms.
- `authority: "cloudflare"` uses a SQLite-backed Cloudflare Durable Object. `authority: "auto"` selects it only when a Cloudflare Nitro preset or hosting environment can be resolved. Other production builds require an explicit authority.
- Durable rooms do not make Workspace files durable. Production checkpoints need a durable Workspace Store with conditional writes; memory Workspace Stores are rejected for durable checkpoints.
- Realtime Definitions are public by default. Set `auth: true` only after configuring ViteHub Auth; this verifies the session and replaces client-supplied presence identity. Presence in a public definition is untrusted and must not authorize application actions.
- One WebSocket message is limited to 1 MiB. Document state and awareness state are each limited to 8 MiB per room, and one peer can own at most 1,024 awareness clients.
- Changing or disabling the document, or disposing its Vue scope, destroys the document provider. The application still owns editor disposal, checkpoint error handling, and reconnect UX.

## Public imports

| Import | Purpose |
| --- | --- |
| `@vite-hub/realtime` | `defineRealtime()` and portable Realtime types. |
| `@vite-hub/realtime/vite` | `hubRealtime()` definition discovery and generated server wiring. |
| `@vite-hub/realtime/vue` | `useRealtimeTiptap()` for Vue, TipTap, presence, status, and checkpoints. |
| `@vite-hub/realtime/server` | `createRealtimeHandler()` for a manual H3 server integration. Normal ViteHub apps use the generated route. |

Generated files under `.vitehub/nitro/realtime` are inspectable build output, not application imports.

## Learn more

- [Realtime collaboration](https://vitehub.dev/docs/reference/realtime) covers authorities, checkpoints, workspace events, quotas, and generated output.
- [Workspace](https://vitehub.dev/docs/server-primitives/workspace) covers stores, write rules, snapshots, and persistence.
- [Auth](https://vitehub.dev/docs/server-primitives/auth) covers session setup and trusted origins.
- [Configuration options](https://vitehub.dev/docs/reference/config-options) lists every Realtime module option.
