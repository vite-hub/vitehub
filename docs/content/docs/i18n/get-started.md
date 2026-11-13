---
title: Translate your first page
description: Write a Vue page and a server route in English, collect the messages, translate them to Spanish, and get one locale for each request.
layout: tutorial
codePanel: true
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

Write a page and a server route in English. Then translate them to Spanish. A request with `Accept-Language: es` gets Spanish, and a request in English gets English, from the same server at the same time.

You write no message keys. You write the English text, and ViteHub makes the keys for you.

Start with the app from the **Vite with Nitro** path in [Installation](/docs/getting-started/installation). Run the commands from the app root. You need no provider account. i18n needs Nitro 3. For Nuxt 5, read [Use i18n in Nuxt 5](/docs/i18n/configure#use-i18n-in-nuxt-5).

Add the i18n package, Vue, and the Vue plugin for Vite:

```bash [commands/install-i18n]
pnpm add @vite-hub/i18n vue
pnpm add -D @vitejs/plugin-vue
```

::tutorial-step{title="Enable i18n"}
## Enable i18n

Add `i18n` to the ViteHub options. In a Vite app, also add the Vue plugin. Keep your other plugins and options.

:::tabs{sync="framework"}
::::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ["vite-hub/nuxt"],
  vitehub: { host: "node", i18n: { locales: ["en", "es"] } },
})
```
::::

::::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import vue from "@vitejs/plugin-vue"
import { nitro } from "nitro/vite"
import { defineConfig } from "vite"
import { vitehub } from "vite-hub"

export default defineConfig({
  server: { port: 3000, strictPort: true },
  plugins: [
    vue(),
    vitehub({ host: "node", i18n: { locales: ["en", "es"] } }),
    nitro(),
  ],
})
```
::::

::::tabs-item{label="Vite"}
```ts [vite.config.ts]
import vue from "@vitejs/plugin-vue"
import { defineConfig } from "vite"
import { vitehub } from "vite-hub"

export default defineConfig({
  server: { port: 3000, strictPort: true },
  plugins: [
    vue(),
    vitehub({ host: "node", i18n: { locales: ["en", "es"] } }),
  ],
})
```
::::
:::

The first locale is the **source locale**. It is the language that you write in the code. Here it is English. Every other locale is a translation.

::

::tutorial-step{title="Write the page in English"}
## Write the page in English

Create the page at the root of your app:

```html [index.html]
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Agents</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

`createI18n()` picks the locale of the browser, loads its translations, and returns a Vue plugin:

```ts [src/main.ts]
import { createApp } from "vue"
import { createI18n } from "vite-hub/i18n/vue"
import App from "./App.vue"

createApp(App).use(await createI18n()).mount("#app")
```

Create `src/App.vue`. Write each message in English inside ``t`...` ``. Use `<Trans>` for a message that has markup in it. Both work in templates with no import.

```vue [src/App.vue]
<script setup lang="ts">
import { useLocale } from "vite-hub/i18n/vue"

const { locale, setLocale } = useLocale()
</script>

<template>
  <h1>{{ t`Deploy your agent` }}</h1>
  <p><Trans>Read the <a href="/docs">docs</a> first.</Trans></p>
  <button @click="setLocale(locale === 'en' ? 'es' : 'en')">{{ locale }}</button>
</template>
```

The button switches between English and Spanish. `useLocale()` gives the active locale and `setLocale()`.

::

::tutorial-step{title="Write a server route"}
## Write a server route

Create `server/api/greeting.ts`. In server code, import `t` and `plural` from `vite-hub/i18n`.

```ts [server/api/greeting.ts]
import { defineEventHandler, getQuery } from "h3"
import { getLocale, plural, t } from "vite-hub/i18n"

export default defineEventHandler((event) => {
  const count = Number(getQuery(event).count ?? 1)
  return {
    locale: getLocale(),
    message: t`Payment received`,
    items: plural(count, { one: "# item", other: "# items" }),
  }
})
```

You do not pass the event to `t`. Each request has its own locale, and `t` reads the locale of the request that runs it. In `plural()`, `#` is the number.

::

::tutorial-step{title="See what is missing"}
## See what is missing

Run the status command. It reads the messages in your code and compares them with the translations of each locale.

```bash [commands/status]
pnpm vitehub i18n status
```

```text [output/status.txt]
en           4 messages  source
es           4 messages  0% translated, 4 missing  locales/es
```

The command found four messages: two in the page and two in the route. The English text is the source, so `en` needs no translations. The `<Trans>` message is `Read the <0>docs</0> first.`. The `<0>` tag stands for the link, so a translator cannot break its `href`.

::

::tutorial-step{title="Translate to Spanish"}
## Translate to Spanish

Export the Spanish messages as a [PO file](https://www.gnu.org/software/gettext/manual/html_node/PO-Files.html), the format of translation tools such as Poedit:

```bash [commands/export]
pnpm vitehub i18n export es --output es.po
```

Each entry has the English text in `msgid` and an empty translation in `msgstr`. Fill in three of the four translations. Leave the `<Trans>` message empty, to see what happens to a message without a translation.

```diff [es.po]
 msgid "Deploy your agent"
-msgstr ""
+msgstr "Despliega tu agente"

 msgid "Payment received"
-msgstr ""
+msgstr "Pago recibido"

 msgid "{count, plural, one {# item} other {# items}}"
-msgstr ""
+msgstr "{count, plural, one {# artículo} other {# artículos}}"
```

Import the file:

```bash [commands/import]
pnpm vitehub i18n import es es.po
```

```text [output/import.txt]
Saved 3 translations to locales/es. 0 were already saved.
```

`locales/es/segments/` now has one JSON record for each translation. Commit the `locales/` folder. You can delete `es.po`. Check the coverage again:

```bash [commands/status-after]
pnpm vitehub i18n status
```

```text [output/status-after.txt]
en           4 messages  source
es           4 messages  75% translated, 1 missing  locales/es
```

::

::tutorial-step{title="Build and send requests"}
## Build and send requests

Build the app and start the server:

```bash [commands/build]
pnpm build
pnpm start
```

In a second terminal, ask for Spanish:

```bash [commands/request-es]
curl -H 'accept-language: es-MX,es;q=0.9,en;q=0.5' 'http://localhost:3000/api/greeting?count=2'
```

```json [output/greeting-es.json]
{
  "locale": "es",
  "message": "Pago recibido",
  "items": "2 artículos"
}
```

`es-MX` is not a configured locale, so the server takes the same language: `es`. Now send the same request with a `locale` cookie. The cookie wins over `Accept-Language`:

```bash [commands/request-cookie]
curl -H 'accept-language: es' -H 'cookie: locale=en' 'http://localhost:3000/api/greeting?count=2'
```

```json [output/greeting-en.json]
{
  "locale": "en",
  "message": "Payment received",
  "items": "2 items"
}
```

::

::tutorial-step{title="Switch the language in the page"}
## Switch the language in the page

Open `http://localhost:3000`. With an English browser, the page shows the English text and a button with `en`.

Click the button. The page changes to Spanish without a reload:

```text [output/page-es.txt]
Despliega tu agente
Read the docs first.
es
```

The second line stays in English, because it has no Spanish translation. A message without a translation shows the source text.

Reload the page. It stays in Spanish. `setLocale()` saved `es` in the `locale` cookie, and the cookie wins over the browser languages.

::

## What you built

You wrote English text in a page and in a server route, with no keys. One command collected the messages, and you translated them in one file. The server picked a locale for each request, and the page changed its locale in the browser.

The build changed each message to a short ID. The app code that ships to the browser has no English text, and the Spanish translations are in their own chunk.

- Read [Configure](/docs/i18n/configure) to add more locales, use Nuxt 5, and write plurals and placeholders.
- Read [Server API](/docs/i18n/server-api) for `getLocale()`, `setLocale()`, `msg`, and `translate()`.
- Read [Limits and errors](/docs/i18n/limits-and-errors) before you ship.
