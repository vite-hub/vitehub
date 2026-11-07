---
title: i18n configuration
description: Choose the locales, add i18n to a Vue app or a Nuxt 5 app, write messages with placeholders and plurals, and keep the translations up to date.
navigation.title: Configure
navigation.order: 3
icon: i-lucide-sliders-horizontal
---

ViteHub uses [Lingui](https://lingui.dev) to read and compile the messages. Your app has no Lingui config and imports nothing from Lingui. You set the locales in the ViteHub options, and ViteHub does the rest.

## Choose the locales

Set `i18n.locales` in `vitehub()`. The first locale is the source locale: the language that you write in the code.

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

Add `i18n` to the options of the `vite-hub/nuxt` module:

```ts [nuxt.config.ts]
import viteHubNuxt from "vite-hub/nuxt"

export default defineNuxtConfig({
  modules: [
    [viteHubNuxt, { preset: "node", i18n: { locales: ["en", "es"] } }],
  ],
})
```

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

The source text is the key. Each translation is one [Diglot](https://github.com/danielroe/diglot) record in `locales/<locale>/segments/` at the project root, so two people who translate different messages never edit the same file:

```json [locales/es/segments/52/5220fa743183ff60.json]
{
  "hash": "5220fa743183ff60",
  "source": "Deploy your agent",
  "text": "Despliega tu agente",
  "origin": "human",
  "review": "edited",
  "derived": "fresh",
  "by": "ana",
  "updatedAt": "2026-11-07T12:00:00.000Z"
}
```

The `locales/` folder is a Diglot translations folder, so `diglot validate` from [`@diglot/cli`](https://www.npmjs.com/package/@diglot/cli) checks it with no ViteHub code. The file name is Diglot's hash of the message. A message with a `context` keeps it in `salt`, and the context is part of the hash. Edit `text`, not `source`. A record whose `source` does not match its hash is skipped, and `status` lists it.

- `origin` is `mt` for a machine translation, `tm` for a translation memory match, or `human`.
- `review` is `none`, `edited`, `verified`, or `rejected`. A `rejected` translation shows the source text.
- A translation must keep each positional value of its message, such as `{0}`. A translation that loses one shows the source text, and `import` refuses it.
- ViteHub saves a translation with Diglot's `editRecord()` and verifies it with `verifyRecord()`, with the text that the person saw as `expected`. When the record has another text now, the change is refused as `stale`.

`status` reads the messages in the code and compares them with the records. It changes no file:

```bash [Terminal]
pnpm vitehub i18n status --json
```

```json
[
  { "locale": "en", "source": true, "folder": "", "messages": 4, "translated": 4, "missing": 0, "unused": 0, "problems": [] },
  { "locale": "es", "source": false, "folder": "locales/es", "messages": 4, "translated": 3, "missing": 1, "unused": 0, "problems": [] }
]
```

The `missing` count tells a CI job or an Agent which locales need work. `status` exits with `0` also when messages are missing.

Translators who use Poedit or a translation service work with PO files. `export` writes every message of a locale with its translation, and `import` saves the translations of a PO file as `human` edits. `--by` sets the login in the record, and defaults to the user name of your machine. A translation that loses a placeholder is refused, and `import` then exits with `1`:

```bash [Terminal]
pnpm vitehub i18n export es --output es.po
pnpm vitehub i18n import es es.po --by ana
```

When you change the source text of a message, it gets a new ID and a new hash, and its old record becomes unused. `prune` lists the unused records, and deletes them with `--yes`:

```bash [Terminal]
pnpm vitehub i18n prune
pnpm vitehub i18n prune --yes
```

To add a locale, add it to `i18n.locales`. It starts with every message untranslated.

## What the build does

- **Messages become IDs in the browser.** The build replaces each message with a short ID, a hash of the source text and its context. In a production build, the browser code has IDs and no source text.
- **The build collects the messages.** A production build reads every message that it compiles. You do not run a command before the build, and no message shows its ID.
- **One chunk for each locale.** Each catalog is a separate chunk with the messages of the browser code only. The browser loads only the catalog of the active locale. Translations of server-only messages stay on the server.
- **The server has every locale.** Server code keeps the source text. The server loads the translations of all locales when it starts, so a request never waits for a catalog.
- **A missing translation shows the source text.** A message that has no translation in a locale shows the text of the source locale.

The build writes the messages that it found to `.vitehub/i18n/manifest.json`, by Vite environment. Each message has its runtime ID as its key and the Diglot `hash` of its record. Do not commit it.

## Inspect i18n

The CLI shows the locales and their coverage without a server:

```bash [Terminal]
pnpm vitehub inspect definitions --kind i18n
pnpm vitehub inspect provider-output
```

`inspect definitions` lists each locale with its records folder and its counts of messages, translations, missing translations, and unused records. `inspect provider-output` lists `.vitehub/i18n/messages.mjs`, the compiled translations that the server loads, and `.vitehub/i18n/manifest.json`, the messages of the last build.
