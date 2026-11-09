---
title: i18n configuration
description: Choose the locales, add i18n to a Vue app or a Nuxt 5 app, write messages with placeholders and plurals, and keep the translations up to date.
navigation.title: Configure
navigation.order: 3
icon: i-lucide-sliders-horizontal
---

ViteHub uses [Lingui](https://lingui.dev) to extract and compile the messages. Your app has no Lingui config and imports nothing from Lingui. You set the locales in the ViteHub options, and ViteHub does the rest.

## Choose the locales

Set `i18n.locales` in the ViteHub options. The first locale is the source locale: the language that you write in the code.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ["vite-hub/nuxt"],
  vitehub: { preset: "node", i18n: { locales: ["en", "es", "pt-BR"] } },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import vue from "@vitejs/plugin-vue"
import { nitro } from "nitro/vite"
import { defineConfig } from "vite"
import { vitehub } from "vite-hub"

export default defineConfig({
  plugins: [
    vue(),
    vitehub({ preset: "node", i18n: { locales: ["en", "es", "pt-BR"] } }),
    nitro(),
  ],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import vue from "@vitejs/plugin-vue"
import { defineConfig } from "vite"
import { vitehub } from "vite-hub"

export default defineConfig({
  plugins: [
    vue(),
    vitehub({ preset: "node", i18n: { locales: ["en", "es", "pt-BR"] } }),
  ],
})
```
:::
::

| Option | Default | Meaning |
| --- | --- | --- |
| `locales` | Required | BCP 47 language tags, such as `"en"`, `"es"`, or `"pt-BR"`. The first one is the source locale. Each tag can appear only once. |
| `cookie` | `"locale"` | The cookie that stores the locale that a person picks with `setLocale()`. |

Install `@vite-hub/i18n` in the app. `vite-hub` declares it as an optional package, and the build stops with an install command when it is missing.

```bash [Terminal]
pnpm add @vite-hub/i18n
```

i18n needs Nitro 3. Use Vite with Nitro 3, or Nuxt 5. Nuxt 4 builds the server with Nitro 2, and the build stops with [`I18N_UNSUPPORTED_HOST`](/docs/i18n/limits-and-errors#i18n_unsupported_host).

## Add i18n to a Vue app

In a Vite app, install the Vue plugin before you mount the app. `createI18n()` picks the locale, loads its catalog, and returns the plugin:

```ts [src/main.ts]
import { createApp } from "vue"
import { createI18n } from "vite-hub/i18n/vue"
import App from "./App.vue"

createApp(App).use(await createI18n()).mount("#app")
```

The browser starts with the `locale` cookie, then the browser languages, then the source locale. After that, `t` and `<Trans>` work in every template with no import.

Read and change the locale with `useLocale()`:

```vue [src/components/LocalePicker.vue]
<script setup lang="ts">
import { useLocale } from "vite-hub/i18n/vue"

const { locale, locales, setLocale } = useLocale()
</script>

<template>
  <select :value="locale" @change="setLocale(($event.target as HTMLSelectElement).value)">
    <option v-for="entry in locales" :key="entry" :value="entry">{{ entry }}</option>
  </select>
</template>
```

`setLocale()` loads the catalog of the new locale, re-renders the messages, sets `<html lang>`, and saves the choice in the cookie. The next server request reads the same cookie.

## Use i18n in Nuxt 5

Select the Nuxt tab in [Choose the locales](#choose-the-locales) and add `i18n` to the options of the `vite-hub/nuxt` module.

The module installs the Vue plugin for you, so you do not call `createI18n()`. The server renders each page in the locale of the request. The page then loads in the browser in the same locale, so the HTML does not change after load. The module also sets `<html lang>` and auto-imports `useLocale()`.

```vue [app/pages/index.vue]
<script setup lang="ts">
const { locale, setLocale } = useLocale()
</script>

<template>
  <h1>{{ t`Deploy your agent` }}</h1>
  <button @click="setLocale(locale === 'en' ? 'es' : 'en')">{{ locale }}</button>
</template>
```

Server routes import `t` from `vite-hub/i18n`, as in a Vite app.

## Write messages

Write each message in the source language. Do not make up a key. The build makes the key from the text.

In Vue templates, use ``t`...` `` for text and attributes, and `<Trans>` for a message with markup:

```vue [src/components/Search.vue]
<script setup lang="ts">
const props = defineProps<{ name: string }>()
</script>

<template>
  <input :placeholder="t`Search agents`">
  <p><Trans>Hello <b>{{ props.name }}</b>, read the <a href="/docs">docs</a>.</Trans></p>
</template>
```

The translator sees `Hello <0>{0}</0>, read the <1>docs</1>.`. The numbered tags stand for your markup, so a translation cannot change a link or a class.

In scripts and server code, import the functions from `vite-hub/i18n`:

```ts [src/status.ts]
import { plural, select, selectOrdinal, t } from "vite-hub/i18n"

export function deployStatus(name: string, count: number, role: string, place: number) {
  return [
    t`Hello ${name}`,
    plural(count, { one: "# agent", other: "# agents" }),
    select(role, { admin: "Admin", other: "Member" }),
    selectOrdinal(place, { one: "#st", two: "#nd", few: "#rd", other: "#th" }),
  ]
}
```

| Function | Use it for |
| --- | --- |
| ``t`Text ${value}` `` | A message. A `${value}` becomes a placeholder. |
| `t({ message, comment, context })` | A message with a note for translators, or with a context that keeps two equal texts apart, such as "Open" on a button and "Open" as a status. |
| `plural(count, forms)` | A form for each plural category. `other` is required. `#` is the number. |
| `selectOrdinal(place, forms)` | Ordinal forms, such as 1st, 2nd, and 3rd. |
| `select(value, forms)` | A form for each value. `other` is required. |
| ``msg`Text` `` | A message that you translate later. See [Messages outside a request](#messages-outside-a-request). |

In `<script setup>`, a `t` call runs once, when the component starts. To follow `setLocale()`, wrap it in `computed`. Templates follow the locale on their own.

```vue [src/components/Title.vue]
<script setup lang="ts">
import { computed } from "vue"
import { t } from "vite-hub/i18n"

const title = computed(() => t`Deploy your agent`)
</script>
```

Give a placeholder a name for translators with an object: ``t`Hello ${{ name: user.name }}` `` shows `Hello {name}` in the catalog.

### Messages outside a request

A `t` call translates when the code runs. At the top level of a module, no request and no page locale exist yet. Declare the message with `msg` there, and call `translate()` when the code runs:

```ts [server/utils/statuses.ts]
import { msg, translate } from "vite-hub/i18n"

const labels = { draft: msg`Draft`, live: msg`Live` }

export function statusLabel(status: keyof typeof labels) {
  return translate(labels[status])
}
```

## Translate the messages

The messages live in one PO catalog for each locale, in `locales/<locale>.po` at the project root. Translators edit these files with a text editor or a PO editor such as Poedit.

Run `extract` after you add or change messages:

```bash [Terminal]
pnpm vitehub i18n extract
```

`extract` adds new messages and keeps the translations that exist. It removes messages that the code no longer uses. Add `--keep-obsolete` to keep them in the file.

`status` shows the coverage of each locale. It does not change a file:

```bash [Terminal]
pnpm vitehub i18n status --json
```

```json
[
  { "locale": "en", "source": true, "catalog": "locales/en.po", "messages": 4, "translated": 4, "missing": 0 },
  { "locale": "es", "source": false, "catalog": "locales/es.po", "messages": 4, "translated": 3, "missing": 1 }
]
```

Both commands accept `--json`. The `missing` count tells a CI job or an Agent which locales need work. `status` exits with `0` also when messages are missing.

To add a locale, add it to `i18n.locales` and run `extract`. The new catalog starts with every message untranslated.

## What the build does

- **Messages become IDs.** The build replaces each message with a short ID, a hash of the source text and its context. In a production build, the app code has IDs and no source text.
- **One chunk for each locale.** Each catalog is a separate chunk. The browser loads only the catalog of the active locale.
- **The server has every locale.** The server loads the compiled catalogs of all locales when it starts, so a request never waits for a catalog.
- **A missing translation shows the source text.** A message that has no translation in a locale shows the text of the source locale, never an ID.

The build reads the catalogs when it starts. Run `extract` before a production build. A message that is not in the catalogs has no text in a production build, so it shows its ID. See [Limits](/docs/i18n/limits-and-errors#limits).

## Inspect i18n

The CLI shows the locales and their coverage without a server:

```bash [Terminal]
pnpm vitehub inspect definitions --kind i18n
pnpm vitehub inspect provider-output
```

`inspect definitions` lists each locale with its catalog and its counts of messages, translations, and missing translations. `inspect provider-output` lists `.vitehub/i18n/messages.mjs`, the compiled messages that the server loads.
