---
title: Get started with ViteHub UI
description: "Install the ui-sdk parts and the ViteHub modules in Nuxt or Vue, load the kit styles, render one part, and let an Agent work the page."
layout: tutorial
navigation.title: Get started
navigation.order: 2
navigation.group: Start
icon: i-lucide-rocket
---

In this guide, you render a project name field with ui-sdk parts and the kit styles. Then an Agent renames the project on the open page.

You need Node.js 22.22 or newer and pnpm. For Nuxt, you need Nuxt 5, which is only in nightly builds for now: `pnpm add nuxt@npm:nuxt-nightly@5x`. To try the parts without an install, open the [Playground](/playground?template=ui).

::tutorial-step{title="Install"}
## Install

:::tabs{sync="vue-app"}
::::tabs-item{label="Nuxt"}
```bash [commands/install-nuxt]
pnpm add @ui-sdk/vue @ui-sdk/core @vite-hub/kit vite-hub
```

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ["@ui-sdk/vue/nuxt", "@vite-hub/kit/nuxt", "vite-hub/nuxt"],
  css: ["~/assets/css/main.css"],
})
```

The modules import the parts for you, such as `<Dialog>` and `<TagsInput>`.
::::

::::tabs-item{label="Vue"}
```bash [commands/install-vue]
pnpm add @ui-sdk/vue @ui-sdk/core @vite-hub/kit vite-hub vue
pnpm add -D vite @vitejs/plugin-vue
```

```ts [vite.config.ts]
import vue from "@vitejs/plugin-vue"
import { defineConfig } from "vite"
import { vitehub } from "vite-hub"

export default defineConfig({
  plugins: [vue(), vitehub()],
})
```

```ts [src/main.ts]
import { createApp } from "vue"
import App from "./App.vue"
import "./style.css"

createApp(App).mount("#app")
```
::::
:::

::

::tutorial-step{title="Add the styles"}
## Add the styles

The parts have no styles until you load a style family. Load the tokens, then the `default` family. Put the lines above `@import "tailwindcss"` if your app uses Tailwind CSS.

:::tabs{sync="vue-app"}
::::tabs-item{label="Nuxt"}
```css [app/assets/css/main.css]
@layer ui-sdk;
@import "@vite-hub/kit/styles/tokens.css";
@import "@vite-hub/kit/styles/default.css";
```
::::

::::tabs-item{label="Vue"}
```css [src/style.css]
@layer ui-sdk;
@import "@vite-hub/kit/styles/tokens.css";
@import "@vite-hub/kit/styles/default.css";
```
::::
:::

Do not load a style family in an app that uses Nuxt UI yet. See [From Nuxt UI](/docs/ui/from-nuxt-ui).

::

::tutorial-step{title="Render one part"}
## Render one part

:::tabs{sync="vue-app"}
::::tabs-item{label="Nuxt"}
```vue [app/app.vue]
<script setup lang="ts">
const name = ref("Apollo")
</script>

<template>
  <Field>
    <FieldLabel>Project name</FieldLabel>
    <Input v-model="name" />
  </Field>
</template>
```
::::

::::tabs-item{label="Vue"}
```vue [src/App.vue]
<script setup lang="ts">
import { Field, FieldLabel } from "@ui-sdk/vue/field"
import { Input } from "@ui-sdk/vue/input"
import { ref } from "vue"

const name = ref("Apollo")
</script>

<template>
  <Field>
    <FieldLabel>Project name</FieldLabel>
    <Input v-model="name" />
  </Field>
</template>
```
::::
:::

Start the dev server with `pnpm dev` and open the page. Select **Project name**: the label focuses the input.

::

::tutorial-step{title="Let an Agent work the page"}
## Let an Agent work the page

Turn on Agents and Realtime in `nuxt.config.ts` or `vite.config.ts`. This Node build keeps its rooms in memory, in one process:

:::tabs{sync="vue-app"}
::::tabs-item{label="Nuxt"}
```diff
 export default defineNuxtConfig({
   modules: ["@ui-sdk/vue/nuxt", "@vite-hub/kit/nuxt", "vite-hub/nuxt"],
   css: ["~/assets/css/main.css"],
+  vitehub: { host: "node", agent: true, realtime: { authority: "memory" } },
 })
```
::::

::::tabs-item{label="Vue"}
```diff
 export default defineConfig({
-  plugins: [vue(), vitehub()],
+  plugins: [vue(), vitehub({ host: "node", agent: true, realtime: { authority: "memory" } })],
 })
```
::::
:::

Give an Agent the page Capability. A model string goes through Vercel AI Gateway, so install `ai` and set `AI_GATEWAY_API_KEY` in the server environment. Each request can cost money.

```ts [server/agents/settings.ts]
import { defineAgent } from "vite-hub/agent"
import { page } from "vite-hub/agent/capabilities"
import { webChat } from "vite-hub/agent/channels"

export default defineAgent({
  capabilities: [page()],
  channels: { web: webChat() },
  driver: { model: "openai/gpt-5" },
})
```

Connect the page and send a message. Add the component next to the field: in `app/components/` for Nuxt, or `src/components/` for Vue.

```vue [AskAgent.vue]
<script setup lang="ts">
import { createAgent } from "@ui-sdk/vue/agent"
import { Button } from "@ui-sdk/vue/button"
import { connectPage } from "vite-hub/agent/page"
import { useAgent, useChat } from "vite-hub/agent/vue"
import { connectRealtimeRoom } from "vite-hub/realtime/client"

const page = connectPage(createAgent, { join: connectRealtimeRoom })
const { sendMessage } = useChat(useAgent("settings"), { page })
const ask = () => sendMessage({ text: "Rename the project to Atlas." })
</script>

<template>
  <Button @click="ask">Ask the Agent</Button>
</template>
```

Select **Ask the Agent**. The Agent reads the page, finds **Project name**, and sets it to Atlas. The change reaches the field with `source: "agent"`. Read [Page](/docs/agents/capabilities/page) to deny parts, ask for approval, and undo a change.

::

## Next

- [Where does it belong?](/docs/ui/where-does-it-belong): find the owner of a bug or a feature.
- [From Reka UI](/docs/ui/from-reka-ui): the ui-sdk part for each Reka UI part.
- The ui-sdk docs for your installed version are in `node_modules/@ui-sdk/vue/docs`.
